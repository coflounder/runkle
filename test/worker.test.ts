import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Env } from "../src/cloudflare.ts";
import worker from "../src/index.ts";
import { serverBody, setTool, slug, toMapping } from "../src/mapping.ts";
import { fakeCloudflare, latest } from "./fake-cloudflare.ts";

const env: Env = {
  CLOUDFLARE_API_TOKEN: "test-token",
  ACCOUNT_ID: "acct",
  PORTAL_ID: "main",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  AUTH_DISABLED: "true",
  // The inbox of whichever fake the running test made.
  get INBOX() {
    return latest!.inbox;
  },
};

const origin = "https://runkle.test";
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Origin: origin }) =>
  worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {} as ExecutionContext);

test("toMapping keeps portal overrides and drops server-level ones", () => {
  const mapping = toMapping([
    {
      id: "a",
      on_behalf: true,
      updated_tools: [
        { name: "kept", portal_enabled: false, portal_alias: "k" },
        { name: "server-only", portal_enabled: null },
      ],
    },
  ]);
  assert.deepEqual(mapping, [
    { server_id: "a", on_behalf: true, default_disabled: false, updated_tools: [{ name: "kept", enabled: false, alias: "k" }], updated_prompts: [] },
  ]);
  assert.deepEqual(setTool(mapping, "a", "kept", true)[0].updated_tools, [{ name: "kept", alias: "k", enabled: true }]);
  assert.throws(() => setTool(mapping, "nope", "kept", true));
});

test("serverBody validates and shapes each auth method", () => {
  assert.equal(slug("  My_Linear Server!! "), "my-linear-server");
  assert.throws(() => serverBody({ name: "x", url: "http://insecure.example", auth: "none" }), /https/);
  assert.throws(() => serverBody({ name: "x", url: "https://a.example", auth: "bearer" }), /Token/);
  const manual = serverBody({
    name: "GitHub",
    url: "https://gh.example/mcp",
    auth: "oauth_manual",
    client_id: "cid",
    client_secret: "shh",
    authorization_endpoint: "https://gh.example/authorize",
    token_endpoint: "https://gh.example/token",
  }) as any;
  assert.equal(manual.client_secret, "shh");
  assert.equal(JSON.parse(manual.auth_credentials).registration_info.client_id, "cid");
  assert.ok(!manual.auth_credentials.includes("shh"), "secret stays out of auth_credentials");
});

test("add, toggle, and remove integrations without disturbing the others", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const state = async () => (await (await call("GET", "/api/state")).json()) as any;

  assert.equal((await call("POST", "/api/integrations", { name: "Docs", url: "https://docs.example/mcp", auth: "none" })).status, 200);
  assert.equal((await call("POST", "/api/integrations", { name: "Linear", url: "https://linear.example/mcp", auth: "oauth" })).status, 200);
  assert.equal((await call("PUT", "/api/integrations/docs/tools", { tool: "delete_record", enabled: false })).status, 200);

  let s = await state();
  assert.deepEqual(s.integrations.map((i: any) => i.id), ["docs", "linear"]);
  assert.deepEqual(s.integrations[0].tools.map((x: any) => x.enabled), [true, false]);
  assert.equal(fake.portal.servers[1].on_behalf, true, "OAuth integrations use each user's own sign-in");
  assert.deepEqual([...fake.apps.values()].find((a) => a.type === "mcp").policies, [{ id: "pol-1", precedence: 1 }]);

  // Adding a third must not reset the toggle or detach anything.
  await call("POST", "/api/integrations", { name: "Third", url: "https://third.example/mcp", auth: "bearer", token: "t" });
  s = await state();
  assert.equal(s.integrations.length, 3);
  assert.equal(s.integrations[0].tools[1].enabled, false);

  // A failed add leaves nothing behind.
  const failed = await call("POST", "/api/integrations", { name: "Down", url: "https://down.example.com/mcp", auth: "none" });
  assert.equal(failed.status, 502);
  assert.ok(!fake.servers.has("down"));

  assert.equal((await call("DELETE", "/api/integrations/linear")).status, 200);
  s = await state();
  assert.deepEqual(s.integrations.map((i: any) => i.id), ["docs", "third"]);
  assert.equal(fake.apps.size, 3, "portal app plus one per remaining integration");

  await call("PUT", "/api/agent-auth", { enabled: true, allow_localhost: true, allowed_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  assert.deepEqual((await state()).agentAuth, {
    enabled: true,
    allow_localhost: true,
    allow_loopback: false,
    allowed_uris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  assert.equal(fake.apps.get("portal-app").policies.length, 1, "existing Access settings survive the update");
});

test("collections: runkle makes the portal, DNS and sign-in, fills it, scopes tools and takes it all down", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const state = async () => (await (await call("GET", "/api/state")).json()) as any;
  fake.apps.get("portal-app").oauth_configuration = { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true } };
  fake.apps.get("portal-app").session_duration = "24h";
  for (const name of ["Notes", "Garmin", "Linear"]) await call("POST", "/api/integrations", { name, url: `https://${name.toLowerCase()}.example/mcp`, auth: "none" });
  await call("PUT", "/api/integrations/garmin/tools", { tool: "delete_record", enabled: false });

  const made = (await (await call("POST", "/api/collections", { name: "Personal", integrations: ["notes", "garmin"] })).json()) as any;
  assert.equal(made.endpoint, "https://mcp-personal.example.com/mcp", "one label under the main portal's domain");
  const portal = fake.portals.get("runkle-personal");
  assert.deepEqual(portal.servers.map((m: any) => m.server_id), ["notes", "garmin"]);
  assert.deepEqual(portal.servers[1].updated_tools, [{ name: "delete_record", enabled: false }], "joins with the main portal's tool settings");
  assert.equal(portal.code_mode, "opt_in");
  const record = [...fake.dns.values()].find((r) => r.name === "mcp-personal.example.com");
  assert.deepEqual([record.type, record.content, record.proxied], ["CNAME", "portal.gateway.test", true], "points where the main portal does");
  const gate = [...fake.apps.values()].find((a) => a.type === "mcp_portal" && a.domain === "mcp-personal.example.com");
  assert.deepEqual(gate.policies, [{ id: "pol-1", precedence: 1 }]);
  assert.equal(gate.oauth_configuration.dynamic_client_registration.allow_any_on_localhost, true, "agents sign in as they do to the main portal");
  assert.equal(gate.session_duration, "24h");

  let s = await state();
  assert.deepEqual(s.collections, [
    {
      id: "personal",
      name: "Personal",
      endpoint: "https://mcp-personal.example.com/mcp",
      code_mode: "opt_in",
      integrations: [
        { id: "notes", blocked_tools: [] },
        { id: "garmin", blocked_tools: ["delete_record"] },
      ],
    },
  ]);
  assert.deepEqual(s.integrations.map((i: any) => i.collections), [["personal"], ["personal"], []]);

  // Tools and code mode change in the collection alone.
  await call("PUT", "/api/integrations/notes/tools", { tool: "search", enabled: false, collection: "personal" });
  await call("PUT", "/api/portal", { code_mode: "enforced", collection: "personal" });
  s = await state();
  assert.deepEqual(s.collections[0].integrations[0].blocked_tools, ["search"]);
  assert.equal(s.integrations[0].tools[0].enabled, true, "the main portal keeps the tool");
  assert.deepEqual([s.collections[0].code_mode, s.portal.code_mode], ["enforced", "opt_in"]);

  // Membership: add keeps everyone else's settings, remove takes one out.
  assert.equal((await call("PUT", "/api/collections/personal", { add: ["linear"], remove: ["garmin"] })).status, 200);
  assert.deepEqual(fake.portals.get("runkle-personal").servers.map((m: any) => [m.server_id, m.updated_tools.length]), [["notes", 1], ["linear", 0]]);
  assert.equal((await call("PUT", "/api/collections/personal", { add: ["nope"] })).status, 400);
  assert.equal((await call("POST", "/api/collections", { name: "personal" })).status, 400, "one collection per name");
  assert.equal((await call("POST", "/api/collections", { name: "Work", integrations: ["nope"] })).status, 400);
  assert.ok(!fake.portals.has("runkle-work"), "a refused collection makes nothing");

  // Removing an integration takes it out of every collection first.
  await call("DELETE", "/api/integrations/linear");
  assert.deepEqual(fake.portals.get("runkle-personal").servers.map((m: any) => m.server_id), ["notes"]);

  // A collection that fails halfway leaves nothing behind.
  const before = { dns: fake.dns.size, apps: fake.apps.size };
  fake.portals.set("other", { id: "other", name: "Hand-made", hostname: "mcp-work.example.com", servers: [] });
  assert.equal((await call("POST", "/api/collections", { name: "Work" })).status, 502);
  assert.deepEqual([fake.dns.size, fake.apps.size, fake.portals.has("runkle-work")], [before.dns, before.apps, false]);

  // runkle deletes only collections it made, never the main portal or another one.
  assert.equal((await call("DELETE", "/api/collections/main")).status, 400);
  assert.equal((await call("DELETE", "/api/collections/other")).status, 400);
  assert.equal((await call("DELETE", "/api/collections/personal")).status, 200);
  assert.ok(!fake.portals.has("runkle-personal") && fake.portals.has("main") && fake.portals.has("other"));
  assert.ok(![...fake.dns.values()].some((r) => r.name === "mcp-personal.example.com"));
  assert.ok(![...fake.apps.values()].some((a) => a.domain === "mcp-personal.example.com"));
  assert.ok(fake.servers.has("notes"), "integrations outlive the collection");
});

test("refuses unauthenticated and cross-origin requests", async () => {
  const locked = { ...env, AUTH_DISABLED: undefined };
  assert.equal((await worker.fetch(new Request(origin + "/api/state"), locked, {} as ExecutionContext)).status, 401);
  assert.equal((await call("POST", "/api/integrations", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/integrations", {}, {})).status, 403);
});

const SCRIPT = `export const tools = {
  whoami: {
    description: "Report the configured user",
    async run(input, env) {
      return { user: env.GARMIN_USER, greeting: input.greeting, sawPortalToken: Object.keys(env).some((k) => k.startsWith("RUNKLE_")) };
    },
  },
};`;

test("upload a script: deployed, secured, callable, updatable, removable", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));

  const made = await call("POST", "/api/apps", { name: "Garmin", source: SCRIPT, secrets: { GARMIN_USER: "jay", GARMIN_PASSWORD: "hunter2" } });
  assert.equal(((await made.json()) as any).id, "garmin");
  assert.equal(made.headers.get("Cache-Control"), "no-store");

  const deployed = fake.scripts.get("runkle-app-garmin")!;
  const token = deployed.secrets.RUNKLE_TOKEN;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fake.credentials.get("garmin"), token, "the portal holds the same token as the script");
  assert.equal(fake.servers.get("garmin").hostname, "https://runkle-app-garmin.acme.workers.dev/mcp");
  assert.deepEqual(deployed.flags, ["global_fetch_strictly_public"], "an app can fetch other Workers on its workers.dev subdomain");

  // Nothing secret ever comes back out of runkle.
  const stateText = await (await call("GET", "/api/state")).text();
  assert.ok(JSON.parse(stateText).integrations[0].is_app);
  for (const secret of ["hunter2", token]) assert.ok(!stateText.includes(secret));

  // Run exactly what was uploaded, as Cloudflare would.
  const app = await fake.app("runkle-app-garmin");
  const rpc = async (auth: string, method: string, params?: unknown) =>
    app.worker.fetch(
      new Request("https://app.test/mcp", { method: "POST", headers: { Authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
      app.env,
    );
  assert.equal((await rpc("Bearer wrong", "tools/list")).status, 401);
  assert.equal((await rpc("", "tools/list")).status, 401);
  assert.equal((await (await rpc(`Bearer ${token}`, "tools/list")).json()).result.tools[0].name, "whoami");
  const result = (await (await rpc(`Bearer ${token}`, "tools/call", { name: "whoami", arguments: { greeting: "hi" } })).json()).result;
  assert.deepEqual(JSON.parse(result.content[0].text), { user: "jay", greeting: "hi", sawPortalToken: false });
  assert.ok((await (await rpc(`Bearer ${token}`, "tools/call", { name: "constructor" })).json()).error, "only declared tools are callable");

  // Rotate one secret, then replace the source: every other secret survives both.
  assert.equal((await call("PUT", "/api/apps/garmin", { secrets: { GARMIN_PASSWORD: "new" } })).status, 200);
  assert.equal((await call("PUT", "/api/apps/garmin", { source: SCRIPT + "// v2" })).status, 200);
  const { RUNKLE_SETUP, ...kept } = fake.scripts.get("runkle-app-garmin")!.secrets;
  assert.deepEqual(kept, { GARMIN_USER: "jay", GARMIN_PASSWORD: "new", RUNKLE_TOKEN: token });
  assert.ok(fake.scripts.get("runkle-app-garmin")!.modules["app.js"].endsWith("// v2"));

  // Guard rails.
  await call("POST", "/api/integrations", { name: "Docs", url: "https://docs.example/mcp", auth: "none" });
  assert.equal((await call("PUT", "/api/apps/docs", { source: SCRIPT })).status, 400, "cannot upload over a non-script integration");
  assert.equal((await call("POST", "/api/apps", { name: "X", source: SCRIPT, secrets: { RUNKLE_TOKEN: "mine" } })).status, 400);
  assert.equal((await call("POST", "/api/apps", { name: "X", source: SCRIPT, secrets: { "bad name": "v" } })).status, 400);
  assert.equal((await call("POST", "/api/apps", { name: "Garmin", source: SCRIPT })).status, 400, "duplicate");
  assert.ok(fake.scripts.get("runkle-app-garmin"), "a refused duplicate leaves the original alone");

  assert.equal((await call("DELETE", "/api/integrations/garmin")).status, 200);
  assert.equal(fake.scripts.size, 0);
});

test("the MCP endpoint refuses browsers on other sites", async () => {
  assert.equal((await call("POST", "/mcp", {}, { Origin: "https://evil.example" })).status, 403);
});

// Call an uploaded app's MCP endpoint the way the portal does.
async function rpc(fake: ReturnType<typeof fakeCloudflare>, script: string, method: string, params?: unknown) {
  const app = await fake.app(script);
  const request = new Request(`https://${script}.acme.workers.dev/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${app.env.RUNKLE_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await (await app.worker.fetch(request, app.env)).json()) as any).result;
}
const callTool = async (fake: ReturnType<typeof fakeCloudflare>, script: string, name: string, args?: unknown) => {
  const result = await rpc(fake, script, "tools/call", { name, arguments: args });
  return { text: result.content[0].text as string, isError: Boolean(result.isError) };
};

const RICH = `export const tools = {
  count: { async run(input, env, ctx) { const n = ((await ctx.storage.get("n")) || 0) + 1; await ctx.storage.put("n", n); return n; } },
  kick: { async run(input, env, ctx) { return (await ctx.workflows.status(await ctx.workflows.start("double", 21))).output; } },
};
export const skills = { triage: { description: "How to triage", content: "# Triage" } };
export const schedules = { nightly: { cron: "0 6 * * *", async run(env, ctx) { await ctx.storage.put("ran", env.KEY); } } };
export const webhooks = { ping: async (request) => ({ got: await request.text() }) };
export const pages = { home: async (request, env, ctx) => "<h1>" + (await ctx.storage.get("ran")) + "</h1>" + ctx.origin };
export const workflows = { double: (step, input) => step.do("x2", async () => input * 2) };`;

test("an app's storage, skills, schedules, webhooks, pages and workflows", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const host = "https://runkle-app-rich.acme.workers.dev";

  const made = (await (await call("POST", "/api/apps", { name: "Rich", source: RICH, secrets: { KEY: "k" } })).json()) as any;
  assert.deepEqual(made, {
    id: "rich",
    tools: ["count", "kick", "skills"],
    skills: ["triage"],
    schedules: { nightly: "0 6 * * *" },
    webhooks: [`${host}/webhooks/ping`],
    pages: [`${host}/pages/home`],
    workflows: ["double"],
    approvals: [],
  });
  const script = () => fake.scripts.get("runkle-app-rich")!;
  assert.deepEqual(script().schedules, [{ cron: "0 6 * * *" }]);
  assert.deepEqual(fake.workflows.get("runkle-app-rich"), { class_name: "Flow", script_name: "runkle-app-rich" });
  const [open, gate] = [...fake.apps.values()].filter((a) => a.type === "self_hosted");
  assert.deepEqual(open.destinations.map((d: any) => d.uri), ["mcp", "webhooks", "manifest", "vault"].map((area) => `runkle-app-rich.acme.workers.dev/${area}`));
  assert.equal(open.policies[0].decision, "bypass");
  assert.equal(gate.domain, "runkle-app-rich.acme.workers.dev");
  assert.deepEqual(gate.policies, [{ id: "pol-1", precedence: 1 }], "pages get the portal's Access policies");
  assert.equal(script().secrets.RUNKLE_PAGES_AUD, gate.aud);

  assert.equal((await callTool(fake, "runkle-app-rich", "count")).text, "1");
  assert.equal((await callTool(fake, "runkle-app-rich", "count")).text, "2", "storage persists between calls");
  assert.equal((await callTool(fake, "runkle-app-rich", "kick")).text, "42", "a tool can start a workflow");
  assert.equal((await callTool(fake, "runkle-app-rich", "skills", { name: "triage" })).text, "# Triage");
  assert.match((await rpc(fake, "runkle-app-rich", "tools/list")).tools[2].description, /triage \(How to triage\)/);

  const { worker, env: appEnv } = await fake.app("runkle-app-rich");
  await worker.scheduled({ cron: "0 6 * * *" }, appEnv);
  const page = (access?: unknown) => worker.fetch(new Request(`${host}/pages/home`), appEnv, { access });
  assert.equal((await page()).status, 403, "pages are closed without Cloudflare Access");
  assert.equal((await page({ aud: "someone-else" })).status, 403);
  const shown = await page({ aud: gate.aud });
  assert.equal(await shown.text(), "<h1>k</h1>" + host, "the schedule ran with the app's secret and wrote to storage; the page knows its own address");
  assert.match(shown.headers.get("Content-Type")!, /text\/html/);
  const hook = await worker.fetch(new Request(`${host}/webhooks/ping`, { method: "POST", body: "hi" }), appEnv, {});
  assert.deepEqual(await hook.json(), { got: "hi" }, "webhooks need no token");
  assert.equal((await worker.fetch(new Request(`${host}/manifest`), appEnv, {})).status, 401);
  assert.equal((await worker.fetch(new Request(`${host}/webhooks/nope`), appEnv, {})).status, 404);

  // A new version without schedules stops the cron and keeps the data.
  const next = `export const tools = { count: { async run(i, env, ctx) { return (await ctx.storage.list("n")).n; } } };`;
  assert.equal((await call("PUT", "/api/apps/rich", { source: next })).status, 200);
  assert.deepEqual(script().schedules, []);
  assert.equal((await callTool(fake, "runkle-app-rich", "count")).text, "2");

  assert.equal((await call("DELETE", "/api/integrations/rich")).status, 200);
  assert.equal(fake.workflows.size + fake.scripts.size, 0);
  assert.deepEqual([...fake.apps.keys()], ["portal-app"], "its Access apps go with it");
});

const OPENAPI = `openapi: 3.0.0
servers: [{ url: https://api.example.com/v1 }]
paths:
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, schema: { type: string } }
    get:
      operationId: getPet
      summary: Get a pet
      parameters:
        - { $ref: '#/components/parameters/Fields' }
  /pets:
    post:
      operationId: createPet
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
components:
  parameters:
    Fields: { name: fields, in: query, schema: { type: array, items: { type: string } } }
  schemas:
    Pet: { type: object, properties: { name: { type: string }, parent: { $ref: '#/components/schemas/Pet' } } }
`;
const DISCOVERY = JSON.stringify({
  rootUrl: "https://api.example.com/",
  servicePath: "drive/v3/",
  schemas: { File: { type: "object", properties: { name: { type: "string" } } } },
  resources: { files: { methods: { update: { id: "drive.files.update", httpMethod: "PATCH", path: "files/{+fileId}", parameters: { fileId: { location: "path", required: true, type: "string" } }, request: { $ref: "File" } } } } },
});

test("OpenAPI, Google Discovery and GraphQL sources become tools", async (t) => {
  const fake = fakeCloudflare();
  const sent: Request[] = [];
  t.mock.method(globalThis, "fetch", (input: any, init: any) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== "api.example.com") return fake.handle(request);
    sent.push(request);
    return Response.json({ ok: true });
  });

  const made = await call("POST", "/api/sources", { name: "Pets", kind: "openapi", spec: OPENAPI, auth: "header", auth_name: "X-Api-Key", token: "k123" });
  assert.deepEqual(((await made.json()) as any).tools, ["getPet", "createPet"]);
  assert.equal(fake.scripts.get("runkle-app-pets")!.secrets.API_TOKEN, "k123");
  assert.ok(!fake.scripts.get("runkle-app-pets")!.modules["app.js"].includes("k123"), "the credential is a secret, not source");
  const [getPet, createPet] = (await rpc(fake, "runkle-app-pets", "tools/list")).tools;
  assert.equal(getPet.description, "Get a pet");
  assert.deepEqual(getPet.inputSchema.required, ["petId"]);
  assert.deepEqual(createPet.inputSchema.properties.body.properties.parent, {}, "a self-referencing schema is cut off, not expanded forever");

  await callTool(fake, "runkle-app-pets", "getPet", { petId: "a/b", fields: ["x", "y"] });
  assert.equal(sent[0].url, "https://api.example.com/v1/pets/a%2Fb?fields=x&fields=y");
  assert.equal(sent[0].headers.get("X-Api-Key"), "k123");
  await callTool(fake, "runkle-app-pets", "createPet", { body: { name: "Rex" } });
  assert.equal(sent[1].method, "POST");
  assert.deepEqual(await sent[1].json(), { name: "Rex" });

  await call("POST", "/api/sources", { name: "Drive", kind: "discovery", spec: DISCOVERY, auth: "query", auth_name: "key", token: "g" });
  await callTool(fake, "runkle-app-drive", "drive_files_update", { fileId: "a/b", body: { name: "n" } });
  assert.equal(sent[2].url, "https://api.example.com/drive/v3/files/a/b?key=g");
  assert.equal(sent[2].method, "PATCH");

  const wide = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(20) }]));
  const big = JSON.stringify({ openapi: "3.0.0", servers: [{ url: "https://api.example.com" }], paths: { "/big": { post: { operationId: "big", requestBody: { content: { "application/json": { schema: { type: "object", properties: wide } } } } } } } });
  await call("POST", "/api/sources", { name: "Big", kind: "openapi", spec: big, auth: "none" });
  assert.ok(!(await rpc(fake, "runkle-app-big", "tools/list")).tools[0].inputSchema.properties.body.properties, "an oversized body schema is left open");

  // An API that needs several credentials names a secret per header; read_only keeps only the GETs.
  const multi = await call("POST", "/api/sources", { name: "Multi", kind: "openapi", spec: OPENAPI, auth: "none", read_only: true, secret_headers: { "x-api-key": "API_KEY", "cf-access-client-id": "CLIENT_ID" } });
  assert.deepEqual(((await multi.json()) as any).tools, ["getPet"]);
  assert.match((await callTool(fake, "runkle-app-multi", "getPet", { petId: "1" })).text, /API_KEY secret/);
  await call("PUT", "/api/apps/multi", { secrets: { API_KEY: "k", CLIENT_ID: "c" } });
  await callTool(fake, "runkle-app-multi", "getPet", { petId: "1" });
  assert.deepEqual([sent[3].headers.get("x-api-key"), sent[3].headers.get("cf-access-client-id")], ["k", "c"]);

  // A read-only import can still carry the writes named in operations, and redact hides fields the API returns.
  const deploys = await call("POST", "/api/sources", { name: "Deploys", kind: "openapi", spec: OPENAPI, auth: "none", read_only: true, operations: ["createPet"], redact: ["OK"] });
  assert.deepEqual(((await deploys.json()) as any).tools, ["getPet", "createPet"]);
  assert.equal((await callTool(fake, "runkle-app-deploys", "createPet", { body: { name: "Rex" } })).text, '{"ok":"[redacted]"}');
  assert.equal(sent.length, 5);
  sent.pop();
  assert.equal((await call("POST", "/api/sources", { name: "A", kind: "openapi", spec: OPENAPI, auth: "none", operations: ["nope"] })).status, 400);

  // Added by an agent, so no credential yet: calls say what is missing instead of going out unauthenticated.
  await call("POST", "/api/sources", { name: "Graph", kind: "graphql", url: "https://api.example.com/graphql", auth: "bearer" });
  assert.deepEqual((await rpc(fake, "runkle-app-graph", "tools/list")).tools.map((x: any) => x.name), ["query", "schema"]);
  const refused = await callTool(fake, "runkle-app-graph", "query", { query: "{ me }" });
  assert.ok(refused.isError && /API_TOKEN/.test(refused.text));
  assert.equal(sent.length, 4);
  await call("PUT", "/api/apps/graph", { secrets: { API_TOKEN: "t" } });
  await callTool(fake, "runkle-app-graph", "query", { query: "{ me }" });
  assert.equal(sent[4].headers.get("Authorization"), "Bearer t");
  assert.deepEqual(await sent[4].json(), { query: "{ me }" });

  for (const bad of [
    { name: "A", kind: "openapi", spec: "title: nope", auth: "none" },
    { name: "A", kind: "openapi", spec: OPENAPI, auth: "header" },
    { name: "A", kind: "openapi", spec: OPENAPI, auth: "none", secret_headers: { "x-api-key": "RUNKLE_TOKEN" } },
    { name: "A", kind: "openapi", spec: OPENAPI, auth: "none", filter: "nothing-matches" },
    { name: "A", kind: "openapi", spec: OPENAPI, auth: "none", base_url: "http://insecure.example" },
    { name: "A", kind: "graphql", url: "http://insecure.example", auth: "none" },
  ])
    assert.equal((await call("POST", "/api/sources", bad)).status, 400, JSON.stringify(bad).slice(0, 60));
});

test("skill packs are served through a skills tool", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const skills = ["---\nname: triage\ndescription: When triaging\n---\n# Steps", { name: "deploy", description: "Shipping", content: "Go." }];

  assert.equal((await call("POST", "/api/skills", { name: "Playbooks", skills })).status, 200);
  const [tool] = (await rpc(fake, "runkle-app-playbooks", "tools/list")).tools;
  assert.match(tool.description, /triage \(When triaging\); deploy \(Shipping\)/);
  assert.equal((await callTool(fake, "runkle-app-playbooks", "skills", { name: "triage" })).text, "# Steps");
  assert.ok((await callTool(fake, "runkle-app-playbooks", "skills", { name: "constructor" })).isError);

  assert.equal((await call("PUT", "/api/apps/playbooks", { skills: [{ name: "deploy", content: "Carefully." }] })).status, 200);
  assert.equal((await callTool(fake, "runkle-app-playbooks", "skills", { name: "deploy" })).text, "Carefully.");
  assert.equal((await call("POST", "/api/skills", { name: "Bad", skills: [{ name: "Has Spaces", content: "x" }] })).status, 400);
  assert.equal((await call("POST", "/api/skills", { name: "Bad", skills: [] })).status, 400);
});

test("credential links name what to enter and carry no secret", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const { credentialLink, serverLink } = await import("../src/ops.ts");
  await call("POST", "/api/apps", { name: "Garmin", source: SCRIPT });
  await call("POST", "/api/integrations", { name: "Docs", url: "https://docs.example/mcp", auth: "none" });

  const link = await credentialLink(env, origin, { id: "garmin", names: ["GARMIN_USER", "GARMIN_PASSWORD"] });
  assert.equal(link.url, "https://runkle.test/#secrets=garmin&names=GARMIN_USER%2CGARMIN_PASSWORD");
  await assert.rejects(credentialLink(env, origin, { id: "garmin", names: ["RUNKLE_TOKEN"] }), /reserved/);
  await assert.rejects(credentialLink(env, origin, { id: "garmin", names: ["bad name"] }));
  await assert.rejects(credentialLink(env, origin, { id: "docs", names: ["X"] }), /No script/);
  assert.equal((await serverLink(env, origin, { name: "Gh", url: "https://gh.example/mcp", auth: "bearer" })).url, "https://runkle.test/#add=1&name=Gh&url=https%3A%2F%2Fgh.example%2Fmcp&auth=bearer");
  await assert.rejects(serverLink(env, origin, { name: "Gh", url: "http://gh.example", auth: "bearer" }), /https/);

  // Both wait in the inbox until the person has done them. (Sorted: two items opened in the same millisecond have no order.)
  const waiting = async () => ((await (await call("GET", "/api/inbox")).json()) as any).waiting.map((i: any) => [i.id, i.kind, i.link]).sort();
  assert.deepEqual(await waiting(), [
    ["secrets:garmin", "secrets", link.url],
    ["setup:gh", "setup", "https://runkle.test/#add=1&name=Gh&url=https%3A%2F%2Fgh.example%2Fmcp&auth=bearer"],
  ]);
  await call("POST", "/api/integrations", { name: "Gh", url: "https://gh.example/mcp", auth: "none" });

  // The agent can watch for the names, and only the names, to appear.
  const garmin = async () => ((await (await call("GET", "/api/state")).json()) as any).integrations[0];
  assert.deepEqual((await garmin()).secrets_set, []);
  await call("PUT", "/api/apps/garmin", { secrets: { GARMIN_USER: "jay" } });
  const text = JSON.stringify(await garmin());
  assert.deepEqual(JSON.parse(text).secrets_set, ["GARMIN_USER"]);
  assert.ok(!text.includes("jay"));
  assert.deepEqual(await waiting(), [], "entering secrets and adding the server settle them");
  assert.ok(!JSON.stringify(fake.inboxData).includes("jay"), "the inbox never sees a secret");
});

test("an agent's change to a script that holds secrets waits for a person", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const { proposeChange } = await import("../src/ops.ts");
  const live = () => fake.scripts.get("runkle-app-bare")!.modules["app.js"];
  const bare = async () => ((await (await call("GET", "/api/state")).json()) as any).integrations[0];
  const decide = (version: string, approve: boolean) => call("POST", "/api/apps/bare/proposal", { version, approve });
  await call("POST", "/api/apps", { name: "Bare", source: SCRIPT });

  // Without secrets there is nothing to protect: deployed at once.
  assert.equal(((await proposeChange(env, origin, "bare", SCRIPT + "// v2")) as any).id, "bare");
  assert.ok(live().endsWith("// v2"));

  await call("PUT", "/api/apps/bare", { secrets: { KEY: "s3cret" } });
  // The same code as the running code needs no review, even with secrets.
  assert.equal(((await proposeChange(env, origin, "bare", SCRIPT + "// v2")) as any).reviewed, "not needed: the code is unchanged");
  const held: any = await proposeChange(env, origin, "bare", SCRIPT + "// leak");
  assert.equal(held.waiting_for_review, "https://runkle.test/#review=bare");
  const inbox = async () => (await (await call("GET", "/api/inbox")).json()) as any;
  assert.deepEqual((await inbox()).waiting.map((i: any) => [i.id, i.link]), [["review:bare", "https://runkle.test/#review=bare"]], "the person finds it in the inbox");
  assert.equal((await call("POST", "/api/inbox/review:bare", { approve: true })).status, 400, "a review is decided on the diff, not from the list");
  const status = async () => (await import("../src/ops.ts")).reviewStatus(env, "bare");
  assert.deepEqual(await status(), { pending: true });
  assert.ok(live().endsWith("// v2"), "the approved code keeps serving");
  assert.equal((await bare()).pending_review, true);
  const blocked = await call("PUT", "/api/apps/bare", { secrets: { KEY: "other" } });
  assert.equal(blocked.status, 400);
  assert.match(((await blocked.json()) as any).error, /waiting for review/);

  const seen: any = await (await call("GET", "/api/apps/bare/proposal")).json();
  assert.ok(seen.current.endsWith("// v2") && seen.proposed.endsWith("// leak"));

  // A proposal made after the person read the first one cannot use their approval.
  await proposeChange(env, origin, "bare", SCRIPT + "// leak2");
  assert.equal((await decide(seen.version, true)).status, 400);
  assert.ok(live().endsWith("// v2"));

  const newest: any = await (await call("GET", "/api/apps/bare/proposal")).json();
  assert.equal((await decide(newest.version, false)).status, 200);
  assert.ok(live().endsWith("// v2"), "rejected");
  assert.equal((await bare()).pending_review, undefined);
  const told: any = await status();
  assert.deepEqual([told.pending, told.last_decision.decision, told.last_decision.by], [false, "denied", "dev@localhost"], "the agent can see the decision");
  assert.deepEqual((await inbox()).waiting, []);
  assert.equal((await inbox()).decided[0].decision, "denied");
  assert.equal((await call("GET", "/api/apps/bare/proposal")).status, 400);

  await proposeChange(env, origin, "bare", SCRIPT + "// v3");
  const third: any = await (await call("GET", "/api/apps/bare/proposal")).json();
  assert.equal((await decide(third.version, true)).status, 200);
  assert.ok(live().endsWith("// v3"));
  assert.equal(fake.scripts.get("runkle-app-bare")!.secrets.KEY, "s3cret");
  assert.deepEqual(fake.scripts.get("runkle-app-bare")!.messages.slice(-2), ["Rejected by dev@localhost in runkle", "Approved by dev@localhost in runkle"], "decisions are kept in the version history");
});

const GATED = `export const tools = {
  read: { run: () => "read" },
  keys: { run: async (i, env, ctx) => Object.keys(await ctx.storage.list()) },
  wipe: { run: (i, env) => "wiped " + i.what + " with " + env.KEY },
  pay: { approval: (i) => i.amount > 10 && "Pay " + i.amount, run: (i) => "paid " + i.amount },
};`;

// A browser's push subscription: real keys, so the payload can be encrypted for it.
async function browser(endpoint: string) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
  return { endpoint, keys: { p256dh: b64(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } };
}

test("a tool that asks first runs once, and only after a person approves in the inbox", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const host = "https://runkle-app-gated.acme.workers.dev";
  const inbox = async () => (await (await call("GET", "/api/inbox")).json()) as any;
  const decide = (id: string, approve: boolean, from = origin) => call("POST", `/api/inbox/${id}`, { approve }, { Origin: from });

  // A phone subscribes; a second one has since unsubscribed at its push service.
  assert.match((await inbox()).publicKey, /^[A-Za-z0-9_-]{87}$/, "runkle makes its own push key");
  assert.equal((await call("POST", "/api/push", { subscription: await browser("https://fcm.push.test/phone") })).status, 200);
  assert.equal((await call("POST", "/api/push", { subscription: await browser("https://gone.push.test/old") })).status, 200);
  assert.equal((await call("POST", "/api/push", { subscription: { endpoint: "http://insecure.test" } })).status, 400);

  const made: any = await (await call("POST", "/api/apps", { name: "Gated", source: GATED, secrets: { KEY: "k" }, ask_first: ["wi*"] })).json();
  assert.deepEqual(made.approvals, ["wipe", "pay"], "one from the person's list, one from the script");
  assert.equal((await call("POST", "/api/apps", { name: "Bad", source: GATED, ask_first: ["no spaces"] })).status, 400);
  assert.ok(![...fake.apps.values()].some((a) => a.domain === "runkle-app-gated.acme.workers.dev"), "no pages, so no Access app on the script");
  const listed = ((await (await call("GET", "/api/state")).json()) as any).integrations[0];
  assert.deepEqual([listed.ask_first, listed.secrets_set], [["wi*"], ["KEY"]]);
  const described = Object.fromEntries((await rpc(fake, "runkle-app-gated", "tools/list")).tools.map((x: any) => [x.name, /approval/.test(x.description)]));
  assert.deepEqual(described, { read: false, keys: false, wipe: true, pay: true });

  const tool = async (name: string, args?: unknown) => {
    const { text, isError } = await callTool(fake, "runkle-app-gated", name, args);
    return isError ? { error: text } : text.startsWith("{") ? JSON.parse(text) : text;
  };

  assert.equal(await tool("read"), "read", "other tools run as before");
  const asked = await tool("wipe", { what: "db", n: 1 });
  assert.match(asked.waiting_for_approval, /^https:\/\/runkle\.test\/#inbox=[0-9a-f]{32}$/);
  assert.match(asked.next, /They have been notified/);
  const id = new URLSearchParams(new URL(asked.waiting_for_approval).hash.slice(1)).get("inbox")!;
  assert.deepEqual(fake.pushes.map((p) => [new URL(p.endpoint).hostname, p.bytes > 4000, /^vapid t=/.test(p.vapid ?? "")]), [["fcm.push.test", true, true], ["gone.push.test", true, true]]);
  assert.equal((await tool("wipe", { n: 1, what: "db" })).waiting_for_approval, asked.waiting_for_approval, "asking again does not start over");
  assert.equal(fake.pushes.length, 2, "or notify again");
  assert.equal(await tool("keys"), "[]", "the script's own storage cannot see or forge approvals");

  const waiting = (await inbox()).waiting;
  assert.deepEqual(waiting.map((i: any) => [i.id, i.kind, i.app, i.tool, i.input]), [[id, "approval", "gated", "wipe", { what: "db", n: 1 }]], "the person sees exactly what would run");
  assert.equal((await decide(id, true, "https://evil.test")).status, 403, "another site cannot decide");
  assert.ok((await tool("wipe", { what: "db", n: 1 })).waiting_for_approval);
  assert.equal((await decide(id, true)).status, 200);
  assert.equal((await decide(id, false)).status, 400, "one decision per request");

  assert.ok((await tool("wipe", { what: "everything", n: 1 })).waiting_for_approval, "the approval covers those arguments only");
  assert.equal(await tool("wipe", { what: "db", n: 1 }), "wiped db with k");
  assert.ok((await tool("wipe", { what: "db", n: 1 })).waiting_for_approval, "and one call only");

  // A browser that unsubscribed is forgotten; the phone still hears.
  fake.pushes.length = 0;
  assert.equal(await tool("pay", { amount: 5 }), "paid 5", "a script decides per call");
  const pay = await tool("pay", { amount: 50 });
  assert.deepEqual(fake.pushes.map((p) => new URL(p.endpoint).hostname), ["fcm.push.test"]);
  const payId = new URLSearchParams(new URL(pay.waiting_for_approval).hash.slice(1)).get("inbox")!;
  assert.equal((await inbox()).waiting.find((i: any) => i.id === payId).title, "Pay 50", "and says what the person is agreeing to");
  assert.equal((await decide(payId, false)).status, 200);
  assert.match((await tool("pay", { amount: 50 })).error, /Denied by dev@localhost/);

  const { decided } = await inbox();
  assert.deepEqual(decided.map((d: any) => [d.decision, d.by, d.tool]), [["denied", "dev@localhost", "pay"], ["approved", "dev@localhost", "wipe"]]);

  // Unanswered requests and unused approvals lapse.
  const later = Date.now() + 2 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => later);
  assert.ok(!(await inbox()).waiting.some((i: any) => i.id === id));
  assert.equal((await tool("pay", { amount: 50 })).waiting_for_approval, pay.waiting_for_approval, "asked afresh");

  // Only the person changes the list; the secret and the script stay as they were.
  assert.equal((await call("PUT", "/api/apps/gated", { ask_first: [] })).status, 200);
  assert.equal(await tool("wipe", { what: "db", n: 1 }), "wiped db with k");
  void host;
});

test("the inbox notifies, lists and sets aside what waits", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const sub = await browser("https://fcm.push.test/a");
  await call("POST", "/api/push", { subscription: sub });
  assert.deepEqual(await (await call("POST", "/api/push/test")).json(), { notified: 1 });
  assert.deepEqual(await (await call("DELETE", "/api/push", { endpoint: sub.endpoint })).json(), { unsubscribed: true });
  assert.deepEqual(await (await call("POST", "/api/push/test")).json(), { notified: 0 });
  assert.equal((await call("POST", "/api/inbox/nothing-here", { approve: true })).status, 400);
  assert.equal((await call("GET", "/api/inbox", undefined, {})).status, 200, "reading needs no Origin");
  assert.equal((await call("POST", "/api/push/test", undefined, {})).status, 403, "writing does");
  assert.ok(!Object.keys(Object.fromEntries(fake.inboxData)).some((k) => k.startsWith("push:") && JSON.stringify(fake.inboxData.get(k)).includes("unsubscribed")));
});

// ---- Ready-made scripts in scripts/ ----

// Uploads one and returns ways to call its tools, approve a waiting call and open its pages as a signed-in person.
async function readyMade(fake: ReturnType<typeof fakeCloudflare>, file: string, name: string, secrets: Record<string, string>) {
  const made: any = await (await call("POST", "/api/apps", { name, source: readFileSync(`${import.meta.dirname}/../scripts/${file}`, "utf8"), secrets })).json();
  const script = `runkle-app-${made.id}`, host = `https://${script}.acme.workers.dev`;
  const aud = [...fake.apps.values()].find((a) => a.domain === new URL(host).host)?.aud;
  const app = await fake.app(script);
  const tool = async (tool: string, args?: unknown) => {
    const { text, isError } = await callTool(fake, script, tool, args);
    return isError ? { error: text } : /^[[{]/.test(text) ? JSON.parse(text) : text;
  };
  const page = (path: string, form?: Record<string, string>) =>
    app.worker.fetch(new Request(host + path, form ? { method: "POST", headers: { Origin: host, "Cf-Access-Authenticated-User-Email": "me@example.com" }, body: new URLSearchParams(form) } : {}), app.env, { access: { aud } });
  // Calls a tool that must ask, checks what the person is shown in the inbox, approves, and calls again.
  const approved = async (name: string, args: unknown, shown: RegExp) => {
    const asked = await tool(name, args);
    assert.ok(asked.waiting_for_approval, `${name} asks first: ${JSON.stringify(asked)}`);
    const id = new URLSearchParams(new URL(asked.waiting_for_approval).hash.slice(1)).get("inbox")!;
    const item = ((await (await call("GET", "/api/inbox")).json()) as any).waiting.find((i: any) => i.id === id);
    assert.match(item.title + "\n" + JSON.stringify(item.input), shown);
    await call("POST", `/api/inbox/${id}`, { approve: true });
    return tool(name, args);
  };
  return { made, tool, page, approved };
}

test("Cloudflare Tokens: every mint is approved first and no tool returns a value", async (t) => {
  const fake = fakeCloudflare();
  const groups = [["DNS Read", ".zone"], ["DNS Write", ".zone"], ["Workers Scripts Read", ""], ["Workers Scripts Write", ""], ["Account API Tokens Write", ""], ["Billing Read", ""]]
    .map(([name, zone], i) => ({ id: "g" + i, name, scopes: ["com.cloudflare.api.account" + zone] }));
  const tokens = new Map<string, any>(), calls: any[] = [];
  // The minter's own view of Cloudflare: token endpoints, and the secret it delivers with a courier token.
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const request = new Request(input, init), path = new URL(request.url).pathname.replace(/^.*\/accounts\/acct/, ""), auth = request.headers.get("Authorization");
    if (new URL(request.url).hostname !== "api.cloudflare.com" || auth === "Bearer test-token") return fake.handle(request);
    const body = request.body ? await request.json() : undefined;
    calls.push({ method: request.method, path, body, auth });
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (path === "/tokens/permission_groups") return ok(groups);
    if (request.method === "POST" && path === "/tokens") {
      const made = { id: "t" + (tokens.size + 1), value: "cfat_SECRET" + tokens.size, status: "active", ...(body as any) };
      return tokens.set(made.id, made), ok(made);
    }
    if (request.method === "DELETE") return tokens.delete(path.split("/")[2]), ok({});
    if (path === "/tokens") return ok([...tokens.values(), { id: "x", name: "someone else's" }]);
    if (path.startsWith("/tokens/")) return ok(tokens.get(path.split("/")[2]) ?? { name: "someone else's" });
    if (path.endsWith("/secrets")) return path.includes("broken") ? Response.json({ success: false, errors: [{ message: "no such Worker" }] }, { status: 404 }) : ok({});
    throw new Error("unexpected " + path);
  });
  const { made, tool, page, approved } = await readyMade(fake, "cloudflare-tokens.js", "Cloudflare Tokens", { MINTER_TOKEN: "minter", ACCOUNT_ID: "acct" });
  assert.deepEqual(made.approvals, ["request"]);
  const ask = (o: object) => ({ purpose: "ci deploy", minutes: 60, ...o });
  const leaks = (v: unknown) => JSON.stringify(v).includes("cfat_");

  // The rules are checked before anyone is asked.
  assert.match((await tool("request", ask({ permissions: ["Account API Tokens Write"] }))).error, /never/);
  assert.match((await tool("request", ask({ permissions: ["Billing Read"] }))).error, /never/);
  assert.match((await tool("request", ask({ permissions: ["Nope"] }))).error, /Unknown/);
  assert.match((await tool("request", ask({ permissions: ["DNS Read"], minutes: 200000 }))).error, /minutes/);
  assert.match((await tool("request", ask({ permissions: ["DNS Read"], worker: "w" }))).error, /both/);
  assert.deepEqual(await tool("permissions", { search: "s" }), ["DNS Read", "DNS Write", "Workers Scripts Read", "Workers Scripts Write"]);

  // Short-lived and read-only waits too. Approved, it goes to the Worker with a courier token that is then deleted.
  const toWorker = ask({ permissions: ["DNS Read", "Workers Scripts Read"], worker: "runkle-app-x", secret: "CF" });
  assert.ok((await tool("request", toWorker)).waiting_for_approval);
  assert.equal(tokens.size, 0, "nothing is minted before approval");
  const sent = await approved("request", toWorker, /ci deploy.*60 minutes.*DNS Read \(every zone\), Workers Scripts Read.*secret CF on Worker runkle-app-x/s);
  assert.equal(sent.done.to, "runkle-app-x secret CF");
  assert.ok(!leaks(sent));
  const put = calls.find((c) => c.path.endsWith("/secrets"));
  assert.deepEqual([put.body.text, put.auth], ["cfat_SECRET0", "Bearer cfat_SECRET1"]);
  assert.deepEqual([...tokens.keys()], ["t1"], "the courier is gone");
  const minted = calls.find((c) => c.method === "POST" && c.path === "/tokens").body;
  assert.equal(minted.name, "runkle: ci deploy");
  assert.deepEqual(minted.policies.map((p: any) => [Object.values(p.resources)[0], p.permission_groups]), [["*", [{ id: "g2" }]], [{ "com.cloudflare.api.account.zone.*": "*" }, [{ id: "g0" }]]]);

  // Undeliverable: the new token is deleted, not left unowned.
  assert.match((await approved("request", ask({ permissions: ["DNS Read"], worker: "runkle-app-broken", secret: "CF" }), /broken/)).error, /no such Worker/);
  assert.equal(tokens.size, 1);

  // With no Worker to go to, only the person sees it, once, on a page of the script.
  const shown = await approved("request", ask({ permissions: ["DNS Write"], minutes: 1440 }), /24 hours.*your browser, shown once/s);
  assert.ok(!leaks(shown) && tokens.size === 1, "still not minted");
  const path = shown.show_to_user.replace(/^https:\/\/[^/]+/, "");
  assert.match(await (await page(path)).text(), /Mint and show/);
  assert.match(await (await page(path, {})).text(), /cfat_SECRET/);
  assert.equal((await page(path, {})).status, 404, "once");

  const listed = await tool("list");
  assert.deepEqual([listed.tokens.length, listed.log.length], [2, 2]);
  assert.ok(!leaks(listed) && !leaks([...fake.scripts.get("runkle-app-cloudflare-tokens")!.data]), "no value is stored or listed");
  assert.match((await tool("revoke", { id: "x" })).error, /Not a token minted here/);
  assert.deepEqual(await tool("revoke", { id: "t1" }), { revoked: "t1" });
});

test("an agent regenerates an API source in place, held for review when it has secrets", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const { proposeSource } = await import("../src/ops.ts");
  const live = () => fake.scripts.get("runkle-app-pets")!.modules["app.js"];
  await call("POST", "/api/sources", { name: "Pets", kind: "openapi", spec: OPENAPI, auth: "none", read_only: true, secret_headers: { "x-api-key": "API_KEY" } });
  await call("PUT", "/api/apps/pets", { secrets: { API_KEY: "k" } });

  const held: any = await proposeSource(env, origin, "pets", { kind: "openapi", spec: OPENAPI, auth: "none", read_only: true, operations: ["createPet"], secret_headers: { "x-api-key": "API_KEY" } });
  assert.equal(held.waiting_for_review, "https://runkle.test/#review=pets");
  assert.ok(!live().includes("createPet"), "the approved import keeps serving");
  const seen: any = await (await call("GET", "/api/apps/pets/proposal")).json();
  assert.ok(seen.proposed.includes("createPet"));
  assert.equal((await call("POST", "/api/apps/pets/proposal", { version: seen.version, approve: true })).status, 200);
  assert.ok(live().includes("createPet"));
  assert.equal(fake.scripts.get("runkle-app-pets")!.secrets.API_KEY, "k");
});

test("generated tools say what they do and whether they are safe to call", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => {
    const request = new Request(input, init);
    return new URL(request.url).host === "api.example.com" ? Response.json({ id: 7, env: "SECRET=1" }) : fake.handle(request);
  });
  const spec = JSON.stringify({
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/compose.one": { get: { operationId: "compose-one", summary: "  ", description: "Get one compose" } },
      "/compose.redeploy": { post: { operationId: "compose-redeploy", parameters: [{ name: "composeId", in: "query", schema: { type: "string" } }] } },
      "/compose.replace": { put: { operationId: "compose-replace", summary: "x".repeat(400) } },
      "/compose.remove": { delete: { operationId: "compose-remove" } },
    },
  });
  await call("POST", "/api/sources", { name: "Dokploy", kind: "openapi", spec, auth: "none", redact: ["env"] });
  const tools = Object.fromEntries((await rpc(fake, "runkle-app-dokploy", "tools/list")).tools.map((x: any) => [x.name, x]));
  assert.equal(tools["compose-one"].description, "Get one compose", "a blank summary falls back to the description");
  assert.equal(tools["compose-redeploy"].description, "POST /compose.redeploy", "an undocumented operation names its method and path");
  assert.equal(tools["compose-replace"].description.length, 300);
  assert.equal(tools["compose-remove"].description, "DELETE /compose.remove");
  assert.deepEqual(tools["compose-one"].annotations, { readOnlyHint: true, idempotentHint: true });
  assert.deepEqual(tools["compose-redeploy"].annotations, { readOnlyHint: false }, "a POST may delete in an RPC-style API, so it claims nothing more");
  assert.deepEqual(tools["compose-replace"].annotations, { readOnlyHint: false, idempotentHint: true });
  assert.deepEqual(tools["compose-remove"].annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true });

  // A JSON response comes back structured as well as text, redacted in both.
  const result = await rpc(fake, "runkle-app-dokploy", "tools/call", { name: "compose-one", arguments: {} });
  assert.deepEqual(result.structuredContent, { id: 7, env: "[redacted]" });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);

  // A misspelt argument is refused, not silently dropped from the request.
  const wrong = await rpc(fake, "runkle-app-dokploy", "tools/call", { name: "compose-redeploy", arguments: { composeid: "c1" } });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.content[0].text, "Unknown argument: composeid. compose-redeploy takes composeId.");

  await call("POST", "/api/sources", { name: "Graph", kind: "graphql", url: "https://api.example.com/graphql", auth: "none" });
  const graph = (await rpc(fake, "runkle-app-graph", "tools/list")).tools;
  assert.deepEqual(graph.map((x: any) => x.annotations), [undefined, { readOnlyHint: true }], "a query may be a mutation; the schema is only read");
});

test("a script's tools declare annotations and output, return structured results and refuse unknown arguments", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const source = `export const tools = {
  stats: {
    input: { type: "object", properties: { days: { type: "number" } } },
    output: { type: "object", properties: { days: { type: "number" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ days }) => ({ days }),
  },
  list: { run: (input) => [input] },
  note: { run: () => "plain text" },
  open: { input: { type: "object", properties: {}, additionalProperties: true }, run: (input) => input },
};`;
  await call("POST", "/api/apps", { name: "Stats", source });
  const [stats, list] = (await rpc(fake, "runkle-app-stats", "tools/list")).tools;
  assert.deepEqual(stats.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(stats.outputSchema, { type: "object", properties: { days: { type: "number" } } });
  assert.equal(list.annotations, undefined);
  assert.equal(list.outputSchema, undefined);

  const result = (name: string, args?: unknown) => rpc(fake, "runkle-app-stats", "tools/call", { name, arguments: args });
  assert.deepEqual((await result("stats", { days: 3 })).structuredContent, { days: 3 });
  const array = await result("list", { a: 1 });
  assert.equal(array.structuredContent, undefined, "structuredContent is an object; an array stays text");
  assert.equal(array.content[0].text, '[{"a":1}]', "a tool that lists no properties takes any arguments");
  assert.equal((await result("note")).structuredContent, undefined);

  const refused = await result("stats", { days: 3, weeks: 1, months: 2 });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "Unknown arguments: weeks, months. stats takes days.");
  assert.deepEqual((await result("open", { anything: 1 })).structuredContent, { anything: 1 }, "additionalProperties: true allows any name");
});

test("runkle's own MCP server tells agents how to use the portal and what an added integration needs", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const mcp = async (method: string, params: unknown) => {
    const response = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params }, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    return JSON.parse((await response.text()).match(/^data: (.*)$/m)![1]).result;
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.match(init.instructions, /Using this portal: .*structuredContent.*same id.*queued.*prefer this portal/);

  const added = await mcp("tools/call", { name: "add_skills", arguments: { name: "Playbooks", skills: [{ name: "triage", description: "When triaging", content: "# Steps" }] } });
  const out = JSON.parse(added.content[0].text);
  assert.equal(out.id, "playbooks");
  assert.match(out.next_steps, /reconnects this portal's connector.*fresh session.*update_api_source or update_script/);
});

// ---- Integration health ----

test("secretReads finds the env names a module reads, and what a generated API needs", async () => {
  const { secretReads } = await import("../src/health.ts");
  const { sourceApp } = await import("../src/sources.ts");
  const script = `const { GARMIN_EMAIL, PASSWORD: pw } = env; run(i, env) { return env.GARMIN_TOKEN + env["OTHER_KEY"] + secrets?.THIRD + env.RUNKLE_APP + env.lowercase; }`;
  assert.deepEqual(secretReads(script).sort(), ["GARMIN_EMAIL", "GARMIN_TOKEN", "OTHER_KEY", "PASSWORD", "THIRD"]);
  const open = await sourceApp({ kind: "openapi", spec: OPENAPI, auth: "none", secret_headers: { "x-tunnel-pass": "TUNNEL_PASS" } });
  assert.deepEqual(secretReads(open), ["TUNNEL_PASS"], "an open API needs no API_TOKEN, though its client code mentions one");
  assert.deepEqual(secretReads(await sourceApp({ kind: "openapi", spec: OPENAPI, auth: "bearer" })), ["API_TOKEN"]);
});

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

test("a health check finds broken, unused and expiring secrets, alerts once per problem and closes what was fixed", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  await call("POST", "/api/push", { subscription: await browser("https://fcm.push.test/h") });

  const garmin = `export const tools = { me: { run: (i, env) => env.GARMIN_TOKEN } };
export const probe = async (env) => { if (env.GARMIN_TOKEN !== "good") throw new Error("HTTP 400: invalid API key"); };`;
  const made = await call("POST", "/api/apps", { name: "Garmin", source: garmin, secrets: { GARMIN_TOKEN: "bad", GARMIN_EMAIL: "me@example.com" }, expires: { GARMIN_TOKEN: inDays(5) } });
  assert.equal(made.status, 200);
  await call("POST", "/api/sources", { name: "Dokploy", kind: "openapi", spec: OPENAPI, auth: "none", secret_headers: { "x-tunnel-pass": "TUNNEL_PASS" } });
  await call("POST", "/api/integrations", { name: "Linear", url: "https://linear.example/mcp", auth: "oauth" });
  await call("POST", "/api/skills", { name: "Notes", skills: [{ name: "n", description: "d", content: "# n" }] });
  assert.deepEqual(await (await call("GET", "/api/health")).json(), {}, "nothing is reported before the first check");

  const report: any = await (await call("POST", "/api/health")).json();
  const by = Object.fromEntries(report.integrations.map((i: any) => [i.id, i]));
  assert.equal(by.garmin.status, "upstream_error", "the worst problem names the status");
  assert.deepEqual(by.garmin.problems.map((p: any) => [p.kind, p.secret]), [["upstream_error", undefined], ["expiring", "GARMIN_TOKEN"], ["unused_secret", "GARMIN_EMAIL"]]);
  assert.match(by.garmin.problems[0].reason, /probe failed: HTTP 400: invalid API key/);
  assert.match(by.garmin.problems[1].reason, new RegExp(`GARMIN_TOKEN expires on ${inDays(5)}, in [45] days`));
  assert.deepEqual(by.dokploy.problems.map((p: any) => [p.kind, p.secret]), [["missing_secret", "TUNNEL_PASS"]]);
  assert.match(by.dokploy.note, /declares no probe/);
  assert.equal(by.linear.status, "needs_sign_in");
  assert.deepEqual([by.notes.status, by.notes.problems], ["ok", []]);
  for (const i of report.integrations) for (const p of i.problems) assert.ok(p.reason && p.fix, "every problem says why and what to do");
  assert.ok(!JSON.stringify(report).includes("me@example.com") && !JSON.stringify(report).includes('"bad"'), "no secret value reaches the report");

  const alerts = async () => ((await (await call("GET", "/api/inbox")).json()) as any).waiting.filter((i: any) => i.kind === "alert").map((i: any) => i.id).sort();
  assert.deepEqual(await alerts(), [
    "health:dokploy:missing-secret:tunnel-pass",
    "health:garmin:expiring:garmin-token",
    "health:garmin:unused-secret:garmin-email",
    "health:garmin:upstream-error",
    "health:linear:needs-sign-in",
  ]);
  assert.equal(fake.pushes.length, 5, "one notification per new problem");
  assert.deepEqual(((await (await call("GET", "/api/health")).json()) as any).checked_at, report.checked_at, "the UI reads the last report");

  // The daily run finds the same problems: the same items, nobody notified again.
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
  await Promise.all(waits);
  assert.equal((await alerts()).length, 5);
  assert.equal(fake.pushes.length, 5);

  // Fixed: a good key without a date, the tunnel pass set. Their alerts close at the next check.
  await call("PUT", "/api/apps/garmin", { secrets: { GARMIN_TOKEN: "good" } });
  await call("PUT", "/api/apps/dokploy", { secrets: { TUNNEL_PASS: "p" }, expires: { TUNNEL_PASS: "2027-11-19" } });
  const state: any = await (await call("GET", "/api/state")).json();
  assert.equal(state.integrations.find((i: any) => i.id === "garmin").secret_expiry, undefined, "a new value drops the old value's date");
  assert.deepEqual(state.integrations.find((i: any) => i.id === "dokploy").secret_expiry, { TUNNEL_PASS: "2027-11-19" });
  await call("POST", "/api/health");
  assert.deepEqual(await alerts(), ["health:garmin:unused-secret:garmin-email", "health:linear:needs-sign-in"]);

  // A probe answers only the one request runkle put a key in its inbox for.
  const app = await fake.app("runkle-app-garmin");
  const probe = (key: string) => app.worker.fetch(new Request("https://runkle-app-garmin.acme.workers.dev/manifest/probe", { headers: { Authorization: `Bearer ${key}` } }), app.env);
  assert.equal((await probe("guess")).status, 401);
  const key = "k".repeat(64);
  await latest!.inbox.get({} as any).fetch("https://inbox/", { method: "POST", body: JSON.stringify({ op: "probe_key", app: "dokploy", key }) });
  assert.equal((await probe(key)).status, 401, "a key for another app does not work");

  // Removing an integration forgets its dates and, at the next check, its alerts.
  await call("DELETE", "/api/integrations/dokploy");
  assert.ok(![...fake.inboxData.keys()].includes("expiry:dokploy"));
});

test("dates are entered beside values and agents can record them, never a value", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  await call("POST", "/api/apps", { name: "Shots", source: `export const tools = { t: { run: (i, env) => env.SHOT_TOKEN } };`, secrets: { SHOT_TOKEN: "s" } });
  assert.equal((await call("PUT", "/api/apps/shots", { secrets: { SHOT_TOKEN: "s2" }, expires: { SHOT_TOKEN: "2026-02-30" } })).status, 400);
  assert.equal((await call("PUT", "/api/apps/shots", { secrets: { SHOT_TOKEN: "s2" }, expires: { OTHER: "2027-01-01" } })).status, 400, "a date needs its value");

  const mcp = async (name: string, args: unknown) => {
    const response = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    return JSON.parse((await response.text()).match(/^data: (.*)$/m)![1]).result;
  };
  const set = await mcp("set_secret_expiry", { id: "shots", name: "SHOT_TOKEN", expires: inDays(90) });
  assert.deepEqual(JSON.parse(set.content[0].text), { secret_expiry: { SHOT_TOKEN: inDays(90) } });
  assert.equal((await mcp("set_secret_expiry", { id: "shots", name: "NOPE", expires: inDays(1) })).isError, true);
  assert.equal((await mcp("set_secret_expiry", { id: "shots", name: "SHOT_TOKEN", expires: "soon" })).isError, true);

  const checked = JSON.parse((await mcp("check_integrations", {})).content[0].text);
  assert.deepEqual(checked.integrations.map((i: any) => [i.id, i.status]), [["shots", "ok"]], "90 days out is not a problem yet");
  assert.match(checked.sign_in, /out of runkle's sight/);
  assert.deepEqual(((await (await call("GET", "/api/inbox")).json()) as any).waiting, [], "an agent's check alerts no one");

  await mcp("set_secret_expiry", { id: "shots", name: "SHOT_TOKEN", expires: inDays(-1) });
  const expired = JSON.parse((await mcp("check_integrations", {})).content[0].text).integrations[0];
  assert.match(expired.problems[0].reason, /SHOT_TOKEN expired on/);
  await mcp("set_secret_expiry", { id: "shots", name: "SHOT_TOKEN", expires: null });
  assert.equal(((await (await call("GET", "/api/state")).json()) as any).integrations[0].secret_expiry, undefined);
});

// A 1Password Connect server at op.example.com, in memory, with the "Agents" vault. Everything else goes to the fake Cloudflare.
function connect(t: any, fake: ReturnType<typeof fakeCloudflare>) {
  const vault = { id: "v".repeat(26), name: "Agents", items: 1 };
  const items = new Map<string, any>([
    ["i".repeat(26), {
      id: "i".repeat(26), title: "Discogs", category: "LOGIN", tags: ["music"], urls: [{ href: "https://discogs.com" }], updatedAt: "2025-01-01T00:00:00Z",
      fields: [
        { id: "username", label: "username", type: "STRING", purpose: "USERNAME", value: "jay" },
        { id: "password", label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "old-pw" },
      ],
    }],
  ]);
  const writes: any[] = [], seen: string[] = [];
  let made = 0;
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== "op.example.com") return fake.handle(request);
    assert.equal(request.headers.get("Authorization"), "Bearer connect-token");
    const text = request.body ? await request.text() : "";
    seen.push(text);
    const body: any = text ? JSON.parse(text) : undefined;
    // What Connect does with generate: makes the value itself.
    const stored = (i: any) => ({ ...i, fields: i.fields.map(({ generate, recipe, ...f }: any) => (generate ? { ...f, id: f.id ?? "f" + ++made, value: `generated-${recipe.length}-${++made}` } : { ...f, id: f.id ?? "f" + ++made })) });
    const at = `${request.method} ${url.pathname}`, filter = url.searchParams.get("filter");
    const itemPath = new RegExp(`^/v1/vaults/${vault.id}/items/([a-z0-9]+)$`);
    if (at === "GET /v1/vaults") return Response.json(filter && filter !== 'name eq "Agents"' ? [] : [vault]);
    if (at === `GET /v1/vaults/${vault.id}/items`)
      return Response.json([...items.values()].filter((i) => !filter || filter === `title eq "${i.title}"`).map(({ fields, ...summary }) => summary));
    const [, itemId] = url.pathname.match(itemPath) ?? [];
    if (request.method === "GET" && itemId) return Response.json(items.get(itemId));
    if (request.method === "PUT" && itemId) return writes.push(body), items.set(itemId, stored(body)), Response.json(items.get(itemId));
    if (at === `POST /v1/vaults/${vault.id}/items`) {
      // A Connect error that quotes what it was sent, as some do.
      if (body.title === "Rejected") return Response.json({ message: `invalid item: ${JSON.stringify(body.fields)}` }, { status: 400 });
      const item = { ...stored(body), id: String(++made).padStart(26, "n") };
      return writes.push(body), items.set(item.id, item), Response.json(item);
    }
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const secrets = { OP_CONNECT_HOST: "https://op.example.com/", OP_CONNECT_TOKEN: "connect-token" };
  const byTitle = (title: string) => [...items.values()].find((i) => i.title === title);
  return { items, writes, seen, secrets, byTitle };
}

test("1Password: metadata is free, values and writes ask first, and no tool takes a secret", async (t) => {
  const fake = fakeCloudflare();
  const op = connect(t, fake);
  const item = op.byTitle("Discogs");
  const { made: app, tool, approved } = await readyMade(fake, "onepassword.js", "1Password", op.secrets);
  assert.deepEqual(app.approvals, ["read_secret", "create_item", "generate_field", "copy_field"]);
  assert.ok(!app.tools.includes("vault"), "keeping a copy is not a tool: no agent can hand it a value");
  const discogs = { vault: "Agents", item: "Discogs" };
  const values = /old-pw|generated-/;

  // Free: where things are and what they are called, never what they hold.
  const free = [await tool("list_vaults"), await tool("list_items", { vault: "Agents", search: "disc" }), await tool("get_item", discogs)];
  assert.ok(!values.test(JSON.stringify(free)));
  assert.deepEqual(free[2].fields.map((f: any) => [f.label, f.value, f.filled]), [["username", "jay", true], ["password", undefined, true]]);
  assert.match((await tool("get_item", { vault: "Personal", item: "Bank" })).error, /No vault called "Personal"/, "only the vaults the token covers");

  // Rotation without anyone seeing a value: generate into a spare field, then copy it over the live one.
  const staged = await approved("generate_field", { ...discogs, field: "staged password", symbols: false }, /Set "staged password" of item "Discogs" in vault "Agents" with a newly generated value/);
  assert.ok(!values.test(JSON.stringify(staged)));
  assert.deepEqual(op.writes[0].fields[2], { type: "CONCEALED", label: "staged password", generate: true, recipe: { length: 32, characterSets: ["LETTERS", "DIGITS"] } });
  await approved("copy_field", { ...discogs, from: "staged password", to: "password" }, /Copy "staged password" over "password".*history/s);
  const now = op.byTitle("Discogs");
  assert.match(now.fields[1].value, /^generated-32-/);
  assert.equal(now.fields[1].value, now.fields[2].value);
  assert.match((await tool("copy_field", { ...discogs, from: "nope", to: "password" })).error, /No field called "nope"/);

  // Reading a value into the conversation is possible, and always asked.
  assert.equal(await approved("read_secret", { ...discogs, field: "password" }, /Show the agent the value of "password" from item "Discogs".*conversation/s), now.fields[1].value);

  const created = await approved("create_item", { vault: "Agents", title: "New API", username: "bot", generate_password: true, length: 20 }, /Create the item "New API" in vault "Agents" with a generated password/);
  assert.ok(created.id && !values.test(JSON.stringify(created)));
  assert.equal(op.writes.length, 3, "each write ran once, after approval");
  void item;
});

test("generate_secret: asked first, set once, kept in 1Password, and never seen", async (t) => {
  const fake = fakeCloudflare();
  const op = connect(t, fake);
  const logged: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, level, (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  const { generateSecret } = await import("../src/ops.ts");
  const said: string[] = []; // everything runkle answered, to search for the value
  const answer = async (response: Response) => (said.push(await response.clone().text()), response.json() as Promise<any>);

  await call("POST", "/api/apps", { name: "Hooks", source: SCRIPT, secrets: { KEY: "k" } });
  await call("POST", "/api/apps", { name: "New", source: SCRIPT });
  await readyMade(fake, "onepassword.js", "1Password", op.secrets);
  await call("POST", "/api/integrations", { name: "Upstream", url: "https://upstream.example/mcp", auth: "bearer", token: "old-token" });
  await call("POST", "/api/integrations", { name: "Docs", url: "https://docs.example/mcp", auth: "none" });

  // Through runkle's own MCP endpoint, as an agent calls it.
  const mcp = async (args: unknown) => {
    const response = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_secret", arguments: args } }, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    const text = await response.text();
    said.push(text);
    const result = JSON.parse(text.match(/^data: (.*)$/m)![1]).result;
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  const request = {
    targets: [{ app: "hooks", secret: "WEBHOOK_SECRET" }, { server: "upstream" }],
    length: 48,
    copy_to: { app: "1password", vault: "Agents", item: "Upstream webhook", field: "token" },
  };
  const hooks = () => fake.scripts.get("runkle-app-hooks")!.secrets;
  const nothingSet = () => {
    assert.equal(hooks().WEBHOOK_SECRET, undefined);
    assert.equal(fake.credentials.get("upstream"), "old-token");
    assert.equal(op.byTitle("Upstream webhook"), undefined);
  };

  // The rules are checked before anyone is asked.
  assert.match((await mcp({ targets: [{ app: "hooks", secret: "RUNKLE_TOKEN" }] })).error, /reserved/);
  assert.match((await mcp({ targets: [{ app: "docs", secret: "X" }] })).error, /No script/);
  assert.match((await mcp({ targets: [{ server: "hooks" }] })).error, /runkle's to manage/);
  assert.match((await mcp({ targets: [{ server: "docs" }] })).error, /bearer/);
  assert.match((await mcp({ targets: [{ app: "hooks", secret: "A" }], length: 8 })).error, /16 to 128/);
  assert.match((await mcp({ ...request, copy_to: { ...request.copy_to, app: "new" } })).error, /holds no secrets/, "a vault app's code must be reviewed code");
  assert.deepEqual(((await answer(await call("GET", "/api/inbox"))) as any).waiting, []);

  const asked = await mcp(request);
  assert.match(asked.waiting_for_approval, /^https:\/\/runkle\.test\/#inbox=[0-9a-f]{32}$/);
  assert.match(asked.next, /same arguments/);
  nothingSet();
  assert.equal((await mcp({ copy_to: request.copy_to, length: 48, targets: request.targets })).waiting_for_approval, asked.waiting_for_approval, "asking again, in any key order, finds the same request");
  nothingSet();

  // The person sees where it goes and where the copy is kept: names, never a value (there is none yet).
  const id = new URLSearchParams(new URL(asked.waiting_for_approval).hash.slice(1)).get("inbox")!;
  const [item] = (await answer(await call("GET", "/api/inbox"))).waiting;
  assert.deepEqual([item.id, item.kind, item.app, item.tool], [id, "approval", "runkle", "generate_secret"]);
  assert.deepEqual(item.input, { targets: request.targets, length: 48, alphabet: "alphanumeric", copy_to: request.copy_to });
  assert.equal(
    item.title,
    'Generate a 48-character alphanumeric secret and set it as WEBHOOK_SECRET on hooks and as the bearer token the portal sends to upstream. Keep a copy in vault "Agents", item "Upstream webhook", field "token" (through 1password). Nobody sees the value.',
  );
  assert.equal((await call("POST", `/api/inbox/${id}`, { approve: true })).status, 200);

  const done = await mcp(request);
  assert.deepEqual(done.set, ["WEBHOOK_SECRET on hooks", "bearer token of upstream"]);
  assert.deepEqual(done.copy, { vault: "Agents", item: "Upstream webhook", field: "token" });
  const value = hooks().WEBHOOK_SECRET;
  assert.match(value, /^[A-Za-z0-9]{48}$/);
  assert.equal(fake.credentials.get("upstream"), value, "the portal sends the same value upstream");
  assert.equal(fake.servers.get("upstream").name, "Upstream");
  const kept = op.byTitle("Upstream webhook");
  assert.deepEqual([kept.category, kept.tags, kept.fields.map((f: any) => [f.label, f.type, f.value])], ["LOGIN", ["runkle"], [["token", "CONCEALED", value]]]);
  assert.match((await mcp(request)).waiting_for_approval, /#inbox=/, "an approval runs once");

  // Which secrets have a copy, by name only.
  const listed = (await answer(await call("GET", "/api/state"))).integrations.find((i: any) => i.id === "hooks");
  assert.deepEqual([listed.secrets_set, listed.secrets_copied], [["KEY", "WEBHOOK_SECRET"], ["WEBHOOK_SECRET"]]);
  assert.equal(await (await fake.app("runkle-app-hooks")).env.RUNKLE_COPY_WEBHOOK_SECRET, "1");
  const ran = JSON.parse((await callTool(fake, "runkle-app-hooks", "whoami")).text);
  assert.equal(ran.sawPortalToken, false, "the mark is runkle's and never reaches the script");

  // Generating again into the same item replaces the field; the old value stays in 1Password's history.
  const again = { targets: [{ app: "hooks", secret: "WEBHOOK_SECRET" }], alphabet: "hex", copy_to: request.copy_to };
  const second = await generateSecret(env, origin, again, "dev@localhost"); // from runkle's own UI: the person is the approval
  said.push(JSON.stringify(second));
  assert.match(hooks().WEBHOOK_SECRET, /^[0-9a-f]{40}$/);
  assert.deepEqual(op.byTitle("Upstream webhook").fields.map((f: any) => f.value), [hooks().WEBHOOK_SECRET]);
  const values = [value, hooks().WEBHOOK_SECRET];

  // A value typed by hand has no copy anywhere: the mark goes.
  await call("PUT", "/api/apps/hooks", { secrets: { WEBHOOK_SECRET: "typed" } });
  assert.deepEqual((await answer(await call("GET", "/api/state"))).integrations.find((i: any) => i.id === "hooks").secrets_copied, []);

  // The UI route needs a person's request from runkle's own page.
  assert.equal((await call("POST", "/api/generate", { targets: [{ app: "hooks", secret: "OTHER" }] }, {})).status, 403);
  const fromUi = await answer(await call("POST", "/api/generate", { targets: [{ app: "new", secret: "SIGNING_KEY" }], alphabet: "base64url", length: 64 }));
  assert.deepEqual(fromUi.set, ["SIGNING_KEY on new"]);
  values.push(fake.scripts.get("runkle-app-new")!.secrets.SIGNING_KEY);
  assert.match(values[2], /^[A-Za-z0-9_-]{64}$/);

  // A failed copy sets nothing, and its error never carries the value.
  const rejected = { targets: [{ app: "hooks", secret: "LATER" }], copy_to: { ...request.copy_to, item: "Rejected" } };
  await assert.rejects(generateSecret(env, origin, rejected, "dev@localhost"), (error: Error) => {
    said.push(error.message);
    assert.match(error.message, /Keeping a copy failed: 1Password: invalid item: .*\[the generated value\]/);
    return true;
  });
  assert.equal(hooks().LATER, undefined);
  values.push(JSON.parse(op.seen.filter((s) => s.includes("Rejected")).at(-1)!).fields[0].value);
  await assert.rejects(generateSecret(env, origin, { targets: [{ app: "hooks", secret: "LATER" }], copy_to: { ...request.copy_to, app: "hooks" } }, "dev@localhost"), /hooks cannot keep copies: its script exports no vault/);
  assert.equal(hooks().LATER, undefined);

  // An agent sees none of it: not in any answer, the inbox, a log, or the vault app's tools and storage.
  const tools = await Promise.all([callTool(fake, "runkle-app-1password", "list_items", { vault: "Agents" }), callTool(fake, "runkle-app-1password", "get_item", { vault: "Agents", item: "Upstream webhook" })]);
  said.push(JSON.stringify(tools), await (await call("GET", "/api/state")).text(), await (await call("GET", "/api/inbox")).text());
  const everywhere = [...said, JSON.stringify([...fake.inboxData]), ...logged, JSON.stringify([...fake.scripts.get("runkle-app-1password")!.data])].join("\n");
  for (const v of values) assert.ok(v && !everywhere.includes(v), "the generated value never leaves where it was put");

  // Denied is final.
  const denied = { targets: [{ app: "hooks", secret: "NOPE" }] };
  const deniedId = new URLSearchParams(new URL((await mcp(denied)).waiting_for_approval).hash.slice(1)).get("inbox")!;
  await call("POST", `/api/inbox/${deniedId}`, { approve: false });
  assert.match((await mcp(denied)).error, /Denied by dev@localhost/);
  assert.equal(hooks().NOPE, undefined);
});

test("GitHub: acts as an App, and merges to main, tags, workflow runs and new repositories ask first", async (t) => {
  const fake = fakeCloudflare();
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pr = { number: 7, title: "Fix it", user: { login: "bot" }, head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { default_branch: "main" } } };
  const calls: { method: string; path: string; body: any; auth: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const request = new Request(input, init), url = new URL(request.url), auth = request.headers.get("Authorization")!.slice(7);
    if (url.hostname !== "api.github.com") return fake.handle(request);
    const body = request.body ? await request.json() : undefined, path = url.pathname + url.search;
    calls.push({ method: request.method, path, body, auth });
    const asApp = /installation$|^\/app\//.test(url.pathname);
    if (asApp) {
      // Only a token signed by the App's key, naming the App, is accepted.
      const [head, claims, signature] = auth.split(".");
      assert.ok(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(key.publicKey, signature, "base64url"));
      assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, "123");
    } else assert.match(auth, /^ghs_/);
    const at = `${request.method} ${url.pathname}`;
    if (at === "GET /repos/acme/site/installation" || at === "GET /orgs/acme/installation") return Response.json({ id: 9 });
    if (at === "GET /repos/acme/other/installation") return Response.json({ message: "Not Found" }, { status: 404 });
    if (at === "GET /app/installations") return Response.json([{ id: 9 }]);
    if (at === "POST /app/installations/9/access_tokens") return Response.json({ token: "ghs_" + ((body as any)?.repositories?.[0] ?? "all") });
    if (at === "GET /installation/repositories") return Response.json({ repositories: [{ full_name: "acme/site", private: true, default_branch: "main" }] });
    if (at === "GET /repos/acme/site/pulls/7") return Response.json(pr);
    if (at === `GET /repos/acme/site/commits/${pr.head.sha}/check-runs`) return Response.json({ check_runs: [{ conclusion: "success" }, { conclusion: "failure" }] });
    if (at === "PUT /repos/acme/site/pulls/7/merge") return Response.json({ merged: true, sha: "m1" });
    if (at === "POST /repos/acme/site/pulls") return Response.json({ number: 8, html_url: "https://github.com/acme/site/pull/8" });
    if (at === "POST /repos/acme/site/git/refs") return Response.json({ ref: (body as any).ref });
    if (at === "POST /repos/acme/site/actions/workflows/deploy.yml/dispatches") return new Response(null, { status: 204 });
    if (at === "POST /orgs/acme/repos") return Response.json({ full_name: "acme/" + (body as any).name, html_url: "https://github.com/acme/new" });
    if (at === "GET /repos/acme/site/pulls") return Response.json([pr]);
    throw new Error("unexpected " + at);
  });
  // The key as GitHub issues it (PKCS#1), pasted into a one-line field.
  const pem = (key.privateKey.export({ type: "pkcs1", format: "pem" }) as string).replace(/\n/g, " ");
  const { made, tool, approved } = await readyMade(fake, "github.js", "GitHub", { GITHUB_APP_ID: "123", GITHUB_PRIVATE_KEY: pem });
  assert.deepEqual(made.approvals, ["merge_pull_request", "create_tag", "run_workflow", "create_repository"]);
  const wrote = () => calls.filter((c) => c.method !== "GET" && !c.path.includes("access_tokens")).map((c) => `${c.method} ${c.path}`);

  // Reading and opening a pull request run freely, with a token narrowed to the one repository.
  assert.deepEqual(await tool("list_repos"), [{ repo: "acme/site", private: true, default_branch: "main" }]);
  assert.equal((await tool("get", { repo: "acme/site", path: "pulls", query: { state: "open" } }))[0].number, 7);
  assert.deepEqual(calls.at(-1), { method: "GET", path: "/repos/acme/site/pulls?state=open", body: undefined, auth: "ghs_site" });
  assert.match((await tool("get", { repo: "acme/site", path: "../../user" })).error, /\.\./);
  assert.match((await tool("get", { repo: "acme/other", path: "" })).error, /Not Found/, "a repository the App is not installed on");
  assert.equal((await tool("create_pull_request", { repo: "acme/site", title: "T", head: "fix", base: "main" })).number, 8);

  // Merging into the default branch: the person sees the commit and its checks, and the merge is pinned to that commit.
  const merge = { repo: "acme/site", number: 7, sha: pr.head.sha };
  assert.match((await tool("merge_pull_request", { ...merge, sha: "b".repeat(40) })).error, /Review it again/);
  const merged = await approved("merge_pull_request", merge, /Merge pull request 7 "Fix it" into main of acme\/site, at commit aaaaaaa by bot \(1 of 2 checks passed\)/);
  assert.deepEqual(merged, { merged: true, sha: "m1" });
  assert.deepEqual(calls.filter((c) => c.method === "PUT").at(-1)!.body, { sha: pr.head.sha, merge_method: "squash" });
  // Into any other branch it is not asked.
  pr.base.ref = "feature";
  assert.equal((await tool("merge_pull_request", merge)).merged, true);

  const before = wrote().length;
  assert.equal((await approved("create_tag", { repo: "acme/site", tag: "v1.2.0", sha: pr.head.sha }, /Push tag v1\.2\.0 to acme\/site, at commit aaaaaaa/)).ref, "refs/tags/v1.2.0");
  assert.equal((await approved("run_workflow", { repo: "acme/site", workflow: "deploy.yml", ref: "main" }, /Run workflow deploy\.yml on main of acme\/site/)).started, "deploy.yml");
  assert.equal((await approved("create_repository", { owner: "acme", name: "new" }, /Create the private repository acme\/new/)).repo, "acme/new");
  assert.equal(calls.filter((c) => c.path === "/orgs/acme/repos").at(-1)!.body.private, true);
  assert.equal(wrote().length, before + 3, "each ran once, and only after approval");
});

test("Fastmail: reading and drafting pass straight through, sending and changing ask first", async (t) => {
  const fake = fakeCloudflare();
  const ran: any[] = [];
  const offered = ["search_email", "read_email", "draft_email", "send_email", "delete_email", "update_event", "delete_contact", "list_calendars", "brand_new_tool"];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.fastmail.com/mcp") return fake.handle(request);
    if (request.headers.get("Authorization") !== "Bearer fm-token") return new Response("no", { status: 401 });
    const msg: any = await request.json();
    if (msg.method === "initialize") return Response.json({ jsonrpc: "2.0", id: msg.id, result: {} }, { headers: { "Mcp-Session-Id": "s1" } });
    assert.equal(request.headers.get("Mcp-Session-Id"), "s1");
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (msg.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: msg.id, result: { tools: offered.map((name) => ({ name, description: name.replace("_", " "), inputSchema: { type: "object" } })) } });
    ran.push(msg.params);
    const result = msg.params.name === "delete_email" ? { isError: true, content: [{ type: "text", text: "No such email" }] } : { content: [{ type: "text", text: "did " + msg.params.name }] };
    // Fastmail may answer as an event stream.
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const { made, tool, approved } = await readyMade(fake, "fastmail.js", "Fastmail", { FASTMAIL_TOKEN: "fm-token" });
  assert.deepEqual(made.approvals, ["call"]);

  const listed = await tool("tools");
  assert.deepEqual(listed.filter((x: any) => !x.asks_first).map((x: any) => x.name), ["search_email", "read_email", "draft_email", "list_calendars"], "a tool Fastmail adds later asks first until someone decides otherwise");
  assert.equal(await tool("call", { tool: "search_email", arguments: { query: "invoice" } }), "did search_email");
  assert.equal(await tool("call", { tool: "draft_email", arguments: { to: ["a@example.com"], subject: "Hi" } }), "did draft_email");

  const send = { tool: "send_email", arguments: { to: [{ email: "a@example.com" }], subject: "Hi   there", body: "x".repeat(500) } };
  assert.ok((await tool("call", send)).waiting_for_approval);
  assert.equal(ran.length, 2, "nothing was sent");
  assert.equal(await approved("call", send, /Fastmail: send_email\. to: a@example\.com; subject: Hi there; body: x{80}\n/), "did send_email");
  assert.deepEqual(ran.at(-1), { name: "send_email", arguments: send.arguments });
  for (const name of ["update_event", "delete_contact", "brand_new_tool"]) assert.ok((await tool("call", { tool: name, arguments: { id: "1" } })).waiting_for_approval, name);
  assert.match((await approved("call", { tool: "delete_email", arguments: { emailId: "m1" } }, /delete_email\. emailId: m1/)).error, /No such email/);
  assert.equal(ran.length, 4);
});
