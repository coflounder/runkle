// Everything runkle can do, independent of how it is asked (web UI or MCP).

import { appConfig, copyMark, createApp, decide, deleteApp, deleteSecret, isApp, keepCopy, pendingReview, proposal, proposeApp, scriptName, setSecret, updateApp, type Deps } from "./apps.ts";
import { cf, cfRaw, cfZone, UpstreamError, type Env } from "./cloudflare.ts";
import * as health from "./health.ts";
import { canon, describe, generateRequest, randomSecret } from "./generate.ts";
import { inbox } from "./inbox.ts";
import { expiryDate, httpsUrl, InputError, redirectUris, required, secretName, setTool, slug, toMapping, type Mapping } from "./mapping.ts";
import { skillsApp, sourceApp } from "./sources.ts";

async function accessApps(env: Env): Promise<any[]> {
  const apps: any[] = [];
  for (let page = 1; ; page++) {
    const json = await cfRaw(env, "GET", `/access/apps?page=${page}&per_page=50`);
    apps.push(...json.result);
    if (page >= (json.result_info?.total_pages ?? 1)) return apps;
  }
}

const mcp = "/access/ai-controls/mcp";
// The portal runkle was deployed with, which serves every integration, or a collection's.
// It carries the id it was fetched by, which putPortal writes back to.
const getPortal = async (env: Env, id = env.PORTAL_ID) => ({ ...(await cf(env, "GET", `${mcp}/portals/${id}`)), id });

// A portal PUT resets whatever it is not sent, so always send everything.
const putPortal = (env: Env, portal: any, changes: { servers?: Mapping[]; code_mode?: string }) =>
  cf(env, "PUT", `${mcp}/portals/${portal.id}`, {
    name: portal.name,
    hostname: portal.hostname,
    ...(portal.description && { description: portal.description }),
    secure_web_gateway: portal.secure_web_gateway ?? false,
    code_mode: changes.code_mode ?? portal.code_mode,
    servers: changes.servers ?? toMapping(portal.servers ?? []),
  });

const portalApp = (apps: any[], portal: any) =>
  apps.find((a) => a.type === "mcp_portal" && a.domain === portal.hostname);

// The Access apps that exist only for one integration: its portal entry and, for an app with pages, its pages.
const serverApps = (apps: any[], serverId: string) =>
  apps.filter(
    (a) =>
      (a.type === "mcp" && a.destinations?.some((d: any) => d.mcp_server_id === serverId)) ||
      (a.type === "self_hosted" && a.domain?.startsWith(`${scriptName(serverId)}.`)),
  );

// New Access apps get the same policies as the portal itself.
const portalPolicies = (apps: any[], portal: any) =>
  (portalApp(apps, portal)?.policies ?? []).map((p: any, i: number) => ({ id: p.id, precedence: i + 1 }));

export async function state(env: Env, me: string) {
  const [portal, apps, cols] = await Promise.all([getPortal(env), accessApps(env), collections(env)]);
  const oauth = portalApp(apps, portal)?.oauth_configuration;
  const servers: any[] = portal.servers ?? [];
  // Which secrets each app has, by name, so an agent can tell when the user has entered them,
  // and which of its tools wait for the user's approval.
  const config = await Promise.all(servers.map((s) => (isApp(s) ? appConfig(env, s.id).catch(() => ({ secrets: [], copied: [], ask_first: [] })) : undefined)));
  // ponytail: two Cloudflare calls per script on every load; fetch on demand if the list grows slow.
  const pending = await Promise.all(servers.map((s) => isApp(s) && pendingReview(env, s.id).catch(() => false)));
  const expiries = await inbox(env.INBOX)("expiries");
  return {
    me,
    portal: { name: portal.name, hostname: portal.hostname, code_mode: portal.code_mode },
    endpoint: `https://${portal.hostname}/mcp`,
    collections: cols.map((c) => ({
      id: c.id.slice(COLLECTION.length),
      name: c.name,
      endpoint: `https://${c.hostname}/mcp`,
      code_mode: c.code_mode,
      integrations: (c.servers ?? []).map((s: any) => ({ id: s.id, blocked_tools: (s.tools ?? []).filter((t: any) => !toolEnabled(s, t)).map((t: any) => t.name) })),
    })),
    integrations: servers.map((s, i) => ({
      id: s.id,
      name: s.name,
      url: s.hostname,
      auth_type: s.auth_type,
      is_app: isApp(s),
      ...(config[i] && { secrets_set: config[i].secrets, secrets_copied: config[i].copied, ask_first: config[i].ask_first }),
      ...(expiries[s.id] && { secret_expiry: expiries[s.id] }),
      ...(pending[i] && { pending_review: true }),
      auth_mode: s.auth_config_summary?.auth_mode,
      status: s.status,
      authentication_status: s.authentication_status,
      error: s.error_details?.cause ?? s.error,
      last_synced: s.last_successful_sync,
      collections: cols.filter((c) => c.servers?.some((x: any) => x.id === s.id)).map((c) => c.id.slice(COLLECTION.length)),
      tools: (s.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, enabled: toolEnabled(s, t) })),
    })),
    agentAuth: portalApp(apps, portal) && {
      enabled: oauth?.enabled ?? false,
      allow_localhost: oauth?.dynamic_client_registration?.allow_any_on_localhost ?? false,
      allow_loopback: oauth?.dynamic_client_registration?.allow_any_on_loopback ?? false,
      allowed_uris: oauth?.dynamic_client_registration?.allowed_uris ?? [],
    },
  };
}

const toolEnabled = (s: any, t: any) => s.updated_tools?.find((u: any) => u.name === t.name)?.enabled ?? !s.default_disabled;

export type ServerBody = Record<string, unknown> & { id: string; name: string; auth_type: string };

export async function registerServer(env: Env, body: ServerBody) {
  const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
  if (portal.servers?.some((s: any) => s.id === body.id)) throw new InputError(`"${body.id}" already exists`);

  await cf(env, "POST", `${mcp}/servers`, body);
  let app: any;
  try {
    // Portal users only see a server they are allowed by an Access app.
    app = await cf(env, "POST", "/access/apps", {
      name: body.name,
      type: "mcp",
      destinations: [{ type: "via_mcp_server_portal", mcp_server_id: body.id }],
      policies: portalPolicies(apps, portal),
    });
    await putPortal(env, portal, {
      servers: [
        ...toMapping(portal.servers ?? []),
        { server_id: body.id, on_behalf: body.auth_type === "oauth", default_disabled: false, updated_tools: [], updated_prompts: [] },
      ],
    });
  } catch (error) {
    // Undo the half-made integration; the original error is the one worth reporting.
    if (app) await cf(env, "DELETE", `/access/apps/${app.id}`).catch(() => {});
    await cf(env, "DELETE", `${mcp}/servers/${body.id}`).catch(() => {});
    throw error;
  }
  await inbox(env.INBOX)("close", { id: `setup:${body.id}`, state: "done" });
  return { id: body.id };
}

export async function removeIntegration(env: Env, id: string) {
  const [portal, apps, cols] = await Promise.all([getPortal(env), accessApps(env), collections(env)]);
  for (const c of [...cols, portal])
    if (c.servers?.some((s: any) => s.id === id)) await putPortal(env, c, { servers: toMapping(c.servers).filter((m) => m.server_id !== id) });
  for (const app of serverApps(apps, id)) await cf(env, "DELETE", `/access/apps/${app.id}`);
  await cf(env, "DELETE", `${mcp}/servers/${id}`);
  if (portal.servers?.some((s: any) => s.id === id && isApp(s))) await deleteApp(env, id);
  await inbox(env.INBOX)("expiry", { app: id, forget: true });
}

// In the portal that serves everything, or with `collection`, in that collection only.
export async function toggleTool(env: Env, id: string, input: { tool?: string; enabled?: boolean; collection?: string }) {
  if (typeof input.tool !== "string" || typeof input.enabled !== "boolean") throw new InputError("tool and enabled are required");
  const portal = input.collection ? await getCollection(env, input.collection) : await getPortal(env);
  // ponytail: read-modify-write, last write wins if two admins toggle at once. The API offers no per-tool PATCH.
  await putPortal(env, portal, { servers: setTool(toMapping(portal.servers ?? []), id, input.tool, input.enabled) });
}

export async function setAgentAuth(env: Env, input: any) {
  const uris = redirectUris(input.allowed_uris);
  const portal = await getPortal(env);
  const app = portalApp(await accessApps(env), portal);
  if (!app) throw new UpstreamError(`No Access application found for portal ${portal.hostname}`);
  await cf(env, "PUT", `/access/apps/${app.id}`, {
    ...app,
    oauth_configuration: {
      ...app.oauth_configuration,
      enabled: Boolean(input.enabled),
      dynamic_client_registration: {
        ...app.oauth_configuration?.dynamic_client_registration,
        enabled: true,
        allow_any_on_localhost: Boolean(input.allow_localhost),
        allow_any_on_loopback: Boolean(input.allow_loopback),
        allowed_uris: uris,
      },
    },
  });
}

export async function setCodeMode(env: Env, input: any) {
  if (!["off", "opt_in", "default_on", "enforced"].includes(input.code_mode)) throw new InputError("Unknown code mode");
  await putPortal(env, input.collection ? await getCollection(env, input.collection) : await getPortal(env), { code_mode: input.code_mode });
}

// ---- Collections ----
// A collection is one more portal, on its own hostname, serving some of the
// integrations. runkle makes and runs every part of it: the portal, its DNS
// record and its Access application. The portal runkle was deployed with keeps
// serving everything, and every integration is registered there first.

const COLLECTION = "runkle-"; // portal ids runkle owns; any other portal is left alone
const DNS_COMMENT = (id: string) => `runkle collection ${id}`;
// Where a portal's hostname points, if the deployed portal's own record can't be read.
const PORTAL_TARGET = "gateway.agents.cloudflare.com";

const listPortals = (env: Env): Promise<any[]> => cf(env, "GET", `${mcp}/portals`);

// Each collection in full, with its servers. A list of portals leaves them out.
async function collections(env: Env): Promise<any[]> {
  const ids = (await listPortals(env)).map((p) => p.id).filter((id: string) => id?.startsWith(COLLECTION));
  return Promise.all(ids.map((id) => getPortal(env, id)));
}

async function getCollection(env: Env, id: unknown) {
  if (typeof id !== "string" || !id) throw new InputError("collection is required");
  const portalId = COLLECTION + id;
  if (!(await listPortals(env)).some((p) => p.id === portalId)) throw new InputError(`No collection "${id}"`);
  return getPortal(env, portalId);
}

// The deployed portal's entries for these integrations, tool settings included.
function pick(portal: any, ids: string[]): Mapping[] {
  const mapping = toMapping(portal.servers ?? []);
  for (const id of ids) if (!mapping.some((m) => m.server_id === id)) throw new InputError(`No integration "${id}"`);
  return mapping.filter((m) => ids.includes(m.server_id));
}

const ids = (list: unknown, name: string): string[] => {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new InputError(`${name} must be a list of integration ids`);
  return [...new Set(list as string[])];
};

// The zone that holds a hostname: the longest of its suffixes that is a zone on this account.
async function zoneFor(env: Env, hostname: string): Promise<string> {
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const [zone] = await cfZone(env, "GET", `/zones?account.id=${env.ACCOUNT_ID}&name=${labels.slice(i).join(".")}`);
    if (zone) return zone.id;
  }
  throw new UpstreamError(`No Cloudflare zone for ${hostname}. runkle's API token needs Zone Read and DNS Edit on it.`);
}

const dnsRecords = (env: Env, zone: string, name: string): Promise<any[]> => cfZone(env, "GET", `/zones/${zone}/dns_records?name=${name}`);

export async function createCollection(env: Env, input: { name?: string; integrations?: unknown }) {
  const name = required(input.name, "Name");
  const id = slug(name).slice(0, 24).replace(/-+$/, "");
  if (!id) throw new InputError("Name needs a letter or a digit");
  const [main, apps, portals] = await Promise.all([getPortal(env), accessApps(env), listPortals(env)]);
  if (portals.some((p) => p.id === COLLECTION + id)) throw new InputError(`A collection "${id}" already exists`);
  const servers = pick(main, ids(input.integrations, "integrations"));
  // One label under the deployed portal's domain, so its certificate covers it: mcp-personal.example.com.
  const hostname = `mcp-${id}.${main.hostname.slice(main.hostname.indexOf(".") + 1)}`;
  const zone = await zoneFor(env, hostname);

  const undo: (() => Promise<unknown>)[] = [];
  try {
    if (!(await dnsRecords(env, zone, hostname)).length) {
      const [like] = await dnsRecords(env, zone, main.hostname);
      const record = await cfZone(env, "POST", `/zones/${zone}/dns_records`, {
        type: like?.type ?? "CNAME",
        name: hostname,
        content: like?.content ?? PORTAL_TARGET,
        proxied: true,
        ttl: 1,
        comment: DNS_COMMENT(id),
      });
      undo.push(() => cfZone(env, "DELETE", `/zones/${zone}/dns_records/${record.id}`));
    }
    await cf(env, "POST", `${mcp}/portals`, { id: COLLECTION + id, name, hostname, secure_web_gateway: main.secure_web_gateway ?? false, code_mode: main.code_mode, servers });
    undo.push(() => cf(env, "DELETE", `${mcp}/portals/${COLLECTION + id}`));
    // Signs people and agents in exactly as the deployed portal does. Looked up
    // again in case Cloudflare made an app along with the portal.
    const gate = portalApp(apps, main);
    const settings = {
      policies: portalPolicies(apps, main),
      ...(gate?.session_duration && { session_duration: gate.session_duration }),
      ...(gate?.oauth_configuration && { oauth_configuration: gate.oauth_configuration }),
    };
    const made = portalApp(await accessApps(env), { hostname });
    if (made) await cf(env, "PUT", `/access/apps/${made.id}`, { ...made, ...settings });
    else {
      const app = await cf(env, "POST", "/access/apps", { name: `${name} (runkle collection)`, type: "mcp_portal", domain: hostname, destinations: [{ type: "public", uri: hostname }], ...settings });
      undo.push(() => cf(env, "DELETE", `/access/apps/${app.id}`));
    }
  } catch (error) {
    for (const step of undo.reverse()) await step().catch(() => {});
    throw error;
  }
  return { id, endpoint: `https://${hostname}/mcp`, next_steps: COLLECTION_NEXT_STEPS };
}

export const COLLECTION_NEXT_STEPS =
  "Agents reach a collection through its own endpoint: add it as a new connector in the MCP client (in claude.ai, under Settings > Connectors) and sign in. Integrations that sign each person in with OAuth ask for that sign-in again through the new connector.";

// Integrations join with the settings they have in the deployed portal; leaving one changes nothing else.
export async function setCollection(env: Env, id: string, input: { add?: unknown; remove?: unknown }) {
  const [portal, main] = await Promise.all([getCollection(env, id), getPortal(env)]);
  const remove = ids(input.remove, "remove");
  const kept = toMapping(portal.servers ?? []).filter((m) => !remove.includes(m.server_id));
  const add = ids(input.add, "add").filter((a) => !kept.some((m) => m.server_id === a));
  await putPortal(env, portal, { servers: [...kept, ...pick(main, add)] });
}

// The portal first, so nothing is served while its sign-in is taken away.
export async function deleteCollection(env: Env, id: string) {
  const [portal, apps] = await Promise.all([getCollection(env, id), accessApps(env)]);
  await cf(env, "DELETE", `${mcp}/portals/${portal.id}`);
  const app = portalApp(apps, portal);
  if (app) await cf(env, "DELETE", `/access/apps/${app.id}`);
  const zone = await zoneFor(env, portal.hostname);
  for (const record of await dnsRecords(env, zone, portal.hostname))
    if (record.comment === DNS_COMMENT(id)) await cfZone(env, "DELETE", `/zones/${zone}/dns_records/${record.id}`);
}


export const syncServer = async (env: Env, id: string) => void (await cf(env, "POST", `${mcp}/servers/${id}/sync`));

// Links an agent can hand the user. They open runkle's own UI, which is behind
// Access, with a form filled in except for the secret values. A link carries no
// secret and grants nothing by itself.
export async function credentialLink(env: Env, ui: string, input: { id?: string; names?: unknown[] }) {
  const names = (input.names ?? []).map(secretName);
  if (!names.length) throw new InputError("Name at least one secret");
  if (!(await getPortal(env)).servers?.some((s: any) => s.id === input.id && isApp(s))) throw new InputError(`No script or API named "${input.id}"`);
  const url = `${ui}/#${new URLSearchParams({ secrets: input.id!, names: names.join(",") })}`;
  const { notified } = await inbox(env.INBOX)("open", { ui, item: { id: `secrets:${input.id}`, kind: "secrets", app: input.id, title: `${names.join(", ")} for ${input.id}`, link: url } });
  return { url, next: `${notified ? "The user has been notified in their runkle inbox; give them" : "Give the user"} this link. list_integrations shows the names in secrets_set once they are entered.` };
}

export async function serverLink(env: Env, ui: string, input: { name?: string; url?: string; auth?: string }) {
  if (input.auth !== "bearer" && input.auth !== "oauth_manual") throw new InputError("auth must be bearer or oauth_manual");
  const fields = { add: "1", name: required(input.name, "Name"), url: httpsUrl(input.url, "Server URL"), auth: input.auth };
  const url = `${ui}/#${new URLSearchParams(fields)}`;
  const { notified } = await inbox(env.INBOX)("open", { ui, item: { id: `setup:${slug(fields.name)}`, kind: "setup", title: `Add ${fields.name}`, detail: fields.url, link: url } });
  return { url, next: `${notified ? "The user has been notified in their runkle inbox; give them" : "Give the user"} this link. The integration appears in list_integrations once they finish.` };
}

const appDeps = (env: Env, ui: string): Deps => ({
  ui,
  inbox: (op, args) => inbox(env.INBOX)(op, { ui, ...args }),
  exists: async (id) => (await getPortal(env)).servers?.some((s: any) => s.id === id) ?? false,
  register: (server) => registerServer(env, server),
  // Access on workers.dev can only finish its login for an app that covers the
  // whole hostname, so the gate does, and a second app re-opens the paths that
  // do their own authentication. Opened first, so the portal is never shut out.
  async pagesAud(id, host) {
    const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
    const find = (domain: string) => apps.find((a) => a.type === "self_hosted" && a.domain === domain);
    const open = ["mcp", "webhooks", "manifest", "vault"].map((area) => `${host}/${area}`);
    if (!find(open[0]))
      await cf(env, "POST", "/access/apps", {
        name: `${id} public paths`,
        type: "self_hosted",
        domain: open[0],
        destinations: open.map((uri) => ({ type: "public", uri })),
        policies: [{ name: "Everyone", decision: "bypass", include: [{ everyone: {} }] }],
      });
    const gate =
      find(host) ?? (await cf(env, "POST", "/access/apps", { name: `${id} pages`, type: "self_hosted", domain: host, policies: portalPolicies(apps, portal) }));
    return gate.aud;
  },
});

// Expiry dates given beside secret values, checked against the secrets they come with.
function expiries(input: any): Record<string, string> {
  if (input.expires == null) return {};
  if (typeof input.expires !== "object" || Array.isArray(input.expires)) throw new InputError("expires must map secret names to dates");
  const dates: Record<string, string> = {};
  for (const [name, date] of Object.entries(input.expires)) {
    if (!Object.hasOwn(input.secrets ?? {}, name)) throw new InputError(`An expiry date is given for ${name}, but no value`);
    if (date) dates[name] = expiryDate(date, name);
  }
  return dates;
}

export async function newApp(env: Env, ui: string, input: any) {
  const dates = expiries(input ?? {});
  const made = await createApp(env, input, appDeps(env, ui));
  if (Object.keys(dates).length) await inbox(env.INBOX)("expiry", { app: made.id, dates });
  return made;
}

// The credential, if any, becomes the generated app's API_TOKEN secret.
export const newSource = async (env: Env, ui: string, input: any) =>
  newApp(env, ui, { name: input.name, source: await sourceApp(input), secrets: input.token ? { API_TOKEN: input.token } : undefined, ask_first: input.ask_first });

export const newSkills = (env: Env, ui: string, input: any) => newApp(env, ui, { name: input.name, source: skillsApp(input.skills) });

const server = async (env: Env, id: string) => (await getPortal(env)).servers?.find((s: any) => s.id === id);

export async function changeApp(env: Env, ui: string, id: string, input: any) {
  const dates = expiries(input);
  const result = await updateApp(
    env,
    await server(env, id),
    input.skills ? { source: skillsApp(input.skills) } : { source: input.source, secrets: input.secrets, ask_first: input.ask_first },
    appDeps(env, ui),
  );
  if (input.secrets && Object.keys(input.secrets).length) {
    // A new value makes the old date wrong: it takes the date given with it, or none.
    await inbox(env.INBOX)("expiry", { app: id, dates: Object.fromEntries(Object.keys(input.secrets).map((name) => [name, dates[name] ?? null])) });
    await inbox(env.INBOX)("close", { id: `secrets:${id}`, state: "done" });
  }
  return result;
}

// What an agent may do to a script's source: deploy it, or leave it for review when the script holds secrets.
export const proposeChange = async (env: Env, ui: string, id: string, source: unknown) => proposeApp(env, await server(env, id), { source }, appDeps(env, ui));
export const proposeSource = async (env: Env, ui: string, id: string, input: any) => proposeChange(env, ui, id, await sourceApp(input));
export const reviewChange = async (env: Env, id: string) => proposal(env, await server(env, id));
export const decideChange = async (env: Env, ui: string, id: string, input: any, by: string) => decide(env, await server(env, id), input, appDeps(env, ui), by);

// For agents: whether a change they proposed is still waiting, and what the person decided last.
export async function reviewStatus(env: Env, id: string) {
  const s = await server(env, id);
  if (!s || !isApp(s)) throw new InputError(`No script or API named "${id}"`);
  const last = await inbox(env.INBOX)("get", { id: `review:${id}` });
  return {
    pending: await pendingReview(env, id),
    ...(last && last.state !== "open" && { last_decision: { decision: last.state, by: last.by, at: new Date(last.decided).toISOString() } }),
  };
}

// For agents: record when a secret stops working, a date and never a value. null forgets it.
export async function setExpiry(env: Env, id: string, input: { name?: unknown; expires?: unknown }) {
  const name = secretName(input.name);
  const s = await server(env, id);
  if (!s || !isApp(s)) throw new InputError(`No script or API named "${id}"`);
  if (!(await appConfig(env, id)).secrets.includes(name)) throw new InputError(`${id} has no secret named ${name}`);
  return { secret_expiry: await inbox(env.INBOX)("expiry", { app: id, dates: { [name]: input.expires == null ? null : expiryDate(input.expires, name) } }) };
}

// ---- Health (src/health.ts) ----

async function healthReport(env: Env) {
  const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
  return health.check(env, portal.servers ?? [], portalApp(apps, portal)?.session_duration);
}
// For agents: a report only.
export const checkIntegrations = (env: Env) => healthReport(env);
// The UI's Check now and the daily Cron Trigger: also opens and closes the inbox's alerts.
export const checkAndAlert = async (env: Env, ui?: string) => health.alert(env, await healthReport(env), ui);
// The last report, or {} before the first check.
export const lastHealth = async (env: Env) => (await inbox(env.INBOX)("health")) ?? {};

// ---- Generated secrets ----
//
// runkle makes the value, keeps a copy in a vault if asked, and sets it where
// it is used. It never stores the value, never returns it, and asked by an
// agent it waits for a person: the request is an `approval` item in the inbox,
// and the agent's repeated call runs once after it is approved. `by` is the
// person when they ask from runkle's own UI, which needs no second approval.
export async function generateSecret(env: Env, ui: string, input: unknown, by?: string) {
  const request = generateRequest(input);
  const servers: any[] = (await getPortal(env)).servers ?? [];
  const find = (id: string) => servers.find((s) => s.id === id);

  // Every rule is checked before anyone is asked, so a person only sees requests that can run.
  const apps = [...new Set(request.targets.flatMap((t) => ("app" in t ? [t.app] : [])))];
  const configs: Record<string, Awaited<ReturnType<typeof appConfig>>> = {};
  for (const id of [...apps, ...(request.copy_to ? [request.copy_to.app] : [])]) {
    if (!find(id) || !isApp(find(id))) throw new InputError(`No script or API named "${id}"`);
    if (await pendingReview(env, id)) throw new InputError(`A change to ${id} is waiting for review. It must be approved or rejected first.`);
    configs[id] = await appConfig(env, id);
  }
  for (const t of request.targets) {
    if (!("server" in t)) continue;
    const s = find(t.server);
    if (!s || isApp(s)) throw new InputError(`No remote MCP server named "${t.server}". A script's own token is runkle's to manage.`);
    if (s.auth_type !== "bearer") throw new InputError(`${t.server} does not sign in with a bearer token`);
  }
  // The vault app is handed the value, so its code must be code a person reviewed:
  // an app's code changes wait for review only while it holds secrets.
  if (request.copy_to && !configs[request.copy_to.app].secrets.length)
    throw new InputError(`${request.copy_to.app} holds no secrets, so its code is not reviewed and it cannot keep copies`);

  if (!by) {
    const id = await sha(`runkle\ngenerate_secret\n${canon(request)}`);
    const unreviewed = apps.filter((a) => !configs[a].secrets.length);
    const ask = await inbox(env.INBOX)("ask", { id, app: "runkle", tool: "generate_secret", input: request, summary: describe(request, unreviewed), ui });
    if (ask.state === "denied") throw new InputError(`Denied by ${ask.by}. Do not ask again unless the user tells you to.`);
    if (ask.state !== "approved")
      return {
        waiting_for_approval: `${ui}/#${new URLSearchParams({ inbox: id })}`,
        expires: new Date(ask.expires).toISOString(),
        next: `Not done: the user must approve this first, in their runkle inbox. ${ask.notified === undefined ? "They have not decided yet." : ask.notified ? "They have been notified." : "Give them the link."} Call generate_secret again with exactly the same arguments: it runs once they have approved.`,
      };
  }

  // From here the value exists, in this function only.
  const value = randomSecret(request.length, request.alphabet);
  // The copy first: a value that is live somewhere is never one that exists nowhere else.
  if (request.copy_to) await keepCopy(env, find(request.copy_to.app), request.copy_to, value);
  const set: string[] = [];
  try {
    for (const t of request.targets) {
      if ("server" in t) {
        await cf(env, "PUT", `${mcp}/servers/${t.server}`, { name: find(t.server).name, auth_credentials: value });
        set.push(`bearer token of ${t.server}`);
      } else {
        await setSecret(env, t.app, t.secret, value);
        if (request.copy_to) await setSecret(env, t.app, copyMark(t.secret), "1");
        else if (configs[t.app].copied.includes(t.secret)) await deleteSecret(env, t.app, copyMark(t.secret));
        set.push(`${t.secret} on ${t.app}`);
      }
    }
  } catch (error) {
    const left = request.copy_to ? " The vault holds the value, so it can be set by hand from there." : "";
    throw new UpstreamError(`Set ${set.length ? set.join(", ") : "nothing"}, then failed: ${(error as Error).message.replaceAll(value, "[the generated value]")}.${left}`);
  }
  for (const app of apps) await inbox(env.INBOX)("close", { id: `secrets:${app}`, state: "done" });
  return {
    set,
    ...(request.copy_to && { copy: { vault: request.copy_to.vault, item: request.copy_to.item, field: request.copy_to.field } }),
    next: "Done. Nobody has seen the value. list_integrations shows the names in secrets_set, and in secrets_copied where a vault keeps a copy.",
  };
}

const sha = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ---- The inbox, for the person (UI only) ----

export async function inboxList(env: Env) {
  const box = inbox(env.INBOX);
  return { ...(await box("list")), publicKey: (await box("key")).publicKey };
}

// Approve or deny a tool call, or set aside anything else the person has dealt with.
export async function inboxDecide(env: Env, id: string, input: any, by: string) {
  const box = inbox(env.INBOX);
  const item = await box("get", { id });
  if (!item || item.state !== "open") throw new InputError("Nothing is waiting under that id. It may have been decided or have expired.");
  if (item.kind === "approval") {
    if (typeof input.approve !== "boolean") throw new InputError("approve must be true or false");
    if (!(await box("decide", { id, approve: input.approve, by }))) throw new InputError("This request has expired.");
    return { decided: input.approve ? "approved" : "denied" };
  }
  if (item.kind === "review") throw new InputError("Open the review to approve or reject the change.");
  await box("close", { id, state: "done", by });
  return { dismissed: true };
}

export async function subscribe(env: Env, input: any, by: string, ui: string) {
  const res = await inbox(env.INBOX)("subscribe", { subscription: input.subscription, by, ui });
  if (res.error) throw new InputError(res.error);
  return res;
}
export const unsubscribe = (env: Env, input: any) => inbox(env.INBOX)("unsubscribe", { endpoint: input.endpoint });
export const testPush = async (env: Env, ui: string) => ({ notified: await inbox(env.INBOX)("test", { ui }) });
