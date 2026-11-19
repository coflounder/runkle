// Fastmail: mail, contacts and calendar for agents, through Fastmail's own MCP
// server (https://api.fastmail.com/mcp). This script stands in front of it so
// that reading, searching and drafting run freely and everything else asks the
// user first: sending, deleting, and creating or changing events and contacts.
//
// Secret: FASTMAIL_TOKEN, an API token of type MCP (Fastmail Settings > Privacy
// & Security > Manage API tokens) with the access levels you want agents to have.
//
// The tools are Fastmail's, so they are not listed here. `tools` reads the
// current list and `call` runs one.

const SERVER = "https://api.fastmail.com/mcp";
// What runs without asking. Anything else Fastmail offers, now or later, asks first.
const FREE = /^(search_|read_|list_)|^draft_email$/;

async function rpc(env, body, session) {
  const res = await fetch(SERVER, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.FASTMAIL_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(session && { "Mcp-Session-Id": session }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  if (!res.ok) throw new Error("Fastmail: HTTP " + res.status + (res.status === 401 ? " (check FASTMAIL_TOKEN)" : ""));
  if (body.id === undefined) return {};
  const text = await res.text();
  // The answer is plain JSON, or the last message of an event stream.
  const sent = (res.headers.get("Content-Type") || "").includes("text/event-stream") ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).filter((m) => m.id === body.id).pop() : JSON.parse(text);
  if (!sent || sent.error) throw new Error("Fastmail: " + ((sent && sent.error.message) || "no answer"));
  return { result: sent.result, session: res.headers.get("Mcp-Session-Id") || session };
}

// ponytail: a fresh MCP session per call, two extra requests; keep the session id in ctx.storage if that shows.
async function fastmail(env, method, params) {
  const { session } = await rpc(env, { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runkle", version: "1" } } });
  await rpc(env, { method: "notifications/initialized" }, session);
  return (await rpc(env, { id: 2, method, params }, session)).result;
}

const brief = (args) =>
  Object.entries(args || {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v))
    .map(([k, v]) => k + ": " + String(Array.isArray(v) ? v.map((x) => (x && x.email) || x).join(", ") : v).replace(/\s+/g, " ").slice(0, 80))
    .slice(0, 6)
    .join("; ");

export const tools = {
  tools: {
    description: "List what Fastmail can do here: each tool's name, description, input schema and whether it asks the user first. Read this before using call.",
    input: { type: "object", properties: { search: { type: "string", description: "Keep tools whose name or description contains this" } } },
    async run({ search }, env) {
      const q = String(search || "").toLowerCase();
      return (await fastmail(env, "tools/list", {})).tools
        .filter((t) => (t.name + " " + (t.description || "")).toLowerCase().includes(q))
        .map((t) => ({ name: t.name, description: t.description, input: t.inputSchema, asks_first: !FREE.test(t.name) }));
    },
  },
  call: {
    description:
      "Run one Fastmail tool by name with its arguments. Searching, reading, listing and drafting an email run at once. Everything else (sending, deleting, creating or changing events and contacts, moving mail) asks the user first.",
    input: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"] },
    approval: (input) => (FREE.test(String(input.tool)) ? undefined : `Fastmail: ${input.tool}. ${brief(input.arguments)}`),
    async run(input, env) {
      const result = await fastmail(env, "tools/call", { name: String(input.tool), arguments: input.arguments || {} });
      const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (result.isError) throw new Error(text || "Fastmail refused the call");
      return result.structuredContent || text;
    },
  },
};
