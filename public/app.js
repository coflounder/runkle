const $ = (id) => document.getElementById(id);
const DASHBOARD = "https://one.dash.cloudflare.com/?to=/:account/access/ai-controls/mcp-server-portal";

// Build DOM without innerHTML: tool names and descriptions come from upstream servers.
function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c) => c != null));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const showError = (error) => { $("banner").textContent = error.message; $("banner").hidden = false; };

// What a newly deployed app exports, with the addresses someone has to copy.
function showDeployed(made) {
  const lines = [
    made.tools?.length && `Tools: ${made.tools.join(", ")}`,
    ...Object.entries(made.schedules ?? {}).map(([name, cron]) => `Schedule ${name}: ${cron} (UTC)`),
    ...(made.webhooks ?? []).map((url) => `Webhook: ${url}`),
    ...(made.pages ?? []).map((url) => `Page: ${url}`),
    made.workflows?.length && `Workflows: ${made.workflows.join(", ")}`,
  ].filter(Boolean);
  $("notice").textContent = `Deployed ${made.id}.\n${lines.join("\n")}`;
  $("notice").hidden = !lines.length;
}

// Run a write, then reload. Disables the control meanwhile so it can't be sent twice.
async function act(control, fn) {
  control.disabled = true;
  $("banner").hidden = true;
  try { await fn(); await load(); } catch (error) { showError(error); await load().catch(() => {}); }
  control.disabled = false;
}

// ---- Secret fields: write-only, masked, wiped whenever their dialog closes ----

// With `onGenerate`, each row can instead have runkle generate its value, which
// nobody types or sees; `onGenerate` is told whether any row does.
function secretFields(container, onGenerate) {
  const rows = h("div", { className: "stack" });
  const add = h("button", { type: "button", textContent: "Add a secret" });
  const generating = () => [...rows.children].filter((r) => r.querySelector("[data-generate]")?.checked);
  const addRow = (name = "") => {
    const remove = h("button", { type: "button", textContent: "Remove", ariaLabel: "Remove this secret" });
    const value = h("input", { type: "password", placeholder: "value", ariaLabel: "Secret value", required: true, autocomplete: "new-password" });
    const generate = onGenerate && h("input", { type: "checkbox", title: "runkle makes a random value; nobody sees it" });
    if (generate) {
      generate.dataset.generate = "";
      generate.onchange = () => {
        Object.assign(value, { disabled: generate.checked, value: "", placeholder: generate.checked ? "runkle makes it" : "value" });
        onGenerate(generating().length > 0);
      };
    }
    const row = h("div", { className: generate ? "secret generate" : "secret" },
      h("input", { type: "text", placeholder: "NAME", ariaLabel: "Secret name", pattern: "[A-Z][A-Z0-9_]*", required: true, autocomplete: "off", spellcheck: false }),
      value,
      h("input", { type: "date", ariaLabel: "Expires on (optional)", title: "Expires on (optional): runkle warns you 14 days before" }),
      generate ? h("label", { className: "check" }, generate, "Generate") : null,
      remove);
    remove.onclick = () => { row.remove(); onGenerate?.(generating().length > 0); };
    rows.append(row);
    row.children[0].value = name;
    row.children[name ? 1 : 0].focus();
  };
  add.onclick = () => addRow();
  container.append(rows, h("div", {}, add));
  return {
    values: () => Object.fromEntries([...rows.children].filter((r) => !generating().includes(r)).map((r) => [r.children[0].value, r.children[1].value])),
    expires: () => Object.fromEntries([...rows.children].filter((r) => !generating().includes(r) && r.children[2].value).map((r) => [r.children[0].value, r.children[2].value])),
    generated: () => generating().map((r) => r.children[0].value),
    clear: () => { rows.replaceChildren(); onGenerate?.(false); },
    add: addRow,
  };
}

// Wire a dialog so that closing it by any route leaves no secret in the page.
// Returns the function that closes it. The wipe runs before close() rather than
// only on the "close" event, which browsers delay (and skip in hidden tabs).
function secretDialog(dialog, form, error, secrets) {
  const wipe = () => { form.reset(); secrets.clear(); error.hidden = true; };
  const close = () => { wipe(); dialog.close(); };
  dialog.addEventListener("close", wipe); // Esc key
  dialog.querySelector("[data-close]").onclick = close;
  return close;
}

async function submit(e, error, close, send) {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    const result = await send();
    close();
    await load();
    return result;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    e.submitter.disabled = false;
  }
}

// ---- Inbox: what waits for you ----

const KIND = { approval: "Approve a call", review: "Review a script change", secrets: "Enter secrets", setup: "Set up an integration", alert: "Alert" };
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
let state; // the last /api/state, so inbox links can open reviews and forms
let publicKey; // runkle's push key

function itemRow(item) {
  const buttons = [];
  if (item.kind === "approval") {
    const deny = h("button", { className: "danger", textContent: "Deny" });
    const approve = h("button", { className: "primary", textContent: "Approve" });
    deny.onclick = () => act(deny, () => api("POST", `/api/inbox/${item.id}`, { approve: false }));
    approve.onclick = () => act(approve, () => api("POST", `/api/inbox/${item.id}`, { approve: true }));
    buttons.push(deny, approve);
  } else {
    if (item.link) {
      const open = h("button", { className: "primary", textContent: item.kind === "review" ? "Review" : "Open" });
      // Only the hash is taken, so the link can only open a form on this page.
      open.onclick = () => (location.hash = new URL(item.link).hash);
      buttons.push(open);
    }
    if (item.kind !== "review") {
      const done = h("button", { textContent: "Done" });
      done.onclick = () => act(done, () => api("POST", `/api/inbox/${item.id}`, {}));
      buttons.push(done);
    }
  }
  const when = [KIND[item.kind], item.app, ago(item.created), item.expires && `expires in ${Math.max(0, Math.ceil((item.expires - Date.now()) / 60000))} min`];
  return h("div", { className: "row item", id: `x-${item.id}` },
    h("div", { className: "wrap" }, h("strong", {}, item.title), h("br"), h("small", {}, when.filter(Boolean).join(" · "))),
    item.detail ? h("p", { className: "muted wrap" }, item.detail) : null,
    item.kind === "approval" ? h("pre", { ariaLabel: "The call that would run" }, `${item.tool} ${JSON.stringify(item.input ?? {}, null, 2)}`) : null,
    h("div", { className: "actions" }, ...buttons));
}

async function loadInbox() {
  const box = await api("GET", "/api/inbox");
  publicKey = box.publicKey;
  $("waiting").replaceChildren(...(box.waiting.length ? box.waiting.map(itemRow) : [h("p", { className: "row muted" }, "Nothing is waiting for you.")]));
  $("decided").replaceChildren(...(box.decided.length
    ? box.decided.map((d) => h("p", { className: "row wrap" }, h("strong", {}, `${d.decision[0].toUpperCase()}${d.decision.slice(1)}`), ` by ${d.by}: ${d.title}`, h("br"), h("small", {}, new Date(d.at).toLocaleString())))
    : [h("p", { className: "row muted" }, "Nothing decided yet.")]));
  document.title = box.waiting.length ? `(${box.waiting.length}) runkle` : "runkle";
  navigator.setAppBadge?.(box.waiting.length).catch(() => {});
}

// Notifications are Web Push from runkle itself, through this page's service worker.
async function setupNotify() {
  const button = $("notify"), hint = $("notify-hint");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // iPhone and iPad only offer push to a web app opened from the Home Screen.
    if (/iPhone|iPad/.test(navigator.userAgent)) {
      hint.textContent = "For notifications on this device, add runkle to your Home Screen (Share, then Add to Home Screen) and open it from there.";
      hint.hidden = false;
    }
    return;
  }
  const worker = await navigator.serviceWorker.register("/sw.js");
  const show = (sub) => {
    button.textContent = sub ? "Stop notifying me" : "Notify me";
    button.title = sub ? "This device gets a notification when something needs you." : "Get a notification on this device when something needs you.";
    button.hidden = false;
  };
  const current = await worker.pushManager.getSubscription();
  // runkle may have forgotten this device (it unsubscribed elsewhere, say): remind it.
  if (current) await api("POST", "/api/push", { subscription: current.toJSON() }).catch(() => {});
  show(current);
  button.onclick = () =>
    act(button, async () => {
      const sub = await worker.pushManager.getSubscription();
      if (sub) {
        await api("DELETE", "/api/push", { endpoint: sub.endpoint });
        await sub.unsubscribe();
        return show(null);
      }
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const fresh = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api("POST", "/api/push", { subscription: fresh.toJSON() });
      await api("POST", "/api/push/test");
      show(fresh);
    });
}

// ---- Integrations ----

const STATUS = { ready: "Ready", waiting: "Waiting for sign-in", stale: "Needs sync", error: "Error" };
// What the last health check found (src/health.ts), by integration id.
const HEALTH = { ok: "Healthy", upstream_error: "Failing", needs_sign_in: "Needs sign-in", missing_secret: "Missing secret", expiring: "Secret expiring", unused_secret: "Unused secret" };
let health = {};

function integrationRow(i, open) {
  const status = (i.status || "waiting").toLowerCase().replace(/ .*/, "");
  const on = i.tools.filter((t) => t.enabled).length;
  const tools = i.tools.length
    ? i.tools.map((t) => {
        const box = h("input", { type: "checkbox", checked: t.enabled, id: `t-${i.id}-${t.name}` });
        box.onchange = () => act(box, () => api("PUT", `/api/integrations/${i.id}/tools`, { tool: t.name, enabled: box.checked }));
        return h("div", { className: "tool" }, box, h("label", { htmlFor: box.id }, h("code", {}, t.name)), h("small", {}, t.description || ""));
      })
    : [h("small", {}, i.auth_type === "oauth"
        ? (i.auth_mode === "manual"
            ? "Tools appear after the first person signs in to this integration from their agent."
            : "No tools yet. Open Admin sign-in, go to the MCP servers tab, select the three dots beside this server and choose Re-authenticate server. Then sync here.")
        : "No tools found yet. Try a sync.")];

  const sync = h("button", { textContent: "Sync tools" });
  sync.onclick = () => act(sync, () => api("POST", `/api/integrations/${i.id}/sync`));
  const edit = i.is_app ? h("button", { textContent: "Update script or secrets" }) : null;
  if (edit) edit.onclick = () => openApp(i);
  const review = i.pending_review ? h("button", { className: "primary", textContent: "Review proposed change" }) : null;
  if (review) review.onclick = () => openReview(i).catch(showError);
  const remove = h("button", { className: "danger", textContent: "Remove" });
  remove.onclick = () => {
    if (remove.dataset.armed) return act(remove, () => api("DELETE", `/api/integrations/${i.id}`));
    remove.dataset.armed = "1";
    remove.textContent = "Really remove?";
    setTimeout(() => { delete remove.dataset.armed; remove.textContent = "Remove"; }, 4000);
  };

  const checked = health[i.id];
  const expiry = (name) => (i.secret_expiry?.[name] ? `${name} (expires ${i.secret_expiry[name]})` : name);
  return h("details", { className: "row", open, id: `i-${i.id}` },
    h("summary", {},
      h("span", { className: "grow wrap" }, h("strong", {}, i.name), h("br"), h("small", {}, i.is_app ? "Runs on runkle" : i.url)),
      h("small", {}, i.tools.length ? `${on} of ${i.tools.length} tools on` : ""),
      checked ? h("span", { className: `badge ${checked.status === "ok" ? "ready" : checked.status === "unused_secret" ? "stale" : "error"}`, title: "At the last health check" }, HEALTH[checked.status]) : null,
      h("span", { className: `badge ${status}` }, STATUS[status] || i.status)),
    i.error ? h("p", { className: "error tools" }, i.error) : null,
    ...(checked?.problems ?? []).map((p) => h("p", { className: "tools wrap" }, h("strong", {}, p.reason), " ", h("small", {}, p.fix))),
    checked?.note ? h("p", { className: "muted tools" }, checked.note) : null,
    i.secrets_set?.length ? h("p", { className: "muted tools" }, `Secrets set: ${i.secrets_set.map(expiry).join(", ")}`, i.secrets_copied?.length ? `. Copy in 1Password: ${i.secrets_copied.join(", ")}` : "") : null,
    i.ask_first?.length ? h("p", { className: "muted tools" }, `Asks you first: ${i.ask_first.join(", ")}. Requests wait in the inbox.`) : null,
    h("div", { className: "tools" }, ...tools),
    h("div", { className: "actions" }, review, sync, edit,
      i.auth_type === "oauth" && i.auth_mode !== "manual" ? h("a", { className: "button", href: DASHBOARD, target: "_blank", rel: "noopener", textContent: "Admin sign-in ↗" }) : null,
      remove));
}

async function load() {
  const [s, , report] = await Promise.all([api("GET", "/api/state"), loadInbox(), api("GET", "/api/health")]);
  state = s;
  showHealth(report);
  const open = new Set([...document.querySelectorAll("#integrations details[open]")].map((d) => d.id));
  $("me").textContent = `${s.portal.name} · ${s.me}`;
  $("integrations").replaceChildren(...(s.integrations.length
    ? s.integrations.map((i) => integrationRow(i, open.has(`i-${i.id}`)))
    : [h("p", { className: "row muted" }, "Nothing connected yet. Add a remote MCP server or upload a script, and its tools show up here.")]));
  $("endpoint").value = s.endpoint;
  $("admin-endpoint").value = `${location.origin}/mcp`;
  $("snippet").textContent = `# Claude Code\nclaude mcp add --transport http runkle ${s.endpoint}\n\n# Anything else: add a remote (streamable HTTP) MCP server with this URL`;
  $("code-mode").value = s.portal.code_mode || "opt_in";
  const form = $("agent-auth"), a = s.agentAuth;
  $("auth-missing").hidden = Boolean(a);
  for (const el of form.elements) el.disabled = !a;
  if (a && !form.contains(document.activeElement)) {
    form.enabled.checked = a.enabled;
    form.allow_localhost.checked = a.allow_localhost;
    form.allow_loopback.checked = a.allow_loopback;
    form.allowed_uris.value = a.allowed_uris.join("\n");
  }
  return s;
}

for (const button of document.querySelectorAll("[data-copy]"))
  button.onclick = async () => {
    await navigator.clipboard.writeText($(button.dataset.copy).value);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };
function showHealth(report) {
  health = Object.fromEntries((report?.integrations ?? []).map((i) => [i.id, i]));
  $("checked").textContent = report?.checked_at ? `Last checked ${new Date(report.checked_at).toLocaleString()}. ${report.sign_in}` : "";
}
// Runs the same check as the daily one; problems also land in the inbox as alerts.
$("check").onclick = () =>
  act($("check"), async () => {
    const report = await api("POST", "/api/health");
    const problems = report.integrations.reduce((n, i) => n + i.problems.length, 0);
    $("notice").textContent = problems ? `${problems} problem${problems === 1 ? "" : "s"} found. Each is in your inbox and beside its integration.` : `All ${report.integrations.length} integrations look healthy.`;
    $("notice").hidden = false;
  });
$("code-mode").onchange = (e) => act(e.target, () => api("PUT", "/api/portal", { code_mode: e.target.value }));

$("agent-auth").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  act(e.submitter, () => api("PUT", "/api/agent-auth", {
    enabled: f.enabled.checked,
    allow_localhost: f.allow_localhost.checked,
    allow_loopback: f.allow_loopback.checked,
    allowed_uris: f.allowed_uris.value.split("\n").map((u) => u.trim()).filter(Boolean),
  }));
};

// ---- Add integration ----

const form = $("new");
const newSecrets = secretFields(form.querySelector("[data-secrets]"));
function showFields() {
  form.querySelectorAll("[data-kind]").forEach((el) => (el.hidden = el.dataset.kind !== form.kind.value));
  form.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== form.auth.value));
  form.url.required = form.kind.value === "server";
  form.file.required = form.kind.value === "app";
  form.skill_files.required = form.kind.value === "skills";
  if (form.kind.value !== "app") newSecrets.clear(); // hidden required fields would block the form
}
form.kind.onchange = form.auth.onchange = showFields;
const closeNew = secretDialog($("dialog"), form, $("form-error"), newSecrets);
$("add").onclick = () => { $("notice").hidden = true; showFields(); $("dialog").showModal(); };
form.onsubmit = async (e) => {
  const made = await submit(e, $("form-error"), closeNew, async () => {
    const name = form.elements.name.value;
    if (form.kind.value === "app") return api("POST", "/api/apps", { name, source: await form.file.files[0].text(), secrets: newSecrets.values(), expires: newSecrets.expires() });
    if (form.kind.value === "skills")
      return api("POST", "/api/skills", { name, skills: await Promise.all([...form.skill_files.files].map((f) => f.text())) });
    if (form.kind.value === "api")
      return api("POST", "/api/sources", {
        name,
        kind: form.format.value,
        url: form.api_url.value,
        spec: await form.spec.files[0]?.text(),
        base_url: form.base_url.value,
        filter: form.filter.value,
        auth: form.api_auth.value,
        auth_name: form.auth_name.value,
        token: form.api_token.value,
      });
    const { name: _, url, auth, token, client_id, client_secret, authorization_endpoint, token_endpoint, scope } = Object.fromEntries(new FormData(form));
    return api("POST", "/api/integrations", { name, url, auth, token, client_id, client_secret, authorization_endpoint, token_endpoint, scope });
  });
  if (made) showDeployed(made);
  const row = made && $(`i-${made.id}`);
  if (row) row.open = true;
};

// ---- Update an uploaded script ----

const appForm = $("app-form");
const appSecrets = secretFields(appForm.querySelector("[data-secrets]"), (any) => ($("keep").hidden = !any));
function openApp(i) {
  appForm.dataset.id = i.id;
  appForm.ask_first.value = appForm.dataset.ask = (i.ask_first || []).join("\n");
  $("h-app").textContent = `Update ${i.name}`;
  $("app-secrets").textContent = i.secrets_set?.length
    ? `Set: ${i.secrets_set.join(", ")}.${i.secrets_copied?.length ? ` Copy in 1Password: ${i.secrets_copied.join(", ")}.` : ""}`
    : "No secrets set yet.";
  // Apps that can be handed a copy hold secrets of their own, so their code is reviewed.
  const vaults = state.integrations.filter((x) => x.is_app && x.secrets_set?.length);
  appForm.keep_app.replaceChildren(h("option", { value: "", textContent: "Don't keep a copy" }), ...vaults.map((x) => h("option", { value: x.id, textContent: x.name })));
  appForm.keep_app.value = vaults.find((x) => /1-?password|onepassword/.test(x.id))?.id ?? "";
  $("app-dialog").showModal();
}
const closeApp = secretDialog($("app-dialog"), appForm, $("app-error"), appSecrets);
appForm.onsubmit = (e) =>
  submit(e, $("app-error"), closeApp, async () => {
    const id = appForm.dataset.id;
    const file = appForm.file.files[0];
    const ask = appForm.ask_first.value.trim();
    const typed = appSecrets.values(), generated = appSecrets.generated();
    const change = { ...(file && { source: await file.text() }), ...(ask !== appForm.dataset.ask && { ask_first: ask ? ask.split(/\s+/) : [] }) };
    const made = Object.keys(change).length || Object.keys(typed).length || !generated.length ? await api("PUT", `/api/apps/${id}`, { ...change, secrets: typed, expires: appSecrets.expires() }) : undefined;
    // One value per name, each in a field of that name.
    const keep = appForm.keep_app.value && { app: appForm.keep_app.value, vault: appForm.keep_vault.value, item: appForm.keep_item.value };
    for (const name of generated) await api("POST", "/api/generate", { targets: [{ app: id, secret: name }], ...(keep && { copy_to: { ...keep, field: name } }) });
    return made;
  }).then((made) => made?.id && showDeployed(made));

// ---- Review a change an agent proposed to a script that holds secrets ----

// Line diff by longest common subsequence.
// ponytail: O(lines squared) memory, fine for scripts of a few thousand lines; swap in Myers if one ever stalls.
function diffLines(a, b) {
  const n = a.length, m = b.length, w = m + 1, lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (j < m && (i === n || lcs[i * w + j + 1] > lcs[(i + 1) * w + j])) out.push(["+", b[j++]]);
    else out.push(["-", a[i++]]);
  }
  return out;
}

const reviewForm = $("review-form");
async function openReview(i) {
  const p = await api("GET", `/api/apps/${i.id}/proposal`);
  reviewForm.dataset.id = i.id;
  reviewForm.dataset.version = p.version;
  $("h-review").textContent = `Review change to ${i.name}`;
  $("review-error").hidden = true;
  // Only changed lines and three lines around each, like a patch.
  const lines = diffLines(p.current.split("\n"), p.proposed.split("\n"));
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - 3), k + 4).some(([mark]) => mark !== " "));
  $("review-diff").replaceChildren(...lines.flatMap(([mark, text], k) =>
    near[k] ? [h("span", { className: mark === "+" ? "add" : mark === "-" ? "del" : "", textContent: `${mark} ${text}` })]
    : near[k - 1] || k === 0 ? [h("span", { className: "muted", textContent: "  ⋯" })] : []));
  if (!near.includes(true)) $("review-diff").textContent = "The proposed source is identical to the deployed one.";
  $("review-dialog").showModal();
}
reviewForm.onsubmit = async (e) => {
  if (e.submitter.value === "close") return; // method="dialog" closes it
  e.preventDefault();
  for (const b of reviewForm.querySelectorAll("button")) b.disabled = true;
  try {
    const made = await api("POST", `/api/apps/${reviewForm.dataset.id}/proposal`, { version: reviewForm.dataset.version, approve: e.submitter.value === "approve" });
    $("review-dialog").close();
    if (e.submitter.value === "approve" && made.id) showDeployed(made);
  } catch (error) {
    $("review-error").textContent = error.message;
    $("review-error").hidden = false;
  }
  for (const b of reviewForm.querySelectorAll("button")) b.disabled = false;
  await load().catch(() => {});
};

// A link an agent handed over (see credentialLink and serverLink in src/ops.ts)
// opens the matching form. It can name fields but never carries a secret, and
// everything it sets is checked here: the address bar is not a trusted source.
function openFromLink() {
  const s = state;
  const link = new URLSearchParams(location.hash.slice(1));
  if (!location.hash) return;
  history.replaceState(null, "", location.pathname);
  if (link.has("inbox")) {
    const row = $(`x-${link.get("inbox")}`);
    if (link.get("inbox") && !row) showError(new Error("That request is no longer waiting. It may have been decided or have expired."));
    (row ?? $("inbox")).scrollIntoView({ block: "center" });
    row?.classList.add("flash");
    return;
  }
  const target = s.integrations.find((i) => i.is_app && i.id === link.get("secrets"));
  if (target) {
    openApp(target);
    for (const name of (link.get("names") || "").split(",")) if (/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) appSecrets.add(name);
  } else if (link.has("review")) {
    const waiting = s.integrations.find((i) => i.pending_review && i.id === link.get("review"));
    if (waiting) openReview(waiting).catch(showError);
    else showError(new Error("Nothing is waiting for review. It may already have been decided."));
  } else if (link.has("add")) {
    $("add").click();
    form.elements.name.value = link.get("name") || "";
    form.url.value = link.get("url") || "";
    if (["bearer", "oauth_manual"].includes(link.get("auth"))) form.auth.value = link.get("auth");
    showFields();
  }
}

load().then(openFromLink, (error) => {
  showError(error);
  $("integrations").replaceChildren(h("p", { className: "row muted" }, "Couldn't load integrations."));
});
// Inbox buttons and notification clicks change only the hash.
addEventListener("hashchange", () => load().then(openFromLink, showError));
// Keep the inbox current while the page is in view.
setInterval(() => document.visibilityState === "visible" && loadInbox().catch(() => {}), 30000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && loadInbox().catch(() => {}));
setupNotify().catch(showError);
