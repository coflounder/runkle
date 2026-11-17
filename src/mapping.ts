// Pure translation between runkle's inputs and Cloudflare's MCP portal shapes.

export class InputError extends Error {}

type Override = { name: string; enabled?: boolean; alias?: string; description?: string };

export type Mapping = {
  server_id: string;
  on_behalf: boolean;
  default_disabled: boolean;
  updated_tools: Override[];
  updated_prompts: Override[];
};

// What a portal GET returns per tool/prompt override.
type PortalOverride = {
  name: string;
  portal_enabled?: boolean | null;
  portal_alias?: string | null;
  portal_description?: string | null;
};

export type PortalServer = {
  id: string;
  on_behalf?: boolean;
  default_disabled?: boolean;
  updated_tools?: PortalOverride[];
  updated_prompts?: PortalOverride[];
};

const overrides = (list: PortalOverride[] = []): Override[] =>
  list
    .filter((o) => o.portal_enabled != null || o.portal_alias || o.portal_description)
    .map((o) => ({
      name: o.name,
      ...(o.portal_enabled != null && { enabled: o.portal_enabled }),
      ...(o.portal_alias && { alias: o.portal_alias }),
      ...(o.portal_description && { description: o.portal_description }),
    }));

// A portal PUT replaces the whole server mapping: a server left out is detached
// and a field left out is reset. So every write starts from this full copy.
export const toMapping = (servers: PortalServer[]): Mapping[] =>
  servers.map((s) => ({
    server_id: s.id,
    on_behalf: s.on_behalf ?? false,
    default_disabled: s.default_disabled ?? false,
    updated_tools: overrides(s.updated_tools),
    updated_prompts: overrides(s.updated_prompts),
  }));

export function setTool(mapping: Mapping[], serverId: string, tool: string, enabled: boolean): Mapping[] {
  if (!mapping.some((m) => m.server_id === serverId)) throw new InputError(`No integration "${serverId}"`);
  return mapping.map((m) =>
    m.server_id !== serverId
      ? m
      : {
          ...m,
          updated_tools: [
            ...m.updated_tools.filter((t) => t.name !== tool),
            { ...m.updated_tools.find((t) => t.name === tool), name: tool, enabled },
          ],
        },
  );
}

// Server IDs are 1-32 characters and may not contain underscores, because the
// portal namespaces tools as `{server_id}_{tool}`.
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

export type IntegrationInput = {
  name?: string;
  url?: string;
  auth?: "none" | "bearer" | "oauth" | "oauth_manual";
  token?: string;
  client_id?: string;
  client_secret?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scope?: string;
};

export function httpsUrl(value: string | undefined, label: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value ?? "");
  } catch {}
  if (url?.protocol !== "https:") throw new InputError(`${label} must be an https:// URL`);
  return url.href;
}

export const required = (value: string | undefined, label: string): string => {
  if (!value?.trim()) throw new InputError(`${label} is required`);
  return value.trim();
};

export function serverBody(input: IntegrationInput) {
  const name = required(input.name, "Name");
  const id = slug(name);
  if (!id) throw new InputError("Name needs at least one letter or digit");
  const base = { id, name, hostname: httpsUrl(input.url, "Server URL") };

  switch (input.auth) {
    case "none":
      return { ...base, auth_type: "unauthenticated" };
    case "bearer":
      return { ...base, auth_type: "bearer", auth_credentials: required(input.token, "Token") };
    case "oauth": // Cloudflare registers the OAuth client itself (dynamic client registration).
      return { ...base, auth_type: "oauth" };
    case "oauth_manual":
      return {
        ...base,
        auth_type: "oauth",
        auth_credentials: JSON.stringify({
          auth_mode: "manual",
          config: {
            authorization_endpoint: httpsUrl(input.authorization_endpoint, "Authorization endpoint"),
            token_endpoint: httpsUrl(input.token_endpoint, "Token endpoint"),
          },
          registration_info: {
            client_id: required(input.client_id, "Client ID"),
            ...(input.scope?.trim() && { scope: input.scope.trim() }),
          },
        }),
        client_secret: required(input.client_secret, "Client secret"),
        is_shared_oauth_callback_enabled: true,
      };
    default:
      throw new InputError("Pick an authentication method");
  }
}

export function redirectUris(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InputError("allowed_uris must be a list");
  return value.map((uri) => {
    let url: URL | undefined;
    try {
      url = new URL(String(uri));
    } catch {}
    if (!url || url.hash || url.username) throw new InputError(`Not a valid redirect URI: ${uri}`);
    return String(uri);
  });
}

export function appSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("Choose a script file");
  if (value.length > 1_000_000) throw new InputError("Script is larger than 1 MB");
  return value;
}

// Tool names a person wants to approve before they run; * matches anything.
export function askFirst(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((name) => typeof name !== "string" || !/^[\w.*-]{1,100}$/.test(name)))
    throw new InputError("ask_first must be a list of tool names; * matches anything");
  return [...new Set(value as string[])];
}

export function secretName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new InputError(`Secret name "${name}" must be UPPER_SNAKE_CASE`);
  if (name.startsWith("RUNKLE_")) throw new InputError("Names starting with RUNKLE_ are reserved");
  return name;
}

// Secret names become environment variables in the uploaded script.
export function appSecrets(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InputError("secrets must be an object");
  for (const [name, text] of Object.entries(value)) {
    secretName(name);
    if (typeof text !== "string" || !text) throw new InputError(`Secret ${name} needs a value`);
  }
  return value as Record<string, string>;
}
