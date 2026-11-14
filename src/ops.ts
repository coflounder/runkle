// Everything runkle can do, independent of how it is asked (web UI or MCP).

import { createApp, decide, deleteApp, isApp, pendingReview, proposal, proposeApp, scriptName, secretNames, updateApp, type Deps } from "./apps.ts";
import { cf, cfRaw, UpstreamError, type Env } from "./cloudflare.ts";
import { httpsUrl, InputError, redirectUris, required, secretName, setTool, toMapping, type Mapping } from "./mapping.ts";
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
const getPortal = (env: Env) => cf(env, "GET", `${mcp}/portals/${env.PORTAL_ID}`);

// A portal PUT resets whatever it is not sent, so always send everything.
const putPortal = (env: Env, portal: any, changes: { servers?: Mapping[]; code_mode?: string }) =>
  cf(env, "PUT", `${mcp}/portals/${env.PORTAL_ID}`, {
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
  const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
  const oauth = portalApp(apps, portal)?.oauth_configuration;
  const servers: any[] = portal.servers ?? [];
  // Which secrets each app has, by name, so an agent can tell when the user has entered them.
  const secrets = await Promise.all(servers.map((s) => (isApp(s) ? secretNames(env, s.id).catch(() => []) : undefined)));
  // ponytail: two Cloudflare calls per script on every load; fetch on demand if the list grows slow.
  const pending = await Promise.all(servers.map((s) => isApp(s) && pendingReview(env, s.id).catch(() => false)));
  return {
    me,
    portal: { name: portal.name, hostname: portal.hostname, code_mode: portal.code_mode },
    endpoint: `https://${portal.hostname}/mcp`,
    integrations: servers.map((s, i) => ({
      id: s.id,
      name: s.name,
      url: s.hostname,
      auth_type: s.auth_type,
      is_app: isApp(s),
      ...(secrets[i] && { secrets_set: secrets[i] }),
      ...(pending[i] && { pending_review: true }),
      auth_mode: s.auth_config_summary?.auth_mode,
      status: s.status,
      authentication_status: s.authentication_status,
      error: s.error_details?.cause ?? s.error,
      last_synced: s.last_successful_sync,
      tools: (s.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        enabled: s.updated_tools?.find((u: any) => u.name === t.name)?.enabled ?? !s.default_disabled,
      })),
    })),
    agentAuth: portalApp(apps, portal) && {
      enabled: oauth?.enabled ?? false,
      allow_localhost: oauth?.dynamic_client_registration?.allow_any_on_localhost ?? false,
      allow_loopback: oauth?.dynamic_client_registration?.allow_any_on_loopback ?? false,
      allowed_uris: oauth?.dynamic_client_registration?.allowed_uris ?? [],
    },
  };
}

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
  return { id: body.id };
}

export async function removeIntegration(env: Env, id: string) {
  const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
  await putPortal(env, portal, { servers: toMapping(portal.servers ?? []).filter((m) => m.server_id !== id) });
  for (const app of serverApps(apps, id)) await cf(env, "DELETE", `/access/apps/${app.id}`);
  await cf(env, "DELETE", `${mcp}/servers/${id}`);
  if (portal.servers?.some((s: any) => s.id === id && isApp(s))) await deleteApp(env, id);
}

export async function toggleTool(env: Env, id: string, input: { tool?: string; enabled?: boolean }) {
  if (typeof input.tool !== "string" || typeof input.enabled !== "boolean") throw new InputError("tool and enabled are required");
  const portal = await getPortal(env);
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
  await putPortal(env, await getPortal(env), { code_mode: input.code_mode });
}


export const syncServer = async (env: Env, id: string) => void (await cf(env, "POST", `${mcp}/servers/${id}/sync`));

// Links an agent can hand the user. They open runkle's own UI, which is behind
// Access, with a form filled in except for the secret values. A link carries no
// secret and grants nothing by itself.
export async function credentialLink(env: Env, ui: string, input: { id?: string; names?: unknown[] }) {
  const names = (input.names ?? []).map(secretName);
  if (!names.length) throw new InputError("Name at least one secret");
  if (!(await getPortal(env)).servers?.some((s: any) => s.id === input.id && isApp(s))) throw new InputError(`No script or API named "${input.id}"`);
  return { url: `${ui}/#${new URLSearchParams({ secrets: input.id!, names: names.join(",") })}`, next: "Give the user this link. list_integrations shows the names in secrets_set once they are entered." };
}

export function serverLink(ui: string, input: { name?: string; url?: string; auth?: string }) {
  if (input.auth !== "bearer" && input.auth !== "oauth_manual") throw new InputError("auth must be bearer or oauth_manual");
  const fields = { add: "1", name: required(input.name, "Name"), url: httpsUrl(input.url, "Server URL"), auth: input.auth };
  return { url: `${ui}/#${new URLSearchParams(fields)}`, next: "Give the user this link. The integration appears in list_integrations once they finish." };
}

const appDeps = (env: Env): Deps => ({
  exists: async (id) => (await getPortal(env)).servers?.some((s: any) => s.id === id) ?? false,
  register: (server) => registerServer(env, server),
  // Access on workers.dev can only finish its login for an app that covers the
  // whole hostname, so the gate does, and a second app re-opens the paths that
  // do their own authentication. Opened first, so the portal is never shut out.
  async pagesAud(id, host) {
    const [portal, apps] = await Promise.all([getPortal(env), accessApps(env)]);
    const find = (domain: string) => apps.find((a) => a.type === "self_hosted" && a.domain === domain);
    const open = ["mcp", "webhooks", "manifest"].map((area) => `${host}/${area}`);
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

export const newApp = (env: Env, input: unknown) => createApp(env, input, appDeps(env));

// The credential, if any, becomes the generated app's API_TOKEN secret.
export const newSource = async (env: Env, input: any) =>
  newApp(env, { name: input.name, source: await sourceApp(input), secrets: input.token ? { API_TOKEN: input.token } : undefined });

export const newSkills = (env: Env, input: any) => newApp(env, { name: input.name, source: skillsApp(input.skills) });

const server = async (env: Env, id: string) => (await getPortal(env)).servers?.find((s: any) => s.id === id);

export const changeApp = async (env: Env, id: string, input: any) =>
  updateApp(env, await server(env, id), input.skills ? { source: skillsApp(input.skills) } : input, appDeps(env));

// What an agent may do to a script's source: deploy it, or leave it for review when the script holds secrets.
export const proposeChange = async (env: Env, ui: string, id: string, source: unknown) => proposeApp(env, await server(env, id), { source }, appDeps(env), ui);
export const reviewChange = async (env: Env, id: string) => proposal(env, await server(env, id));
export const decideChange = async (env: Env, id: string, input: any) => decide(env, await server(env, id), input, appDeps(env));
