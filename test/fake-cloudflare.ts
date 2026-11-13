// An in-memory stand-in for the slice of the Cloudflare API runkle uses, with
// the portal's real "PUT replaces the mapping" behaviour. Run this file to
// serve it on :8799 for `wrangler dev` (see README, Development).

import { mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Uploaded apps import their base classes from the Workers runtime; give Node a stand-in.
const WORKERS = "data:text/javascript,class Base { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export { Base as DurableObject, Base as WorkflowEntrypoint };";
registerHooks({
  resolve: (specifier, context, next) => (specifier === "cloudflare:workers" ? { url: WORKERS, shortCircuit: true } : next(specifier, context)),
});

type Script = { modules: Record<string, string>; secrets: Record<string, string>; data: Map<string, unknown>; schedules: { cron: string }[]; mod?: any };

export function fakeCloudflare() {
  const servers = new Map<string, any>();
  const credentials = new Map<string, string>(); // what a real portal would send upstream
  const scripts = new Map<string, Script>();
  const workflows = new Map<string, any>();
  const runs: unknown[] = [];

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
    const storage = {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, v),
      delete: async (k: string) => data.delete(k),
      list: async ({ prefix = "" } = {}) => new Map([...data].filter(([k]) => k.startsWith(prefix))),
    };
    const env: any = { ...script.secrets };
    env.RUNKLE_STORE = { idFromName: (n: string) => n, get: () => new mod.Store({ storage }, env) };
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
  let nextApp = 1;

  const view = () => ({
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
    const [, host, rest] = url.pathname.match(/^\/__app\/([^/]+)(\/.*)$/) ?? (url.hostname.endsWith(".workers.dev") ? [, url.host, url.pathname] : []);
    if (host) {
      const { worker, env } = await app(host.split(".")[0]);
      return worker.fetch(new Request(`https://${host}${rest}`, request), env, {});
    }
    const path = url.pathname.replace(/^.*\/accounts\/[^/]+/, "");
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
      const modules: Record<string, string> = {};
      for (const [name, part] of form) if (name !== "metadata") modules[name] = await (part as File).text();
      if (!modules["app.js"].includes("export")) return fail(400, "Uncaught SyntaxError: no exports");
      const secrets = Object.fromEntries(meta.bindings.filter((b: any) => b.type === "secret_text").map((b: any) => [b.name, b.text]));
      const old = scripts.get(script);
      scripts.set(script, { modules, secrets: { ...kept, ...secrets }, data: old?.data ?? new Map(), schedules: old?.schedules ?? [] });
      return ok({ id: script });
    }
    if (script && key.endsWith("/subdomain")) return ok({ enabled: true });
    if (script && key === `GET /workers/scripts/${script}/secrets`) return ok(Object.keys(scripts.get(script)!.secrets).map((name) => ({ name, type: "secret_text" })));
    if (script && key.endsWith("/secrets")) return (scripts.get(script)!.secrets[body.name] = body.text), ok({ name: body.name });
    if (script && key.endsWith("/schedules")) return (scripts.get(script)!.schedules = body), ok({ schedules: body });
    if (script && request.method === "DELETE") return scripts.delete(script), ok(null);
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
    if (key === "GET /access/ai-controls/mcp/portals/main") return ok(view());
    if (key === "PUT /access/ai-controls/mcp/portals/main") {
      if (body.servers.some((m: any) => !servers.has(m.server_id))) return fail(400, "unknown server in mapping");
      Object.assign(portal, body);
      return ok(view());
    }
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
    if (serverId && request.method === "DELETE") return servers.delete(serverId), ok({ id: serverId });
    return fail(404, `no fake route for ${key}`);
  }

  return { handle, servers, apps, portal, scripts, credentials, workflows, app };
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
