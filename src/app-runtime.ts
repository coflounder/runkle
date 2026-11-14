// The entry module uploaded alongside every app. It turns the app module's
// exports into a Worker:
//
//   tools      MCP tools at /mcp (stateless streamable HTTP, JSON responses),
//              answered only for the portal's bearer token
//   skills     instructions for agents, served through a `skills` tool
//   schedules  cron handlers
//   webhooks   public HTTP handlers at /webhooks/<name>
//   pages      HTTP handlers at /pages/<name>, only behind Cloudflare Access
//   workflows  durable multi-step functions, run by Cloudflare Workflows
//
// Handlers get the app's own secrets plus { storage, workflows }, and never
// runkle's own bindings (everything named RUNKLE_*).
//
// It is a string because it is deployed as its own Worker, not bundled into
// this one: uploaded scripts cannot import npm packages, so the MCP SDK is not
// available to them. Keep it free of backticks and template placeholders.
export const RUNTIME = String.raw`import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import * as app from "./app.js";

const tools = { ...app.tools };
const skills = app.skills || {};
const schedules = app.schedules || {};
const webhooks = app.webhooks || {};
const pages = app.pages || {};
const workflows = app.workflows || {};

if (Object.keys(skills).length)
  tools.skills = {
    description:
      "Read one of this integration's skills (instructions for a task) by name. Available: " +
      Object.entries(skills).map(([name, s]) => name + (s.description ? " (" + s.description + ")" : "")).join("; "),
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run({ name }) {
      if (!Object.hasOwn(skills, name)) throw new Error("Unknown skill: " + name);
      return skills[name].content;
    },
  };

export class Store extends DurableObject {
  get(key) { return this.ctx.storage.get(key); }
  put(key, value) { return this.ctx.storage.put(key, value); }
  delete(key) { return this.ctx.storage.delete(key); }
  async list(prefix) { return Object.fromEntries(await this.ctx.storage.list(prefix ? { prefix } : {})); }
}

// What every handler receives: [the app's secrets, { origin, storage, workflows }].
// origin is the app's own address, known only while answering a request.
function parts(env, origin) {
  const secrets = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("RUNKLE_")));
  const ctx = {
    origin,
    storage: env.RUNKLE_STORE.get(env.RUNKLE_STORE.idFromName("app")),
    workflows: {
      async start(name, input) {
        if (!Object.hasOwn(workflows, name)) throw new Error("Unknown workflow: " + name);
        return (await env.RUNKLE_FLOW.create({ params: { name, input } })).id;
      },
      async status(id) { return (await env.RUNKLE_FLOW.get(id)).status(); },
    },
  };
  return [secrets, ctx];
}

export class Flow extends WorkflowEntrypoint {
  run(event, step) {
    const { name, input } = event.payload;
    if (!Object.hasOwn(workflows, name)) throw new Error("Unknown workflow: " + name);
    return workflows[name](step, input, ...parts(this.env));
  }
}

const reply = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const respond = (out, type) =>
  out instanceof Response ? out
  : typeof out === "string" ? new Response(out, { headers: { "Content-Type": type } })
  : Response.json(out === undefined ? null : out);

// Compare SHA-256 digests so timing reveals nothing about the token.
async function authorized(request, token) {
  if (!token) return false;
  const enc = new TextEncoder();
  const given = request.headers.get("Authorization") || "";
  const [x, y] = (await Promise.all([given, "Bearer " + token].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))))).map((d) => new Uint8Array(d));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async scheduled(controller, env) {
    const [secrets, ctx] = parts(env);
    await Promise.all(Object.values(schedules).filter((s) => s.cron === controller.cron).map((s) => s.run(secrets, ctx)));
  },

  async fetch(request, env, execution) {
    const path = new URL(request.url).pathname;
    const [, area, name] = path.split("/");
    const [secrets, ctx] = parts(env, new URL(request.url).origin);

    // Webhooks are public: the handler must check the sender's signature itself.
    if (area === "webhooks" && Object.hasOwn(webhooks, name)) return respond(await webhooks[name](request, secrets, ctx), "text/plain");

    if (area === "pages" && Object.hasOwn(pages, name)) {
      // Fail closed unless Cloudflare Access let this request through for this app.
      const access = execution && execution.access;
      if (!env.RUNKLE_PAGES_AUD || !access || access.aud !== env.RUNKLE_PAGES_AUD) return new Response("Forbidden", { status: 403 });
      return respond(await pages[name](request, secrets, ctx), "text/html; charset=utf-8");
    }

    // runkle reads this once after each upload, with a key made for that upload.
    if (path === "/manifest") {
      if (!(await authorized(request, env.RUNKLE_SETUP))) return new Response("Unauthorized", { status: 401 });
      return Response.json({
        tools: Object.keys(tools),
        skills: Object.keys(skills),
        schedules: Object.fromEntries(Object.entries(schedules).map(([n, s]) => [n, String(s.cron)])),
        webhooks: Object.keys(webhooks),
        pages: Object.keys(pages),
        workflows: Object.keys(workflows),
      });
    }

    if (path !== "/mcp") return new Response("Not found", { status: 404 });
    if (!(await authorized(request, env.RUNKLE_TOKEN))) return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

    let msg;
    try {
      msg = await request.json();
    } catch {
      return fail(null, -32700, "Parse error");
    }
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notification

    switch (msg.method) {
      case "initialize":
        return reply(msg.id, {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "runkle-app", version: "1" },
        });
      case "ping":
        return reply(msg.id, {});
      case "tools/list":
        return reply(msg.id, {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description || "",
            inputSchema: t.input || { type: "object" },
          })),
        });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        if (!Object.hasOwn(tools, name)) return fail(msg.id, -32602, "Unknown tool: " + name);
        try {
          const out = await tools[name].run(msg.params.arguments || {}, secrets, ctx);
          const text = typeof out === "string" ? out : JSON.stringify(out === undefined ? null : out);
          return reply(msg.id, { content: [{ type: "text", text }] });
        } catch (error) {
          return reply(msg.id, { content: [{ type: "text", text: String((error && error.message) || error) }], isError: true });
        }
      }
      default:
        return fail(msg.id, -32601, "Method not found");
    }
  },
};
`;
