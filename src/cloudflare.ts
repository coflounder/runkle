export type Env = {
  CLOUDFLARE_API_TOKEN: string;
  ACCOUNT_ID: string;
  PORTAL_ID: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  AUTH_DISABLED?: string; // "true" in .dev.vars only: skips Access for local development
  CF_API_BASE?: string; // override for tests and non-default API regions
  // Optional secret: where to send "something needs your approval". Receives a POST with the
  // message as plain text and Title and Click headers, the format ntfy uses.
  NOTIFY_URL?: string;
};

export class UpstreamError extends Error {}

// `path` is relative to the account, e.g. "/access/apps". A FormData body is sent as multipart.
export async function cfRaw(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const base = env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4";
  const multipart = body instanceof FormData;
  const res = await fetch(`${base}/accounts/${env.ACCOUNT_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(!multipart && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.map((e: any) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new UpstreamError(`Cloudflare: ${detail}`);
  }
  return json;
}

// An app's own hostname. With CF_API_BASE set (tests, local dev) it is served by the fake.
export const appFetch = (env: Env, host: string, path: string, init?: RequestInit) =>
  fetch(env.CF_API_BASE ? `${env.CF_API_BASE}/__app/${host}${path}` : `https://${host}${path}`, init);

// Tell the person something is waiting for them. Never fails the operation that asked.
export const notify = async (env: Env, title: string, text: string, link: string) => {
  if (env.NOTIFY_URL) await fetch(env.NOTIFY_URL, { method: "POST", headers: { Title: title, Click: link }, body: `${text}\n${link}` }).catch(() => {});
};

export const cf = async <T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> =>
  (await cfRaw(env, method, path, body)).result;
