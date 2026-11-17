// Cloudflare Tokens: an agent asks for an API token, a person approves it on
// their phone, and the value goes to a Worker secret or is shown once in the
// person's browser. No tool ever returns a token value.
//
// Secrets: MINTER_TOKEN (Account API Tokens Write), ACCOUNT_ID.
// The minter can grant any permission, so the rules below are the whole fence.

// Every mint waits for approval. Set to true to let a token through unasked when it is
// read-only, lasts an hour or less and goes to a secret on one of runkle's own scripts.
// Off because such a script's code can hand the token to the agent that wrote it.
const SKIP_APPROVAL_FOR_SHORT_READ_ONLY = false;

const API = "https://api.cloudflare.com/client/v4";
const PREFIX = "runkle: ";
const MAX_MINUTES = 90 * 24 * 60;
// Never granted: anything that could mint tokens, add members or spend money.
const DENIED = /token|member|billing|sso|scim/i;
const ACCOUNT = "com.cloudflare.api.account";
const ZONE = "com.cloudflare.api.account.zone";

async function cf(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.success) throw new Error("Cloudflare: " + ((json && json.errors || []).map((e) => e.message).join("; ") || "HTTP " + res.status));
  return json.result;
}

const groups = (env) => cf(env.MINTER_TOKEN, "GET", `/accounts/${env.ACCOUNT_ID}/tokens/permission_groups`);
const expiry = (minutes) => new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19) + "Z";

// Checks a request against the rules and returns it in stored form.
async function checked(input, env) {
  const purpose = String(input.purpose || "").trim().slice(0, 80);
  if (!purpose) throw new Error("Say what the token is for in purpose");
  const minutes = Number(input.minutes);
  if (!(minutes >= 1 && minutes <= MAX_MINUTES)) throw new Error(`minutes must be between 1 and ${MAX_MINUTES} (90 days)`);
  const names = [...new Set(input.permissions || [])];
  if (!names.length) throw new Error("Name at least one permission");
  const all = await groups(env);
  const permissions = names.map((name) => {
    const group = all.find((g) => g.name === name);
    if (!group) throw new Error(`Unknown permission "${name}". Use the permissions tool to search the exact names.`);
    if (DENIED.test(name)) throw new Error(`"${name}" can never be granted here`);
    const scope = group.scopes.includes(ACCOUNT) ? ACCOUNT : group.scopes.includes(ZONE) ? ZONE : null;
    if (!scope) throw new Error(`"${name}" applies to a kind of resource this script does not handle`);
    return { id: group.id, name, scope };
  });
  const { worker, secret } = input;
  if (Boolean(worker) !== Boolean(secret)) throw new Error("Give both worker and secret, or neither to show the token in the browser");
  if (worker && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(worker)) throw new Error("worker is not a valid Worker name");
  if (secret && !/^[A-Z][A-Z0-9_]{0,63}$/.test(secret)) throw new Error("secret must look like MY_TOKEN");
  return { purpose, minutes, permissions, ...(worker && { worker, secret }) };
}

// ponytail: zone permissions cover every zone in the account; add per-zone scoping when a token should see only one.
function policies(acct, permissions) {
  const of = (scope) => permissions.filter((p) => p.scope === scope).map((p) => ({ id: p.id }));
  const account = `${ACCOUNT}.${acct}`;
  return [
    { effect: "allow", resources: { [account]: "*" }, permission_groups: of(ACCOUNT) },
    { effect: "allow", resources: { [account]: { [ZONE + ".*"]: "*" } }, permission_groups: of(ZONE) },
  ].filter((p) => p.permission_groups.length);
}

// Mints the token and sends its value where it was asked for. Returns the value
// only for the browser; a delivered token's value is dropped here.
async function mint(r, env, ctx) {
  const acct = env.ACCOUNT_ID, tokens = `/accounts/${acct}/tokens`;
  const made = await cf(env.MINTER_TOKEN, "POST", tokens, { name: PREFIX + r.purpose, policies: policies(acct, r.permissions), expires_on: expiry(r.minutes) });
  const record = { token: made.id, purpose: r.purpose, permissions: r.permissions.map((p) => p.name), expires: made.expires_on, to: r.worker ? `${r.worker} secret ${r.secret}` : "shown in browser" };
  try {
    if (r.worker) {
      // A second token that can only write Worker secrets, for the minutes this takes.
      const write = (await groups(env)).find((g) => g.name === "Workers Scripts Write");
      const courier = await cf(env.MINTER_TOKEN, "POST", tokens, { name: PREFIX + "delivery (temporary)", policies: policies(acct, [{ id: write.id, scope: ACCOUNT }]), expires_on: expiry(5) });
      try {
        await cf(courier.value, "PUT", `/accounts/${acct}/workers/scripts/${r.worker}/secrets`, { name: r.secret, text: made.value, type: "secret_text" });
      } finally {
        await cf(env.MINTER_TOKEN, "DELETE", `${tokens}/${courier.id}`).catch(() => {});
      }
    }
  } catch (error) {
    await cf(env.MINTER_TOKEN, "DELETE", `${tokens}/${made.id}`).catch(() => {}); // undelivered: nobody has it
    throw error;
  }
  await ctx.storage.put("log:" + new Date().toISOString(), record);
  return { record, value: r.worker ? undefined : made.value };
}

const life = (m) => (m >= 2880 ? Math.round(m / 1440) + " days" : m >= 120 ? Math.round(m / 60) + " hours" : m + " minutes");
const unasked = (r) => SKIP_APPROVAL_FOR_SHORT_READ_ONLY && r.minutes <= 60 && r.permissions.every((p) => / Read$/.test(p.name)) && Boolean(r.worker) && r.worker.startsWith("runkle-app-");

export const tools = {
  permissions: {
    description: "Search the exact names of Cloudflare permissions a token can be given, e.g. search \"dns\".",
    input: { type: "object", properties: { search: { type: "string" } }, required: ["search"] },
    async run({ search }, env) {
      const q = String(search || "").toLowerCase();
      return (await groups(env)).filter((g) => g.name.toLowerCase().includes(q) && !DENIED.test(g.name) && (g.scopes.includes(ACCOUNT) || g.scopes.includes(ZONE))).map((g) => g.name).slice(0, 60);
    },
  },
  request: {
    description:
      "Mint a Cloudflare API token. You never receive its value. With worker and secret it is stored as that secret on that Worker; without them you get a link where the user sees it once.",
    input: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "Shown to the user and used as the token's name" },
        permissions: { type: "array", items: { type: "string" }, description: "Exact names from the permissions tool" },
        minutes: { type: "number", description: "How long the token lasts, up to 129600 (90 days)" },
        worker: { type: "string", description: "Worker to store the token on" },
        secret: { type: "string", description: "Secret name on that Worker, like CLOUDFLARE_API_TOKEN" },
      },
      required: ["purpose", "permissions", "minutes"],
    },
    // What the person reads before approving. A request that breaks the rules fails here, before anyone is asked.
    async approval(input, env) {
      const r = await checked(input, env);
      if (unasked(r)) return;
      const can = r.permissions.map((p) => p.name + (p.scope === ZONE ? " (every zone)" : "")).join(", ");
      return `Mint a Cloudflare token for "${r.purpose}", lasting ${life(r.minutes)}. It can: ${can}. It goes to ${r.worker ? `secret ${r.secret} on Worker ${r.worker}; nobody sees it` : "your browser, shown once"}.`;
    },
    async run(input, env, ctx) {
      const r = await checked(input, env);
      if (r.worker) return { done: (await mint(r, env, ctx)).record };
      // Approved, but only the person may see the value: it is minted when they open this page.
      const id = crypto.randomUUID();
      await ctx.storage.put("show:" + id, { ...r, until: Date.now() + 15 * 60000 });
      return { show_to_user: `${ctx.origin}/pages/show?id=${id}`, next: "Give the user this link. The token is minted when they open it, within 15 minutes, and only they see it." };
    },
  },
  list: {
    description: "Tokens this script has minted that still exist, and the last 20 it minted. Never includes a token value.",
    input: { type: "object" },
    async run(_, env, ctx) {
      const live = (await cf(env.MINTER_TOKEN, "GET", `/accounts/${env.ACCOUNT_ID}/tokens?per_page=50`)).filter((t) => t.name.startsWith(PREFIX));
      return {
        tokens: live.map((t) => ({ id: t.id, name: t.name, status: t.status, expires: t.expires_on })),
        log: Object.values(await ctx.storage.list("log:")).slice(-20),
      };
    },
  },
  revoke: {
    description: "Delete a token this script minted, by id from list. Tokens made elsewhere cannot be touched.",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run({ id }, env) {
      const path = `/accounts/${env.ACCOUNT_ID}/tokens/${encodeURIComponent(id)}`;
      if (!(await cf(env.MINTER_TOKEN, "GET", path)).name.startsWith(PREFIX)) throw new Error("Not a token minted here");
      await cf(env.MINTER_TOKEN, "DELETE", path);
      return { revoked: id };
    },
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const html = (body, status = 200) =>
  new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare token</title>
<style>body{font:17px/1.5 system-ui;max-width:36rem;margin:1.5rem auto;padding:0 1rem;color-scheme:light dark}input{width:100%;font:14px ui-monospace,monospace;padding:.5rem}button{font:inherit;font-weight:600;min-height:3.25rem;width:100%}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export const pages = {
  // Where an approved token with no Worker to go to is minted and shown, once.
  async show(request, env, ctx) {
    const url = new URL(request.url), key = "show:" + url.searchParams.get("id");
    const r = await ctx.storage.get(key);
    if (!r || r.until < Date.now()) return html("<h1>Nothing to show</h1><p>This token was already shown, or the link has expired. Ask the agent to request it again.</p>", 404);
    if (request.method !== "POST")
      return html(`<h1>Token ready to mint</h1><p>For: ${esc(r.purpose)}. You approved this. It is minted when you press the button and shown once.</p><form method="post"><button>Mint and show</button></form>`);
    // Access signs the browser in by cookie, so only act for this page's own form.
    if (request.headers.get("Origin") !== url.origin) return html("<h1>Refused</h1>", 403);
    await ctx.storage.delete(key); // once, whatever happens next
    try {
      const { record, value } = await mint(r, env, ctx);
      return html(`<h1>Token minted</h1><p>Copy it now. It is not stored anywhere and cannot be shown again. It expires ${esc(record.expires)}.</p><input readonly aria-label="Token" value="${esc(value)}" onfocus="this.select()">`);
    } catch (error) {
      return html(`<h1>Could not mint</h1><p>${esc(error.message)}</p><p>Ask the agent to request it again.</p>`, 502);
    }
  },
};
