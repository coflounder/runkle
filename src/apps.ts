// Apps: uploaded scripts, API sources and skill packs. Each one is deployed as
// its own Worker named `runkle-app-<id>` and registered with the portal like
// any other MCP server. runkle never touches a Worker outside that prefix.

import { RUNTIME } from "./app-runtime.ts";
import { appFetch, cf, UpstreamError, type Env } from "./cloudflare.ts";
import { appSecrets, appSource, askFirst, InputError, required, slug } from "./mapping.ts";

export const scriptName = (id: string) => `runkle-app-${id}`;
// runkle's own Worker, as named in wrangler.jsonc: apps reach its inbox through a binding to it.
const RUNKLE_WORKER = "runkle";
const scriptPath = (id: string) => `/workers/scripts/${scriptName(id)}`;
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isApp = (server: { id: string; hostname?: string }) =>
  Boolean(server.hostname?.startsWith(`https://${scriptName(server.id)}.`));

// Secrets go to Cloudflare as write-only `secret_text` bindings. With `keep`,
// secrets and the ask-first list already on the Worker survive and the ones
// given here replace theirs. With `pending`, Cloudflare stores the upload as a
// version and keeps serving the old one. `message` is kept in the Worker's
// version history, which is where decisions on proposals are logged.
// Every app gets runkle's inbox, its own id and runkle's address, for tools that ask first.
type Upload = { keep?: boolean; pending?: boolean; ask?: string[]; message?: string; ui: string };
function upload(env: Env, id: string, source: string, secrets: Record<string, string>, { keep, pending, ask, message, ui }: Upload) {
  const form = new FormData();
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-11-01",
    // Same reason as runkle's own flag: without it, an app that fetches another
    // Worker on this workers.dev subdomain (Access Check opening a Workers
    // Preview, say) gets Cloudflare error 1042 instead of the page.
    compatibility_flags: ["global_fetch_strictly_public"],
    ...(!pending && { observability: { enabled: true } }),
    ...(message && { annotations: { "workers/message": message.slice(0, 100) } }),
    exports: { Store: { type: "durable-object", state: "created", storage: "sqlite" } },
    bindings: [
      ...Object.entries(secrets).map(([name, text]) => ({ type: "secret_text", name, text })),
      ...(ask ? [{ type: "plain_text", name: "RUNKLE_ASK", text: JSON.stringify(ask) }] : []),
      { type: "plain_text", name: "RUNKLE_APP", text: id },
      { type: "plain_text", name: "RUNKLE_UI", text: ui },
      { type: "durable_object_namespace", name: "RUNKLE_STORE", class_name: "Store" },
      { type: "durable_object_namespace", name: "RUNKLE_INBOX", class_name: "Inbox", script_name: RUNKLE_WORKER },
      { type: "workflow", name: "RUNKLE_FLOW", workflow_name: scriptName(id), class_name: "Flow" },
    ],
    ...(keep && { keep_bindings: ["secret_text", "plain_text"] }),
  };
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("index.js", new File([RUNTIME], "index.js", { type: "application/javascript+module" }));
  form.set("app.js", new File([source], "app.js", { type: "application/javascript+module" }));
  return pending ? cf(env, "POST", `${scriptPath(id)}/versions`, form) : cf(env, "PUT", scriptPath(id), form);
}

// Ask the freshly uploaded app what it exports, then set up its cron triggers
// and workflow. `setup` was set on this upload only, so an answer proves the
// new version is the one serving.
async function configure(env: Env, id: string, host: string, setup: string) {
  let manifest: any;
  for (let attempt = 1; !manifest; attempt++) {
    // No redirects: one would be Cloudflare Access standing in front of the app.
    const res = await appFetch(env, host, "/manifest", { headers: { Authorization: `Bearer ${setup}` }, redirect: "manual" }).catch(() => null);
    if (res?.ok) manifest = await res.json();
    else if (attempt === 5) throw new UpstreamError(`The script was uploaded but is not answering${res ? ` (HTTP ${res.status})` : ""}`);
    else await sleep(2000);
  }
  // Always sent, so a schedule removed from the script stops firing.
  await cf(env, "PUT", `${scriptPath(id)}/schedules`, [...new Set(Object.values<string>(manifest.schedules))].map((cron) => ({ cron })));
  if (manifest.workflows.length) await cf(env, "PUT", `/workflows/${scriptName(id)}`, { class_name: "Flow", script_name: scriptName(id) });
  return manifest;
}

export type Deps = {
  exists: (id: string) => Promise<boolean>;
  register: (body: Record<string, unknown> & { id: string; name: string; auth_type: string }) => Promise<unknown>;
  // Puts Cloudflare Access in front of the app's pages and returns its audience tag.
  pagesAud: (id: string, host: string) => Promise<string>;
  ui: string; // runkle's own address, for links to its UI
  inbox: (op: string, args?: Record<string, unknown>) => Promise<any>;
};

async function finish(env: Env, id: string, host: string, manifest: any, deps: Deps) {
  if (manifest.pages.length)
    await cf(env, "PUT", `${scriptPath(id)}/secrets`, { name: "RUNKLE_PAGES_AUD", text: await deps.pagesAud(id, host), type: "secret_text" });
  const urls = (area: string, names: string[]) => names.map((name) => `https://${host}/${area}/${name}`);
  return { id, ...manifest, webhooks: urls("webhooks", manifest.webhooks), pages: urls("pages", manifest.pages) };
}

export async function createApp(env: Env, input: any, deps: Deps) {
  const name = required(input.name, "Name");
  const id = slug(name);
  if (!id) throw new InputError("Name needs at least one letter or digit");
  const source = appSource(input.source);
  const secrets = appSecrets(input.secrets);
  const ask = input.ask_first == null ? undefined : askFirst(input.ask_first);
  if (await deps.exists(id)) throw new InputError(`"${id}" already exists`);

  // Only the portal may call the app. The token is generated here, handed to
  // Cloudflare on both sides, and never stored or shown by runkle.
  const token = randomKey();
  const setup = randomKey();
  await upload(env, id, source, { ...secrets, RUNKLE_TOKEN: token, RUNKLE_SETUP: setup }, { ask, ui: deps.ui });
  let host: string, manifest: any;
  try {
    await cf(env, "POST", `${scriptPath(id)}/subdomain`, { enabled: true, previews_enabled: false });
    host = `${scriptName(id)}.${(await cf(env, "GET", "/workers/subdomain")).subdomain}.workers.dev`;
    manifest = await configure(env, id, host, setup);
    await deps.register({ id, name, hostname: `https://${host}/mcp`, auth_type: "bearer", auth_credentials: token });
  } catch (error) {
    await deleteApp(env, id).catch(() => {});
    throw error;
  }
  return finish(env, id, host, manifest, deps);
}

export async function updateApp(env: Env, server: { id: string; hostname?: string } | undefined, input: any, deps: Deps) {
  if (!server || !isApp(server)) throw new InputError("Not an uploaded script");
  const secrets = appSecrets(input.secrets);
  const ask = input.ask_first == null ? undefined : askFirst(input.ask_first);
  if (input.source != null || ask) {
    const setup = randomKey();
    const host = new URL(server.hostname!).host;
    // ponytail: changing only the ask-first list uploads the running source again, because that path is
    // already proven to keep secrets. PATCH .../settings would avoid the redeploy if this gets slow.
    let source = input.source;
    if (source == null) {
      const v = await versions(env, server.id);
      if (v.latest !== v.deployed) throw new InputError("A script change is waiting for review. Approve or reject it first.");
      source = await sourceOf(env, server.id, v.deployed);
    }
    await upload(env, server.id, appSource(source), { ...secrets, RUNKLE_SETUP: setup }, { keep: true, ask, message: input.message, ui: deps.ui });
    const manifest = await configure(env, server.id, host, setup);
    await cf(env, "POST", `/access/ai-controls/mcp/servers/${server.id}/sync`);
    return finish(env, server.id, host, manifest, deps);
  }
  if (!Object.keys(secrets).length) throw new InputError("Nothing to update");
  for (const [name, text] of Object.entries(secrets))
    await cf(env, "PUT", `${scriptPath(server.id)}/secrets`, { name, text, type: "secret_text" }).catch((error) => {
      // Cloudflare refuses secret edits while the newest version is not the deployed one.
      throw /isn't currently deployed/.test(error.message) ? new InputError("A script change is waiting for review. Approve or reject it first.") : error;
    });
}

// ---- Review: an agent's change to a script that holds secrets ----
//
// New code would run with the script's secrets and could hand them to the
// agent, so it waits for a person. The proposal is a Worker version that was
// uploaded but not deployed: Cloudflare stores it, and it serves nothing
// (version preview URLs are off).

async function versions(env: Env, id: string) {
  const [all, live] = await Promise.all([cf(env, "GET", `${scriptPath(id)}/versions`), cf(env, "GET", `${scriptPath(id)}/deployments`)]);
  return { latest: all.items[0]?.id as string, deployed: live.deployments[0]?.versions[0]?.version_id as string };
}

export const pendingReview = async (env: Env, id: string) => {
  const v = await versions(env, id);
  return v.latest !== v.deployed;
};

async function sourceOf(env: Env, id: string, version: string): Promise<string> {
  const { modules } = await cf(env, "GET", `/workers/workers/${scriptName(id)}/versions/${version}?include=modules`);
  const bytes = Uint8Array.from(atob(modules.find((m: any) => m.name === "app.js").content_base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The code serving now, not a proposal waiting for review.
export const deployedSource = async (env: Env, id: string) => sourceOf(env, id, (await versions(env, id)).deployed);

type Server = { id: string; hostname?: string } | undefined;

export async function proposeApp(env: Env, server: Server, input: any, deps: Deps) {
  if (!server || !isApp(server)) throw new InputError("Not an uploaded script");
  const source = appSource(input.source);
  if (!(await secretNames(env, server.id)).length) return updateApp(env, server, { source }, deps);
  // The same code as the code a person last approved needs no second look: only
  // runkle's own entry module changes, and that is reviewed where runkle is.
  const v = await versions(env, server.id);
  if (v.latest === v.deployed && (await sourceOf(env, server.id, v.deployed)) === source)
    return { ...(await updateApp(env, server, { source, message: "Same code as approved, redeployed by runkle" }, deps)), reviewed: "not needed: the code is unchanged" };
  await upload(env, server.id, source, {}, { keep: true, pending: true, message: "Proposed by an agent, waiting for review in runkle", ui: deps.ui });
  const link = `${deps.ui}/#${new URLSearchParams({ review: server.id })}`;
  const { notified } = await deps.inbox("open", { item: { id: `review:${server.id}`, kind: "review", app: server.id, title: `A change to ${server.id}`, link } });
  return {
    waiting_for_review: link,
    next: `Not deployed yet: this script holds secrets, so the user must approve the change in runkle. ${notified ? "They have been notified." : "Give them this link."} review_status shows when they decide.`,
  };
}

export async function proposal(env: Env, server: Server) {
  if (!server || !isApp(server)) throw new InputError("Not an uploaded script");
  const v = await versions(env, server.id);
  if (v.latest === v.deployed) throw new InputError("Nothing is waiting for review");
  const [current, proposed] = await Promise.all([sourceOf(env, server.id, v.deployed), sourceOf(env, server.id, v.latest)]);
  return { version: v.latest, current, proposed };
}

// `version` is the proposal the person read, so a newer one cannot ride on their approval.
// Cloudflare cannot delete a version, so rejecting deploys the current source again.
export async function decide(env: Env, server: Server, input: any, deps: Deps, by: string) {
  const p = await proposal(env, server);
  if (input.version !== p.version) throw new InputError("The proposal changed after you opened it. Review it again.");
  const approve = input.approve === true;
  const result = await updateApp(env, server, { source: approve ? p.proposed : p.current, message: `${approve ? "Approved" : "Rejected"} by ${by} in runkle` }, deps);
  await deps.inbox("close", { id: `review:${server!.id}`, state: approve ? "approved" : "denied", by });
  return result;
}

// What a person has set on an app: its secrets by name (Cloudflare never gives
// a value back) and the tools they want to be asked about.
export async function appConfig(env: Env, id: string): Promise<{ secrets: string[]; ask_first: string[] }> {
  const { bindings } = await cf<{ bindings: { name: string; type: string; text?: string }[] }>(env, "GET", `${scriptPath(id)}/settings`);
  return {
    secrets: bindings.filter((b) => b.type === "secret_text" && !b.name.startsWith("RUNKLE_")).map((b) => b.name),
    ask_first: JSON.parse(bindings.find((b) => b.name === "RUNKLE_ASK")?.text ?? "[]"),
  };
}
export const secretNames = async (env: Env, id: string) => (await appConfig(env, id)).secrets;

export async function deleteApp(env: Env, id: string) {
  await cf(env, "DELETE", `/workflows/${scriptName(id)}`).catch(() => {}); // most apps have none
  await cf(env, "DELETE", `${scriptPath(id)}?force=true`);
}
