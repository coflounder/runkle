// The entry module uploaded alongside every app. It turns the app module's
// exports into a Worker:
//
//   tools      MCP tools at /mcp (stateless streamable HTTP, JSON responses),
//              answered only for the portal's bearer token. A tool may declare
//              annotations and an output schema; a plain object it returns is
//              also sent as structuredContent; arguments its input schema does
//              not name are refused
//   skills     instructions for agents, served through a `skills` tool
//   schedules  cron handlers
//   webhooks   public HTTP handlers at /webhooks/<name>
//   pages      HTTP handlers at /pages/<name>, only behind Cloudflare Access
//   workflows  durable multi-step functions, run by Cloudflare Workflows
//   probe      an optional check that the app's secrets and upstream work,
//              run when runkle checks integrations (/manifest/probe)
//   vault      keeps a copy of a value runkle generated (generate_secret), at
//              /vault, answered only for a key runkle sets for that one call
//
// A tool that needs a person's approval (named in RUNKLE_ASK, or carrying an
// `approval` of its own) does not run when called. The call goes to runkle's
// inbox and the agent gets a link to it; the same call runs once after a person
// approves it there.
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
const vault = app.vault;

if (Object.keys(skills).length)
  tools.skills = {
    description:
      "Read one of this integration's skills (instructions for a task) by name. Available: " +
      Object.entries(skills).map(([name, s]) => name + (s.description ? " (" + s.description + ")" : "")).join("; "),
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
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

// ---- Approvals ----

// Tools the person running runkle wants to be asked about, by name; * matches anything.
function listed(env, name) {
  let asks = [];
  try { asks = JSON.parse(env.RUNKLE_ASK || "[]"); } catch {}
  return asks.some((p) => new RegExp("^" + p.split("*").map((s) => s.replace(/[.]/g, "[.]")).join(".*") + "$").test(name));
}
const gated = (env, name) => Boolean(listed(env, name) || tools[name].approval);

// The same JSON whatever order the keys came in, so a repeated call is recognised.
const canon = (v) =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v === undefined ? null : v);

// runkle's inbox, a Durable Object in runkle's own Worker. The app's code never holds this binding.
async function inbox(env, op, args) {
  const stub = env.RUNKLE_INBOX.get(env.RUNKLE_INBOX.idFromName("inbox"));
  return (await stub.fetch("https://inbox/", { method: "POST", body: JSON.stringify({ op, ui: env.RUNKLE_UI, ...args }) })).json();
}

// Returns nothing when the call may run, or what to tell the agent while a person decides.
// An approval covers one call of this tool with exactly these arguments.
async function gate(env, name, input, secrets, ctx) {
  const tool = tools[name];
  // A tool's own approval may be a function of the call: it returns what to show the person, or nothing to let the call through.
  const why = typeof tool.approval === "function" ? await tool.approval(input, secrets, ctx) : tool.approval;
  if (!why && !listed(env, name)) return;
  if (!env.RUNKLE_INBOX) throw new Error("This call needs the user's approval, but this integration was deployed before runkle had an inbox. Ask the user to update it in runkle.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.RUNKLE_APP + "\n" + name + "\n" + canon(input)));
  const id = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  const ask = await inbox(env, "ask", { id, app: env.RUNKLE_APP, tool: name, input, summary: typeof why === "string" ? why : "" });
  if (ask.state === "approved") return;
  if (ask.state === "denied") throw new Error("Denied by " + ask.by + ". Do not ask again unless the user tells you to.");
  return {
    waiting_for_approval: env.RUNKLE_UI + "/#" + new URLSearchParams({ inbox: id }),
    expires: new Date(ask.expires).toISOString(),
    next:
      "Not done: the user must approve this call first, in their runkle inbox. " +
      (ask.notified === undefined ? "They have not decided yet. " : ask.notified ? "They have been notified. " : "Give them the link. ") +
      "Call this tool again with exactly the same arguments: it runs once they have approved.",
  };
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

// Argument names the tool's input schema does not list, unless it allows any.
// A schema that lists no properties says nothing about names, so it allows any.
function unknownArgs(schema, args) {
  if (!schema || !schema.properties || schema.additionalProperties === true) return [];
  return Object.keys(args).filter((name) => !Object.hasOwn(schema.properties, name));
}
const isPlainObject = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));

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
        approvals: Object.keys(tools).filter((n) => gated(env, n)),
      });
    }

    // runkle's health check. The key is one runkle put in its inbox for this request alone.
    // Under /manifest, so an app whose pages sit behind Access still answers it.
    if (path === "/manifest/probe") {
      const key = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
      if (!key || !env.RUNKLE_INBOX || !(await inbox(env, "probe_check", { app: env.RUNKLE_APP, key })).ok) return new Response("Unauthorized", { status: 401 });
      if (typeof app.probe !== "function") return Response.json({ probed: false });
      try {
        await app.probe(secrets, ctx);
        return Response.json({ probed: true, ok: true });
      } catch (error) {
        return Response.json({ probed: true, ok: false, error: String((error && error.message) || error).slice(0, 300) });
      }
    }

    // runkle hands over a value it generated, to be kept in the app's vault. The
    // app's code receives it only as this call's argument, never in its env.
    if (path === "/vault") {
      if (!(await authorized(request, env.RUNKLE_SETUP))) return new Response("Unauthorized", { status: 401 });
      if (!vault || request.method !== "POST") return new Response("Not found", { status: 404 });
      const { vault: name, item, field, value } = await request.json();
      try {
        await vault.save({ vault: name, item, field, value }, secrets, ctx);
        return Response.json({ kept: true });
      } catch (error) {
        return Response.json({ error: String((error && error.message) || error) }, { status: 502 });
      }
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
            description: (t.description || "") + (gated(env, name) ? " May need the user's approval: the call then returns a link for them, and the same call runs once they approve." : ""),
            inputSchema: t.input || { type: "object" },
            ...(t.output && { outputSchema: t.output }),
            ...(t.annotations && { annotations: t.annotations }),
          })),
        });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        if (!Object.hasOwn(tools, name)) return fail(msg.id, -32602, "Unknown tool: " + name);
        const args = msg.params.arguments || {};
        const unknown = unknownArgs(tools[name].input, args);
        if (unknown.length) {
          const allowed = Object.keys(tools[name].input.properties);
          const text = "Unknown argument" + (unknown.length > 1 ? "s: " : ": ") + unknown.join(", ") + ". " + name + " takes " + (allowed.length ? allowed.join(", ") : "no arguments") + ".";
          return reply(msg.id, { content: [{ type: "text", text }], isError: true });
        }
        try {
          const waiting = await gate(env, name, args, secrets, ctx);
          if (waiting) return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(waiting) }] });
          const out = await tools[name].run(args, secrets, ctx);
          const text = typeof out === "string" ? out : JSON.stringify(out === undefined ? null : out);
          // Agents read a plain object as structured content instead of parsing the text.
          return reply(msg.id, { content: [{ type: "text", text }], ...(isPlainObject(out) && { structuredContent: JSON.parse(text) }) });
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
