import assert from "node:assert/strict";
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
  const held: any = await proposeChange(env, origin, "bare", SCRIPT + "// leak");
  assert.equal(held.waiting_for_review, "https://runkle.test/#review=bare");
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
});
