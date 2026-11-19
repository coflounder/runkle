import { createRemoteJWKSet, jwtVerify } from "jose";
import { UpstreamError, type Env } from "./cloudflare.ts";
import { InputError, serverBody } from "./mapping.ts";
import * as ops from "./ops.ts";

export { Inbox } from "./inbox.ts";

// Responses can describe which credentials exist; never let anything cache them.
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function signedInEmail(request: Request, env: Env): Promise<string | null> {
  if (env.AUTH_DISABLED === "true") return "dev@localhost";
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null; // fail closed when unconfigured
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!jwks.has(issuer)) jwks.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  try {
    const { payload } = await jwtVerify(token, jwks.get(issuer)!, { issuer, audience: env.ACCESS_AUD });
    return (payload.email as string) ?? (payload.sub as string) ?? "service";
  } catch {
    return null;
  }
}

// Returns the matched handler, or undefined when no route matches.
function route(request: Request, env: Env, me: string): (() => Promise<unknown>) | undefined {
  const { pathname, origin: ui } = new URL(request.url);
  const key = `${request.method} ${pathname}`;
  const body = () => request.json().catch(() => ({})) as Promise<any>;
  const id = pathname.match(/^\/api\/(?:integrations|apps)\/([a-z0-9-]{1,32})(?:\/|$)/)?.[1];
  const item = pathname.match(/^\/api\/inbox\/([a-z0-9:-]{1,128})$/)?.[1];
  const collection = pathname.match(/^\/api\/collections\/([a-z0-9-]{1,24})$/)?.[1];

  if (key === "GET /api/state") return () => ops.state(env, me);
  if (key === "POST /api/integrations") return async () => ops.registerServer(env, serverBody(await body()));
  if (key === "POST /api/apps") return async () => ops.newApp(env, ui, await body());
  if (key === "POST /api/sources") return async () => ops.newSource(env, ui, await body());
  if (key === "POST /api/skills") return async () => ops.newSkills(env, ui, await body());
  if (key === "PUT /api/agent-auth") return async () => ops.setAgentAuth(env, await body());
  if (key === "PUT /api/portal") return async () => ops.setCodeMode(env, await body());
  if (key === "POST /api/collections") return async () => ops.createCollection(env, await body());
  if (collection && key === `PUT /api/collections/${collection}`) return async () => ops.setCollection(env, collection, await body());
  if (collection && key === `DELETE /api/collections/${collection}`) return () => ops.deleteCollection(env, collection);
  if (id && key === `PUT /api/apps/${id}`) return async () => ops.changeApp(env, ui, id, await body());
  // A person generating a secret from the UI is the approval; an agent's generate_secret waits in the inbox.
  if (key === "POST /api/generate") return async () => ops.generateSecret(env, ui, await body(), me);
  // Deciding on an agent's proposed change is for people only: there is no MCP tool for it.
  if (id && key === `GET /api/apps/${id}/proposal`) return () => ops.reviewChange(env, id);
  if (id && key === `POST /api/apps/${id}/proposal`) return async () => ops.decideChange(env, ui, id, await body(), me);
  // The inbox decides for a person, so like reviews it has no MCP tool.
  if (key === "GET /api/inbox") return () => ops.inboxList(env);
  if (item && key === `POST /api/inbox/${item}`) return async () => ops.inboxDecide(env, item, await body(), me);
  if (key === "POST /api/push") return async () => ops.subscribe(env, await body(), me, ui);
  if (key === "DELETE /api/push") return async () => ops.unsubscribe(env, await body());
  if (key === "POST /api/push/test") return () => ops.testPush(env, ui);
  if (key === "GET /api/health") return () => ops.lastHealth(env);
  if (key === "POST /api/health") return () => ops.checkAndAlert(env, ui);
  if (id && key === `DELETE /api/integrations/${id}`) return () => ops.removeIntegration(env, id);
  if (id && key === `POST /api/integrations/${id}/sync`) return () => ops.syncServer(env, id);
  if (id && key === `PUT /api/integrations/${id}/tools`) return async () => ops.toggleTool(env, id, await body());
}

export default {
  // Daily (wrangler.jsonc): check every integration and alert the person about problems.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ops.checkAndAlert(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const me = await signedInEmail(request, env);
    if (!me) return json({ error: "Not signed in through Cloudflare Access" }, 401);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/mcp") {
      // Agents are not browsers and send no Origin; a browser on another site always does.
      if (origin && origin !== url.origin) return json({ error: "Cross-origin request refused" }, 403);
      // Loaded on demand: the MCP SDK only runs on Workers, and the tests run on Node.
      return (await import("./mcp.ts")).serveMcp(request, env, ctx);
    }

    // Access signs browsers in by cookie, so only accept writes sent by our own page.
    if (request.method !== "GET" && origin !== url.origin) return json({ error: "Cross-origin request refused" }, 403);
    try {
      const handler = route(request, env, me);
      if (!handler) return json({ error: "Not found" }, 404);
      return json((await handler()) ?? { ok: true });
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, 400);
      if (error instanceof UpstreamError) return json({ error: error.message }, 502);
      throw error;
    }
  },
};
