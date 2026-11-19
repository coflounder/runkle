// runkle's own MCP server: the same operations as the web UI, for agents.
//
// No tool here accepts a secret. Anything an agent is given passes through the
// model's context, so tokens, client secrets and script secrets can only be
// entered in the web UI.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { UpstreamError, type Env } from "./cloudflare.ts";
import { InputError, serverBody } from "./mapping.ts";
import * as ops from "./ops.ts";

const SCRIPT_FORMAT = `A script is one JavaScript module. Every export is optional:

export const tools = {
  tool_name: {
    description: "What it does",
    input: { type: "object", properties: { days: { type: "number" } } }, // JSON Schema
    output: { type: "object", properties: { any: { type: "string" } } }, // optional JSON Schema of what run returns
    annotations: { readOnlyHint: true }, // optional MCP tool annotations, passed through as-is
    async run(input, env, ctx) { return { any: "JSON" }; },
  },
};
export const skills = { name: { description: "When to use it", content: "Markdown instructions for agents" } };
export const schedules = { nightly: { cron: "0 6 * * *", async run(env, ctx) {} } }; // UTC
export const webhooks = { name: async (request, env, ctx) => "ok" }; // public: verify the sender's signature
export const pages = { name: async (request, env, ctx) => "<h1>HTML</h1>" }; // behind Cloudflare Access
export const workflows = { name: async (step, input, env, ctx) => step.do("first", async () => 1) }; // Cloudflare Workflows steps
export const probe = async (env, ctx) => {}; // a cheap read that throws when the script's secrets or upstream do not work; run by check_integrations and runkle's daily check

env holds the script's secrets. ctx.storage has get(key), put(key, value), delete(key) and list(prefix), all async and durable.
ctx.workflows has start(name, input), which returns an id, and status(id).
ctx.origin is the script's own address inside tools, webhooks and pages: a page is at ctx.origin + "/pages/<name>".
A tool that returns a plain object also returns it as structuredContent. Arguments input.properties does not name are refused unless input sets additionalProperties: true.
A tool can require the user's approval: add approval: true, or approval: async (input, env, ctx) => "one line saying what will happen" (return nothing to let that call run unasked).
A call that needs approval returns { waiting_for_approval: link } instead of running; the user approves in their runkle inbox and the same call, repeated with the same arguments, then runs once.
It runs as a Cloudflare Worker: fetch and Web APIs are available, npm imports are not.`;

const USING_THE_PORTAL = `Using this portal: tools of runkle apps (scripts and HTTP APIs) return JSON objects as structuredContent beside the text, so read that instead of parsing the text, and they refuse argument names their input schema does not list. When retrying a write on a server that takes a request or idempotency id, reuse the same id so the write is not done twice. A long write may answer that it is queued: check its status instead of calling it again. For the user's integrations, prefer this portal's tools over other connectors that reach the same service.`;

// Returned by every tool that adds an integration.
const NEXT_STEPS =
  "A new integration's tools reach agents only after the user reconnects this portal's connector in their MCP client (in claude.ai, under Settings > Connectors) and starts a fresh session. Growing an existing integration in place with update_api_source or update_script avoids that.";

function createServer(env: Env, ui: string) {
  const server = new McpServer(
    { name: "runkle", version: "1.0.0" },
    {
      instructions: `Manage the integrations served by this runkle portal. Never ask the user for a password, token or API key and never put one in a script: declare what the script reads from \`env\`, then use generate_secret when the value is one you could make up (a shared token, a signing key), or give the user the link from request_credentials so they can enter values only they have. For an MCP server that needs an access token or its own OAuth client, give them the link from request_mcp_server_setup.\n\n${USING_THE_PORTAL}\n\n${SCRIPT_FORMAT}`,
    },
  );

  // Run an operation and report failures to the agent as tool errors.
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify((await fn()) ?? { ok: true }) }] };
    } catch (error) {
      if (error instanceof InputError || error instanceof UpstreamError)
        return { isError: true, content: [{ type: "text" as const, text: error.message }] };
      throw error;
    }
  };
  const added = (fn: () => Promise<object>) => run(async () => ({ ...(await fn()), next_steps: NEXT_STEPS }));
  const id = z.string().describe("Integration id from list_integrations");
  const collection = z.string().describe("Collection id from list_integrations");
  const inCollection = collection.optional().describe("A collection id from list_integrations, to change only that collection. Without it, the change is to the portal that serves every integration.");

  server.registerTool(
    "list_integrations",
    {
      description:
        "List every integration with its status and tools, plus the portal endpoint, the collections (each a separate endpoint serving some of the integrations, with the tools it blocks) and agent sign-in settings.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => ops.state(env, "agent")),
  );
  server.registerTool(
    "check_integrations",
    {
      description:
        "Check whether each integration works before you rely on it. Per integration: status ok, upstream_error, needs_sign_in, missing_secret, expiring (a secret expires within 14 days or has expired) or unused_secret, and each problem with a one-line reason and what to do. Apps are asked to run their own probe if their script exports one. Each person's own sign-ins are not visible to runkle. Changes nothing.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => ops.checkIntegrations(env)),
  );
  server.registerTool(
    "set_secret_expiry",
    {
      description: "Record the day a script's or API's secret stops working, so runkle warns the user 14 days before. A date only, never a value; entering a new value for the secret clears it. list_integrations shows the dates as secret_expiry.",
      inputSchema: { id, name: z.string().describe("Secret name as in secrets_set"), expires: z.string().nullable().describe("YYYY-MM-DD, or null to forget the date") },
      annotations: { idempotentHint: true },
    },
    ({ id, ...input }) => run(() => ops.setExpiry(env, id, input)),
  );
  server.registerTool(
    "add_mcp_server",
    {
      description: "Register a remote MCP server by URL. Use auth \"oauth\" when the server needs each user to sign in; servers that need an access token must be added in the web UI.",
      inputSchema: { name: z.string(), url: z.string().describe("https:// URL of the MCP endpoint"), auth: z.enum(["none", "oauth"]) },
    },
    (input) => added(() => ops.registerServer(env, serverBody(input))),
  );
  server.registerTool(
    "upload_script",
    {
      description: `Deploy a script as a new integration. Returns its id and what it exports, with the URLs of its webhooks and pages. Secrets it reads from env must then be set by the user at ${ui}.\n\n${SCRIPT_FORMAT}`,
      inputSchema: { name: z.string(), source: z.string().describe("The module source"), ask_first: z.array(z.string()).optional().describe("Tools that must wait for the user's approval each time they are called; * matches anything, e.g. [\"delete_*\"]. Only the user can change this list afterwards.") },
    },
    ({ name, source, ask_first }) => added(() => ops.newApp(env, ui, { name, source, ask_first })),
  );
  server.registerTool(
    "update_script",
    {
      description: "Replace the source of an uploaded script. Its secrets and stored data are kept. If the script holds secrets and the code changed, the change is not deployed: it waits until the user approves it in their runkle inbox, and review_status says when they have. Unchanged code is redeployed at once.",
      inputSchema: { id, source: z.string() },
    },
    ({ id, source }) => run(() => ops.proposeChange(env, ui, id, source)),
  );
  server.registerTool(
    "review_status",
    {
      description: "Whether a change you proposed to a script with secrets (update_script, update_api_source) is still waiting for the user, and what they decided last. Read only: there is no tool to approve a change.",
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => ops.reviewStatus(env, id)),
  );
  const sourceInput = {
    kind: z.enum(["openapi", "discovery", "graphql"]),
    url: z.string().describe("https:// URL of the OpenAPI or Discovery document (JSON or YAML), or of the GraphQL endpoint"),
    base_url: z.string().optional().describe("Overrides the base URL the document declares"),
    filter: z.string().optional().describe("Keep only operations whose name or path contains this text. Needed for very large APIs."),
    auth: z.enum(["none", "bearer", "header", "query"]),
    auth_name: z.string().optional().describe("Header or query parameter name, for auth header or query"),
    secret_headers: z.record(z.string(), z.string()).optional().describe("For APIs that need more than one credential: header name -> name of the secret that fills it, e.g. {\"x-api-key\": \"API_KEY\"}. Names only; the user sets the values through request_credentials."),
    read_only: z.boolean().optional().describe("Import only GET operations, plus any named in operations"),
    operations: z.array(z.string()).optional().describe("Operations to import by name whatever filter and read_only say, e.g. the few writes a read-only import needs"),
    redact: z.array(z.string()).optional().describe("Response fields whose values are replaced with [redacted] at any depth, e.g. [\"env\", \"password\"], so secrets the API returns never reach the agent"),
  };
  server.registerTool(
    "add_api_source",
    {
      description: `Turn an HTTP API into an integration: one tool per operation for OpenAPI 3 and Google Discovery documents, or query and schema tools for a GraphQL endpoint. If the API needs a credential, say how it is sent with auth; the user then sets the API_TOKEN secret for it at ${ui}. Every user shares that one credential.`,
      inputSchema: {
        name: z.string(),
        ...sourceInput,
        ask_first: z.array(z.string()).optional().describe("Tools that must wait for the user's approval each time they are called; * matches anything, e.g. [\"delete_*\"]. Only the user can change this list afterwards."),
      },
    },
    (input) => added(() => ops.newSource(env, ui, input)),
  );
  server.registerTool(
    "update_api_source",
    {
      description: "Regenerate an HTTP API integration in place with new settings, such as more operations or fields to redact. Its id, secrets and portal registration are kept. If it holds secrets the change is not deployed: it waits until the user approves it at the link this returns. Call sync_integration once it is live.",
      inputSchema: { id, ...sourceInput },
    },
    ({ id, ...input }) => run(() => ops.proposeSource(env, ui, id, input)),
  );
  const skills = z.array(z.object({ name: z.string().describe("lowercase-with-dashes"), description: z.string().describe("When an agent should read it"), content: z.string().describe("Markdown instructions") }));
  server.registerTool(
    "add_skills",
    { description: "Publish a pack of skills (written instructions for agents) as a new integration. Agents read them through its skills tool.", inputSchema: { name: z.string(), skills } },
    (input) => added(() => ops.newSkills(env, ui, input)),
  );
  server.registerTool(
    "update_skills",
    { description: "Replace every skill in a skill pack.", inputSchema: { id, skills } },
    ({ id, skills }) => run(() => ops.changeApp(env, ui, id, { skills })),
  );
  server.registerTool(
    "request_credentials",
    {
      description: "Get a link where the user enters secret values for a script or HTTP API (an API's key is the secret API_TOKEN). You never see the values. Hand the link to the user.",
      inputSchema: { id, names: z.array(z.string()).describe("Secret names, UPPER_SNAKE_CASE") },
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => ops.credentialLink(env, ui, input)),
  );
  server.registerTool(
    "generate_secret",
    {
      description:
        "Make a new random credential and set it where it is used, without anyone seeing or pasting it: as secrets on scripts or HTTP APIs, and/or as the bearer token the portal sends to a remote MCP server. Optionally keep a copy in 1Password through a 1Password integration (scripts/onepassword.js), so the user can give the same value to the other side. The value is never returned. The first call waits until the user approves in their runkle inbox and returns a link; call again with exactly the same arguments to run it, once.",
      inputSchema: {
        targets: z
          .array(z.union([z.object({ app: id, secret: z.string().describe("Secret name, UPPER_SNAKE_CASE") }), z.object({ server: id.describe("A remote MCP server that signs in with a bearer token") })]))
          .describe("Where the same value goes, 1 to 10 places"),
        length: z.number().int().optional().describe("16 to 128 characters, default 40"),
        alphabet: z.enum(["alphanumeric", "hex", "base64url"]).optional().describe("Default alphanumeric"),
        copy_to: z
          .object({ app: id.describe("The integration that keeps copies, e.g. 1Password"), vault: z.string(), item: z.string().describe("Item title; created if missing"), field: z.string().describe("Field label; replaced if present, the old value stays in the item's history") })
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    (input) => run(() => ops.generateSecret(env, ui, input)),
  );
  server.registerTool(
    "request_mcp_server_setup",
    {
      description: "Get a link where the user finishes adding an MCP server that needs an access token (auth bearer) or their own OAuth client (auth oauth_manual). Hand the link to the user.",
      inputSchema: { name: z.string(), url: z.string().describe("https:// URL of the MCP endpoint"), auth: z.enum(["bearer", "oauth_manual"]) },
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => ops.serverLink(env, ui, input)),
  );
  server.registerTool(
    "remove_integration",
    { description: "Remove an integration. An uploaded script is deleted along with its secrets.", inputSchema: { id }, annotations: { destructiveHint: true } },
    ({ id }) => run(() => ops.removeIntegration(env, id)),
  );
  server.registerTool(
    "sync_integration",
    { description: "Re-fetch an integration's tool list.", inputSchema: { id } },
    ({ id }) => run(() => ops.syncServer(env, id)),
  );
  server.registerTool(
    "set_tool_enabled",
    { description: "Allow or block one tool of an integration for agents using the portal, or one collection.", inputSchema: { id, tool: z.string(), enabled: z.boolean(), collection: inCollection } },
    ({ id, ...input }) => run(() => ops.toggleTool(env, id, input)),
  );
  server.registerTool(
    "set_agent_sign_in",
    {
      description: "Set which MCP clients may register and sign in to the portal. Replaces the current settings.",
      inputSchema: { enabled: z.boolean(), allow_localhost: z.boolean(), allow_loopback: z.boolean(), allowed_uris: z.array(z.string()).describe("Allowed OAuth redirect URIs") },
    },
    (input) => run(() => ops.setAgentAuth(env, input)),
  );
  server.registerTool(
    "set_code_mode",
    { description: "Set the code mode policy of the portal, or of one collection.", inputSchema: { code_mode: z.enum(["off", "opt_in", "default_on", "enforced"]), collection: inCollection } },
    (input) => run(() => ops.setCodeMode(env, input)),
  );
  server.registerTool(
    "create_collection",
    {
      description:
        "Make a collection: its own MCP endpoint that serves only the integrations you name, such as Personal or Work, so an agent connected to it sees nothing else. runkle sets up the hostname, its DNS record and its sign-in. Integrations join with the tool settings they have in the main portal. Every integration stays in the main portal too.",
      inputSchema: { name: z.string().describe("e.g. Personal"), integrations: z.array(id).optional() },
    },
    (input) => run(() => ops.createCollection(env, input)),
  );
  server.registerTool(
    "set_collection_integrations",
    {
      description: "Add integrations to a collection or take them out. Added ones join with the tool settings they have in the main portal. Agents connected to the collection see the change in a fresh session.",
      inputSchema: { collection, add: z.array(id).optional(), remove: z.array(id).optional() },
      annotations: { idempotentHint: true },
    },
    ({ collection, ...input }) => run(() => ops.setCollection(env, collection, input)),
  );
  server.registerTool(
    "delete_collection",
    {
      description: "Delete a collection's endpoint, with its DNS record and sign-in. Its integrations keep working in the main portal and any other collection. Agents connected to it lose access.",
      inputSchema: { collection },
      annotations: { destructiveHint: true },
    },
    ({ collection }) => run(() => ops.deleteCollection(env, collection)),
  );

  return server;
}

export const serveMcp = (request: Request, env: Env, ctx: ExecutionContext) =>
  createMcpHandler(() => createServer(env, new URL(request.url).origin), { route: "/mcp" })(request, env, ctx);
