import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Env } from "../src/cloudflare.ts";
import worker from "../src/index.ts";
import { serverBody, setTool, slug, toMapping } from "../src/mapping.ts";
import { fakeCloudflare } from "./fake-cloudflare.ts";

const env: Env = {
  CLOUDFLARE_API_TOKEN: "test-token",
  ACCOUNT_ID: "acct",
  PORTAL_ID: "main",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  AUTH_DISABLED: "true",
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
  assert.deepEqual(open.destinations.map((d: any) => d.uri), ["mcp", "webhooks", "manifest"].map((area) => `runkle-app-rich.acme.workers.dev/${area}`));
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
  assert.equal(serverLink(origin, { name: "Gh", url: "https://gh.example/mcp", auth: "bearer" }).url, "https://runkle.test/#add=1&name=Gh&url=https%3A%2F%2Fgh.example%2Fmcp&auth=bearer");
  assert.throws(() => serverLink(origin, { name: "Gh", url: "http://gh.example", auth: "bearer" }), /https/);

  // The agent can watch for the names, and only the names, to appear.
  const garmin = async () => ((await (await call("GET", "/api/state")).json()) as any).integrations[0];
  assert.deepEqual((await garmin()).secrets_set, []);
  await call("PUT", "/api/apps/garmin", { secrets: { GARMIN_USER: "jay" } });
  const text = JSON.stringify(await garmin());
  assert.deepEqual(JSON.parse(text).secrets_set, ["GARMIN_USER"]);
  assert.ok(!text.includes("jay"));
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
  const held: any = await proposeChange({ ...env, NOTIFY_URL: "https://notify.test/me" }, origin, "bare", SCRIPT + "// leak");
  assert.equal(held.waiting_for_review, "https://runkle.test/#review=bare");
  assert.deepEqual(fake.notes.map((n) => n.click), ["https://runkle.test/#review=bare"], "the person is told where to review it");
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

test("a tool that asks first runs once, and only after a person approves in their browser", async (t) => {
  const fake = fakeCloudflare();
  t.mock.method(globalThis, "fetch", (input: any, init: any) => fake.handle(new Request(input, init)));
  const host = "https://runkle-app-gated.acme.workers.dev";
  const mine = { ...env, NOTIFY_URL: "https://notify.test/me" };
  const put = (path: string, method: string, body: unknown) =>
    worker.fetch(new Request(origin + path, { method, headers: { Origin: origin }, body: JSON.stringify(body) }), mine, {} as ExecutionContext);

  const made: any = await (await put("/api/apps", "POST", { name: "Gated", source: GATED, secrets: { KEY: "k" }, ask_first: ["wi*"] })).json();
  assert.deepEqual(made.approvals, ["wipe", "pay"], "one from the person's list, one from the script");
  assert.equal((await put("/api/apps", "POST", { name: "Bad", source: GATED, ask_first: ["no spaces"] })).status, 400);
  const gate = [...fake.apps.values()].find((a) => a.domain === "runkle-app-gated.acme.workers.dev");
  const app = await fake.app("runkle-app-gated");
  const listed = ((await (await call("GET", "/api/state")).json()) as any).integrations[0];
  assert.deepEqual([listed.ask_first, listed.secrets_set], [["wi*"], ["KEY"]]);
  const described = Object.fromEntries((await rpc(fake, "runkle-app-gated", "tools/list")).tools.map((x: any) => [x.name, /approval/.test(x.description)]));
  assert.deepEqual(described, { read: false, keys: false, wipe: true, pay: true });

  const tool = async (name: string, args?: unknown) => {
    const { text, isError } = await callTool(fake, "runkle-app-gated", name, args);
    return isError ? { error: text } : text.startsWith("{") ? JSON.parse(text) : text;
  };
  const page = (path: string, decision?: string, from = host, access: unknown = { aud: gate.aud }) =>
    app.worker.fetch(
      new Request(host + path, decision ? { method: "POST", headers: { Origin: from, "Cf-Access-Authenticated-User-Email": "me@example.com" }, body: new URLSearchParams({ decision }) } : {}),
      app.env,
      { access },
    );

  assert.equal(await tool("read"), "read", "other tools run as before");
  const asked = await tool("wipe", { what: "db", n: 1 });
  assert.match(asked.waiting_for_approval, /^https:\/\/runkle-app-gated\.acme\.workers\.dev\/approvals\/[0-9a-f]{32}$/);
  assert.match(asked.next, /sent to their phone/);
  assert.deepEqual(fake.notes.map((n) => [n.title, n.click]), [["Approve wipe?", asked.waiting_for_approval]]);
  const path = new URL(asked.waiting_for_approval).pathname;
  assert.equal((await tool("wipe", { n: 1, what: "db" })).waiting_for_approval, asked.waiting_for_approval, "asking again does not start over");
  assert.equal(fake.notes.length, 1, "or notify twice");
  assert.equal(await tool("keys"), "[]", "the script's own storage cannot see or forge approvals");

  assert.equal((await page(path, undefined, host, null)).status, 403, "closed without Cloudflare Access");
  assert.match(await (await page(path)).text(), /Approve this\?.*wipe.*&#34;db&#34;/s);
  assert.equal((await page(path, "approve", "https://evil.test")).status, 403, "another site cannot decide");
  assert.ok((await tool("wipe", { what: "db", n: 1 })).waiting_for_approval);
  assert.match(await (await page(path, "approve")).text(), /Approved/);
  assert.equal((await page(path, "deny")).status, 409, "one decision per request");

  assert.ok((await tool("wipe", { what: "everything", n: 1 })).waiting_for_approval, "the approval covers those arguments only");
  assert.equal(await tool("wipe", { what: "db", n: 1 }), "wiped db with k");
  assert.ok((await tool("wipe", { what: "db", n: 1 })).waiting_for_approval, "and one call only");

  // A script decides per call, and says what the person is agreeing to.
  assert.equal(await tool("pay", { amount: 5 }), "paid 5");
  const pay = new URL((await tool("pay", { amount: 50 })).waiting_for_approval).pathname;
  assert.match(await (await page(pay)).text(), /Pay 50/);
  assert.match(await (await page(pay, "deny")).text(), /Denied/);
  assert.match((await tool("pay", { amount: 50 })).error, /Denied by me@example\.com/);

  const log = await (await page("/approvals")).text();
  assert.match(log, /denied by me@example\.com<br>Pay 50.*approved by me@example\.com<br>wipe/s);
  assert.match(log, /Waiting.*wipe.*Decided/s);

  // Unanswered requests and unused approvals lapse.
  const later = Date.now() + 2 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => later);
  assert.equal((await page(path)).status, 404);
  assert.equal((await tool("pay", { amount: 50 })).waiting_for_approval, host + pay, "asked afresh");

  // Only the person changes the list; the secret and the script stay as they were.
  assert.equal((await put("/api/apps/gated", "PUT", { ask_first: [] })).status, 200);
  assert.equal(await tool("wipe", { what: "db", n: 1 }), "wiped db with k");
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
  // Calls a tool that must ask, checks what the person is shown, approves, and calls again.
  const approved = async (name: string, args: unknown, shown: RegExp) => {
    const asked = await tool(name, args);
    assert.ok(asked.waiting_for_approval, `${name} asks first: ${JSON.stringify(asked)}`);
    const path = new URL(asked.waiting_for_approval).pathname;
    assert.match(await (await page(path)).text(), shown);
    await page(path, { decision: "approve" });
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
