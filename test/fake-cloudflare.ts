// An in-memory stand-in for the slice of the Cloudflare API runkle uses, with
// the portal's real "PUT replaces the mapping" behaviour. Run this file to
// serve it on :8799 for `wrangler dev` (see README, Development).

import { mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../src/inbox.ts";

// Uploaded apps import their base classes from the Workers runtime; give Node a stand-in.
const WORKERS = "data:text/javascript,class Base { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export { Base as DurableObject, Base as WorkflowEntrypoint };";
registerHooks({
  resolve: (specifier, context, next) => (specifier === "cloudflare:workers" ? { url: WORKERS, shortCircuit: true } : next(specifier, context)),
});

type Script = { versions: Record<string, string>[]; deployed: number; flags: string[]; modules: Record<string, string>; secrets: Record<string, string>; vars: Record<string, string>; messages: string[]; data: Map<string, unknown>; schedules: { cron: string }[]; mod?: any };

// The newest fake's inbox, which the tests hand runkle as its INBOX binding.
export let latest: { inbox: DurableObjectNamespace } | undefined;

export function fakeCloudflare() {
  const servers = new Map<string, any>();
  const credentials = new Map<string, string>(); // what a real portal would send upstream
  const scripts = new Map<string, Script>();
  const workflows = new Map<string, any>();
  const runs: unknown[] = [];
  const pushes: { endpoint: string; ttl: string | null; vapid: string | null; bytes: number }[] = []; // what push services received

  // runkle's own inbox Durable Object, shared by runkle and every app as on Cloudflare.
  const inboxData = new Map<string, unknown>();
  const inboxObject = new Inbox({
    storage: {
      get: async (k: string) => structuredClone(inboxData.get(k)),
      put: async (k: string, v: unknown) => void inboxData.set(k, structuredClone(v)),
      delete: async (k: string) => inboxData.delete(k),
      list: async ({ prefix = "" } = {}) => new Map([...inboxData].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)])),
    },
  });
  const inbox = { idFromName: (n: string) => n, get: () => ({ fetch: (url: string, init: RequestInit) => inboxObject.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;

  // Run an uploaded app the way Workers would: its modules, its secrets, a
  // Durable Object for storage and a workflow binding that runs steps inline.
  async function app(name: string) {
    const script = scripts.get(name)!;
    if (!script.mod) {
      const dir = mkdtempSync(join(tmpdir(), "runkle-app-"));
      for (const [file, text] of Object.entries(script.modules)) writeFileSync(join(dir, file), text);
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      script.mod = await import(join(dir, "index.js"));
    }
    const { mod, data } = script;
    // One Durable Object per name, each with its own keys.
    const storage = (object: string) => ({
      get: async (k: string) => data.get(object + k),
      put: async (k: string, v: unknown) => void data.set(object + k, v),
      delete: async (k: string) => data.delete(object + k),
      list: async ({ prefix = "" } = {}) => new Map([...data].filter(([k]) => k.startsWith(object + prefix)).map(([k, v]) => [k.slice(object.length), v])),
    });
    const env: any = { ...script.secrets, ...script.vars };
    env.RUNKLE_INBOX = inbox;
    env.RUNKLE_STORE = { idFromName: (n: string) => n + "/", get: (object: string) => new mod.Store({ storage: storage(object) }, env) };
    env.RUNKLE_FLOW = {
      create: async ({ params }: any) => ({ id: String(runs.push(await new mod.Flow({}, env).run({ payload: params }, { do: (_: string, fn: () => unknown) => fn() })) - 1) }),
      get: async (id: string) => ({ status: async () => ({ status: "complete", output: runs[Number(id)] }) }),
    };
    return { worker: mod.default, env };
  }
  const apps = new Map<string, any>([
    ["portal-app", { id: "portal-app", type: "mcp_portal", domain: "mcp.example.com", policies: [{ id: "pol-1" }] }],
  ]);
  const portal: any = { id: "main", name: "Main", hostname: "mcp.example.com", code_mode: "opt_in", servers: [] };
  const portals = new Map<string, any>([["main", portal]]); // collections are runkle-* portals beside it
  const zones = [{ id: "zone-1", name: "example.com", account: { id: "acct" } }];
  const dns = new Map<string, any>([["rec-0", { id: "rec-0", type: "CNAME", name: "mcp.example.com", content: "portal.gateway.test", proxied: true }]]);
  let nextApp = 1;

  const view = (portal: any) => ({
    ...portal,
    servers: portal.servers.map((m: any) => ({
      ...servers.get(m.server_id),
      on_behalf: m.on_behalf,
      default_disabled: m.default_disabled,
      updated_tools: (m.updated_tools ?? []).map((t: any) => ({ name: t.name, enabled: t.enabled, portal_enabled: t.enabled })),
      updated_prompts: [],
    })),
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A request to an app's own hostname, direct or through CF_API_BASE (see appFetch).
    // A browser's push service. The one at gone.push.test says its subscription has ended.
    if (url.hostname.endsWith("push.test"))
      return (
        pushes.push({ endpoint: request.url, ttl: request.headers.get("TTL"), vapid: request.headers.get("Authorization"), bytes: (await request.arrayBuffer()).byteLength }),
        new Response(null, { status: url.hostname === "gone.push.test" ? 410 : 201 })
      );
    const [, host, rest] = url.pathname.match(/^\/__app\/([^/]+)(\/.*)$/) ?? (url.hostname.endsWith(".workers.dev") ? [, url.host, url.pathname] : []);
    if (host) {
      const { worker, env } = await app(host.split(".")[0]);
      return worker.fetch(new Request(`https://${host}${rest}`, request), env, {});
    }
    const path = url.pathname.replace(/^.*?\/client\/v4/, "").replace(/^\/accounts\/[^/]+/, "");
    const multipart = request.headers.get("Content-Type")?.startsWith("multipart/");
    const form = multipart ? await request.formData() : undefined;
    const body: any = !multipart && request.body ? await request.json() : undefined;
    const script = path.match(/^\/workers\/scripts\/([^/?]+)/)?.[1];
    const ok = (result: unknown) => Response.json({ success: true, result, result_info: { total_pages: 1 } });
    const fail = (status: number, message: string) => Response.json({ success: false, errors: [{ message }] }, { status });
    const key = `${request.method} ${path}`;
    const serverId = path.match(/\/mcp\/servers\/([^/]+)/)?.[1];
    const appId = path.match(/^\/access\/apps\/([^/?]+)/)?.[1];

    if (request.headers.get("Authorization") !== "Bearer test-token") return fail(403, "bad token");
    if (script && !script.startsWith("runkle-app-")) return fail(400, "fake: runkle touched a Worker outside its prefix");
    if (script && form) {
      const meta = JSON.parse(await (form.get("metadata") as File).text());
      const kept = meta.keep_bindings?.includes("secret_text") ? scripts.get(script)?.secrets : {};
      const keptVars = meta.keep_bindings?.includes("plain_text") ? scripts.get(script)?.vars : {};
      const vars = Object.fromEntries(meta.bindings.filter((b: any) => b.type === "plain_text").map((b: any) => [b.name, b.text]));
      const modules: Record<string, string> = {};
      for (const [name, part] of form) if (name !== "metadata") modules[name] = await (part as File).text();
      if (!modules["app.js"].includes("export")) return fail(400, "Uncaught SyntaxError: no exports");
      const secrets = Object.fromEntries(meta.bindings.filter((b: any) => b.type === "secret_text").map((b: any) => [b.name, b.text]));
      const old = scripts.get(script);
      const versions = [...(old?.versions ?? []), modules];
      // A version upload is stored but not deployed: the old code keeps serving.
      if (path.endsWith("/versions")) return (old!.versions = versions), ok({ id: `v${versions.length - 1}` });
      const messages = [...(old?.messages ?? []), meta.annotations?.["workers/message"] ?? ""];
      scripts.set(script, { versions, deployed: versions.length - 1, flags: meta.compatibility_flags ?? [], modules, secrets: { ...kept, ...secrets }, vars: { ...keptVars, ...vars }, messages, data: old?.data ?? new Map(), schedules: old?.schedules ?? [] });
      return ok({ id: script });
    }
    if (script && key.endsWith("/versions")) return ok({ items: scripts.get(script)!.versions.map((_, n) => ({ id: `v${n}` })).reverse() });
    if (script && key.endsWith("/deployments")) return ok({ deployments: [{ versions: [{ version_id: `v${scripts.get(script)!.deployed}`, percentage: 100 }] }] });
    if (script && key.endsWith("/secrets") && request.method === "PUT" && scripts.get(script)!.deployed !== scripts.get(script)!.versions.length - 1)
      return fail(400, "Secret edit failed. The latest version of your Worker isn't currently deployed.");
    if (script && key.endsWith("/subdomain")) return ok({ enabled: true });
    if (script && key === `GET /workers/scripts/${script}/settings`) {
      const { secrets, vars } = scripts.get(script)!;
      return ok({ bindings: [...Object.keys(secrets).map((name) => ({ name, type: "secret_text" })), ...Object.entries(vars).map(([name, text]) => ({ name, type: "plain_text", text }))] });
    }
    if (script && key.endsWith("/secrets")) return (scripts.get(script)!.secrets[body.name] = body.text), ok({ name: body.name });
    const secret = path.match(/\/secrets\/([^/]+)$/)?.[1];
    if (script && secret && request.method === "DELETE") return secret in scripts.get(script)!.secrets ? (delete scripts.get(script)!.secrets[secret], ok(null)) : fail(404, "no such secret");
    if (script && key.endsWith("/schedules")) return (scripts.get(script)!.schedules = body), ok({ schedules: body });
    if (script && request.method === "DELETE") return scripts.delete(script), ok(null);
    const [, worker, version] = path.match(/^\/workers\/workers\/(runkle-app-[^/]+)\/versions\/v(\d+)$/) ?? [];
    if (worker)
      return ok({ modules: Object.entries(scripts.get(worker)!.versions[Number(version)]).map(([name, text]) => ({ name, content_base64: Buffer.from(text).toString("base64") })) });
    const workflow = path.match(/^\/workflows\/(runkle-app-[^/]+)$/)?.[1];
    if (workflow && request.method === "PUT") return workflows.set(workflow, body), ok(body);
    if (workflow && request.method === "DELETE") return workflows.delete(workflow) ? ok(null) : fail(404, "no such workflow");
    if (key === "GET /workers/subdomain") return ok({ subdomain: "acme" });
    if (key === "GET /access/apps") return ok([...apps.values()]);
    if (key === "POST /access/apps") {
      const app = { ...body, id: `app-${nextApp++}`, aud: `aud-${nextApp}` };
      apps.set(app.id, app);
      return ok(app);
    }
    if (appId && request.method === "PUT") return apps.set(appId, body), ok(body);
    if (appId && request.method === "DELETE") return apps.delete(appId), ok({ id: appId });
    const portalId = path.match(/^\/access\/ai-controls\/mcp\/portals\/([^/]+)$/)?.[1];
    const known = (mapping: any[]) => mapping.every((m: any) => servers.has(m.server_id));
    if (key === "GET /access/ai-controls/mcp/portals") return ok([...portals.values()].map(({ servers, ...p }) => p));
    if (key === "POST /access/ai-controls/mcp/portals") {
      if (portals.has(body.id) || [...portals.values()].some((p) => p.hostname === body.hostname)) return fail(409, "portal exists");
      if (!known(body.servers)) return fail(400, "unknown server in mapping");
      return portals.set(body.id, structuredClone(body)), ok(view(portals.get(body.id)));
    }
    if (portalId && !portals.has(portalId)) return fail(404, "no such portal");
    if (portalId && request.method === "GET") return ok(view(portals.get(portalId)));
    if (portalId && request.method === "PUT") {
      if (!known(body.servers)) return fail(400, "unknown server in mapping");
      Object.assign(portals.get(portalId), body);
      return ok(view(portals.get(portalId)));
    }
    if (portalId && request.method === "DELETE") return portals.delete(portalId), ok(null);
    if (key === "GET /zones") return ok(zones.filter((z) => z.name === url.searchParams.get("name") && z.account.id === url.searchParams.get("account.id")));
    const zone = path.match(/^\/zones\/([^/]+)\/dns_records/)?.[1];
    if (zone && zone !== "zone-1") return fail(404, "no such zone");
    if (zone && request.method === "GET") return ok([...dns.values()].filter((r) => r.name === url.searchParams.get("name")));
    if (zone && request.method === "POST") {
      const record = { ...body, id: `rec-${nextApp++}` };
      return dns.set(record.id, record), ok(record);
    }
    const recordId = path.match(/\/dns_records\/([^/]+)$/)?.[1];
    if (zone && recordId && request.method === "DELETE") return dns.delete(recordId) ? ok({ id: recordId }) : fail(404, "no such record");
    if (key === "POST /access/ai-controls/mcp/servers") {
      if (new URL(body.hostname).hostname === "down.example.com") return fail(400, "upstream unreachable");
      const { auth_credentials, client_secret, ...rest } = body;
      credentials.set(body.id, auth_credentials);
      servers.set(body.id, {
        ...rest,
        status: body.auth_type === "oauth" ? "waiting" : "ready",
        authentication_status: body.auth_type === "oauth" ? "required" : "not_required",
        last_successful_sync: "2026-11-13T08:00:00Z",
        tools:
          body.auth_type === "oauth"
            ? []
            : [
                { name: "search", description: "Search records by keyword." },
                { name: "delete_record", description: "Permanently delete a record." },
              ],
      });
      return ok(servers.get(body.id));
    }
    if (serverId && key.endsWith("/sync")) return ok(servers.get(serverId));
    if (serverId && request.method === "PUT") {
      const { auth_credentials, ...rest } = body;
      if (auth_credentials !== undefined) credentials.set(serverId, auth_credentials);
      return Object.assign(servers.get(serverId), rest), ok(servers.get(serverId));
    }
    if (serverId && request.method === "DELETE") return servers.delete(serverId), ok({ id: serverId });
    return fail(404, `no fake route for ${key}`);
  }

  latest = { inbox };
  return { handle, servers, apps, portal, portals, dns, scripts, credentials, workflows, app, pushes, inbox, inboxData };
}

if (import.meta.main) {
  const { createServer } = await import("node:http");
  const fake = fakeCloudflare();
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fake.handle(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
  }).listen(8799, () => console.log("fake Cloudflare API on http://localhost:8799"));
}
