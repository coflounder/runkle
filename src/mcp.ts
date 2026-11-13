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
    async run(input, env, ctx) { return { any: "JSON" }; },
  },
};
export const skills = { name: { description: "When to use it", content: "Markdown instructions for agents" } };
export const schedules = { nightly: { cron: "0 6 * * *", async run(env, ctx) {} } }; // UTC
export const webhooks = { name: async (request, env, ctx) => "ok" }; // public: verify the sender's signature
export const pages = { name: async (request, env, ctx) => "<h1>HTML</h1>" }; // behind Cloudflare Access
export const workflows = { name: async (step, input, env, ctx) => step.do("first", async () => 1) }; // Cloudflare Workflows steps

env holds the script's secrets. ctx.storage has get(key), put(key, value), delete(key) and list(prefix), all async and durable.
ctx.workflows has start(name, input), which returns an id, and status(id).
It runs as a Cloudflare Worker: fetch and Web APIs are available, npm imports are not.`;

function createServer(env: Env, ui: string) {
  const server = new McpServer(
    { name: "runkle", version: "1.0.0" },
    {
      instructions: `Manage the integrations served by this runkle portal. Never ask the user for a password, token or API key and never put one in a script: declare what the script reads from \`env\`, then give the user the link from request_credentials so they can enter the values themselves. For an MCP server that needs an access token or its own OAuth client, give them the link from request_mcp_server_setup.\n\n${SCRIPT_FORMAT}`,
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
  const id = z.string().describe("Integration id from list_integrations");

  server.registerTool(
    "list_integrations",
    { description: "List every integration with its status and tools, plus the portal endpoint and agent sign-in settings.", annotations: { readOnlyHint: true } },
    () => run(() => ops.state(env, "agent")),
  );
  server.registerTool(
    "add_mcp_server",
    {
      description: "Register a remote MCP server by URL. Use auth \"oauth\" when the server needs each user to sign in; servers that need an access token must be added in the web UI.",
      inputSchema: { name: z.string(), url: z.string().describe("https:// URL of the MCP endpoint"), auth: z.enum(["none", "oauth"]) },
    },
    (input) => run(() => ops.registerServer(env, serverBody(input))),
  );
  server.registerTool(
    "upload_script",
    {
      description: `Deploy a script as a new integration. Returns its id and what it exports, with the URLs of its webhooks and pages. Secrets it reads from env must then be set by the user at ${ui}.\n\n${SCRIPT_FORMAT}`,
      inputSchema: { name: z.string(), source: z.string().describe("The module source") },
    },
    ({ name, source }) => run(() => ops.newApp(env, { name, source })),
  );
  server.registerTool(
    "update_script",
    { description: "Replace the source of an uploaded script. Its secrets and stored data are kept.", inputSchema: { id, source: z.string() } },
    ({ id, source }) => run(() => ops.changeApp(env, id, { source })),
  );
  server.registerTool(
    "add_api_source",
    {
      description: `Turn an HTTP API into an integration: one tool per operation for OpenAPI 3 and Google Discovery documents, or query and schema tools for a GraphQL endpoint. If the API needs a credential, say how it is sent with auth; the user then sets the API_TOKEN secret for it at ${ui}. Every user shares that one credential.`,
      inputSchema: {
        name: z.string(),
        kind: z.enum(["openapi", "discovery", "graphql"]),
        url: z.string().describe("https:// URL of the OpenAPI or Discovery document (JSON or YAML), or of the GraphQL endpoint"),
        base_url: z.string().optional().describe("Overrides the base URL the document declares"),
        filter: z.string().optional().describe("Keep only operations whose name or path contains this text. Needed for very large APIs."),
        auth: z.enum(["none", "bearer", "header", "query"]),
        auth_name: z.string().optional().describe("Header or query parameter name, for auth header or query"),
      },
    },
    (input) => run(() => ops.newSource(env, input)),
  );
  const skills = z.array(z.object({ name: z.string().describe("lowercase-with-dashes"), description: z.string().describe("When an agent should read it"), content: z.string().describe("Markdown instructions") }));
  server.registerTool(
    "add_skills",
    { description: "Publish a pack of skills (written instructions for agents) as a new integration. Agents read them through its skills tool.", inputSchema: { name: z.string(), skills } },
    (input) => run(() => ops.newSkills(env, input)),
  );
  server.registerTool(
    "update_skills",
    { description: "Replace every skill in a skill pack.", inputSchema: { id, skills } },
    ({ id, skills }) => run(() => ops.changeApp(env, id, { skills })),
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
    "request_mcp_server_setup",
    {
      description: "Get a link where the user finishes adding an MCP server that needs an access token (auth bearer) or their own OAuth client (auth oauth_manual). Hand the link to the user.",
      inputSchema: { name: z.string(), url: z.string().describe("https:// URL of the MCP endpoint"), auth: z.enum(["bearer", "oauth_manual"]) },
      annotations: { readOnlyHint: true },
    },
    (input) => run(async () => ops.serverLink(ui, input)),
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
    { description: "Allow or block one tool of an integration for agents using the portal.", inputSchema: { id, tool: z.string(), enabled: z.boolean() } },
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
    { description: "Set the portal's code mode policy.", inputSchema: { code_mode: z.enum(["off", "opt_in", "default_on", "enforced"]) } },
    (input) => run(() => ops.setCodeMode(env, input)),
  );

  return server;
}

export const serveMcp = (request: Request, env: Env, ctx: ExecutionContext) =>
  createMcpHandler(() => createServer(env, new URL(request.url).origin), { route: "/mcp" })(request, env, ctx);
