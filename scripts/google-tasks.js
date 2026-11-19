// Google Tasks: your task lists for agents. Google has no MCP server for Tasks,
// so this script talks to the Tasks API itself and signs in to Google once, on
// its own `connect` page, keeping the refresh token in its private storage.
//
// Secrets: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, from a Google Cloud OAuth
// client of type Web application with the Google Tasks API enabled. Add the
// address of this script's `callback` webhook (runkle shows it after the upload)
// as an authorised redirect URI. Then open the `connect` page and sign in.
//
// Reading, adding and changing tasks run freely: a change can be undone in
// Google Tasks. Deleting a task or a list asks first.

const API = "https://tasks.googleapis.com/tasks/v1";
const SCOPE = "https://www.googleapis.com/auth/tasks";
const STATE_TTL = 10 * 60 * 1000;

const redirect = (ctx) => ctx.origin + "/webhooks/callback";

async function token(env, ctx) {
  const cached = await ctx.storage.get("access");
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const refresh = await ctx.storage.get("refresh");
  if (!refresh) throw new Error("Google Tasks is not signed in yet. Ask the user to open this integration's connect page: " + ctx.origin + "/pages/connect");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google sign-in failed (" + (out.error || res.status) + "). Ask the user to sign in again at " + ctx.origin + "/pages/connect");
  await ctx.storage.put("access", { token: out.access_token, expires: Date.now() + out.expires_in * 1000 });
  return out.access_token;
}

async function tasks(env, ctx, method, path, body, query) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + (await token(env, ctx)), ...(body && { "Content-Type": "application/json" }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return null;
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google Tasks: " + ((out.error && out.error.message) || "HTTP " + res.status));
  return out;
}

const list = (id) => encodeURIComponent(id || "@default");
// Google wants an RFC 3339 timestamp for due; it keeps only the date.
const due = (d) => (d === undefined ? undefined : d === null || d === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T00:00:00.000Z" : d);
const slim = (t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due && t.due.slice(0, 10), status: t.status, completed: t.completed, parent: t.parent, updated: t.updated });
const tasklist = { type: "string", description: "Task list id from list_tasklists. Leave out for the default list." };

export const tools = {
  list_tasklists: {
    description: "List my Google Tasks lists, with their ids.",
    input: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(_, env, ctx) {
      const out = await tasks(env, ctx, "GET", "/users/@me/lists", null, { maxResults: 100 });
      return (out.items || []).map((l) => ({ id: l.id, title: l.title, updated: l.updated }));
    },
  },
  list_tasks: {
    description: "List tasks in one list. Open tasks only unless show_completed is true. due_min and due_max are dates (YYYY-MM-DD).",
    input: { type: "object", properties: { tasklist, show_completed: { type: "boolean" }, due_min: { type: "string" }, due_max: { type: "string" } } },
    annotations: { readOnlyHint: true },
    async run({ tasklist: id, show_completed = false, due_min, due_max }, env, ctx) {
      const found = [];
      let pageToken;
      do {
        const out = await tasks(env, ctx, "GET", `/lists/${list(id)}/tasks`, null, {
          maxResults: 100, showCompleted: show_completed, showHidden: show_completed, dueMin: due(due_min), dueMax: due_max && due_max + "T23:59:59.999Z", pageToken,
        });
        found.push(...(out.items || []).map(slim));
        pageToken = out.nextPageToken;
      } while (pageToken && found.length < 1000);
      return found;
    },
  },
  add_task: {
    description: "Add a task. due is a date (YYYY-MM-DD); Google Tasks keeps no time of day. parent makes it a subtask of that task.",
    input: { type: "object", properties: { tasklist, title: { type: "string" }, notes: { type: "string" }, due: { type: "string" }, parent: { type: "string" } }, required: ["title"] },
    async run({ tasklist: id, title, notes, due: d, parent }, env, ctx) {
      return slim(await tasks(env, ctx, "POST", `/lists/${list(id)}/tasks`, { title, notes, due: due(d) }, { parent }));
    },
  },
  update_task: {
    description: "Change a task: its title, notes or due date (empty string clears it), or mark it done or open again with completed.",
    input: { type: "object", properties: { tasklist, task: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, due: { type: "string" }, completed: { type: "boolean" } }, required: ["task"] },
    async run({ tasklist: id, task, title, notes, due: d, completed }, env, ctx) {
      const patch = { title, notes, due: due(d) };
      if (completed !== undefined) Object.assign(patch, completed ? { status: "completed" } : { status: "needsAction", completed: null });
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
      return slim(await tasks(env, ctx, "PATCH", `/lists/${list(id)}/tasks/${encodeURIComponent(task)}`, patch));
    },
  },
  delete_task: {
    description: "Delete a task. Asks the user first.",
    input: { type: "object", properties: { tasklist, task: { type: "string" }, title: { type: "string", description: "The task's title, shown to the user when they approve" } }, required: ["task"] },
    annotations: { destructiveHint: true },
    approval: ({ task, title }) => `Delete the Google task ${title ? `"${String(title).slice(0, 80)}"` : task}.`,
    async run({ tasklist: id, task }, env, ctx) {
      await tasks(env, ctx, "DELETE", `/lists/${list(id)}/tasks/${encodeURIComponent(task)}`);
      return "deleted";
    },
  },
  create_tasklist: {
    description: "Create a task list.",
    input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async run({ title }, env, ctx) {
      const l = await tasks(env, ctx, "POST", "/users/@me/lists", { title });
      return { id: l.id, title: l.title };
    },
  },
  delete_tasklist: {
    description: "Delete a task list and every task in it. Asks the user first.",
    input: { type: "object", properties: { tasklist: { type: "string" }, title: { type: "string", description: "The list's title, shown to the user when they approve" } }, required: ["tasklist"] },
    annotations: { destructiveHint: true },
    approval: ({ tasklist: id, title }) => `Delete the Google Tasks list ${title ? `"${String(title).slice(0, 80)}"` : id} and every task in it.`,
    async run({ tasklist: id }, env, ctx) {
      await tasks(env, ctx, "DELETE", `/users/@me/lists/${encodeURIComponent(id)}`);
      return "deleted";
    },
  },
};

const html = (body) => `<!doctype html><meta name="viewport" content="width=device-width"><title>Google Tasks</title><body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">${body}`;

// Behind Cloudflare Access: only people your portal allows can start a sign-in.
export const pages = {
  async connect(request, env, ctx) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return html("<p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in runkle first.</p>");
    const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.storage.put("state:" + state, Date.now());
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect(ctx), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state,
    });
    const signed = Boolean(await ctx.storage.get("refresh"));
    return html(`<h1>Google Tasks</h1><p>${signed ? "Signed in. Sign in again to switch accounts or renew access." : "Not signed in yet."}</p><p><a href="${url.replace(/&/g, "&amp;")}">Sign in with Google</a></p>`);
  },
};

// Public, as Google must reach it. Only a state this script's connect page made in the last ten minutes is accepted, once.
export const webhooks = {
  async callback(request, env, ctx) {
    const q = new URL(request.url).searchParams, state = q.get("state") || "";
    const made = /^[0-9a-f]{48}$/.test(state) && (await ctx.storage.get("state:" + state));
    if (made) await ctx.storage.delete("state:" + state);
    const page = (text, status = 200) => new Response(html(`<h1>Google Tasks</h1><p>${text}</p>`), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (!made || Date.now() - made > STATE_TTL) return page("This sign-in link expired. Open the connect page again.", 400);
    if (!q.get("code")) return page("Google did not sign you in. Open the connect page to try again.", 400);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirect(ctx), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.refresh_token) return page("Google refused the sign-in (" + String(out.error || res.status).replace(/[<>&"]/g, "") + "). Open the connect page to try again.", 400);
    await ctx.storage.put("refresh", out.refresh_token);
    await ctx.storage.put("access", { token: out.access_token, expires: Date.now() + out.expires_in * 1000 });
    return page("Signed in. You can close this page.");
  },
};

export const probe = async (env, ctx) => {
  await tasks(env, ctx, "GET", "/users/@me/lists", null, { maxResults: 1 });
};
