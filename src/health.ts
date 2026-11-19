// Whether each integration works, checked before an agent finds out by failing.
// Read-only: it changes no integration. The daily Cron Trigger (src/index.ts)
// and the UI's Check now also turn each problem into an inbox alert.
//
// What runkle can see without anyone's token:
// - every integration: the portal's own record of it (last sync, error, admin sign-in)
// - apps: the secret names set on the Worker against the names its code reads,
//   the expiry dates entered for those secrets, and the result of the app's
//   own `probe`, which the app runs with its secrets when runkle asks
// Each person's own sign-ins are held by the portal and are not visible here.

import { appConfig, deployedSource, isApp, scriptName } from "./apps.ts";
import { appFetch, type Env } from "./cloudflare.ts";
import { inbox } from "./inbox.ts";
import { sourceSecrets } from "./sources.ts";

// Worst first: the order an integration's status is chosen in.
const KINDS = ["upstream_error", "needs_sign_in", "missing_secret", "expiring", "unused_secret"] as const;
export type Kind = (typeof KINDS)[number];
export type Problem = { kind: Kind; secret?: string; reason: string; fix: string };
export type Health = { id: string; name: string; status: "ok" | Kind; problems: Problem[]; note?: string };
export type Report = { checked_at: string; integrations: Health[]; sign_in: string };

// A secret that expires within this many days is a problem.
export const SOON = 14;
const DAY = 24 * 60 * 60 * 1000;

// The env names a module reads: env.NAME, env["NAME"] and { NAME } = env
// (or `secrets` for env). A module generated from an API reads them by a name
// held in its config, so that is asked of sources.ts instead.
export function secretReads(source: string): string[] {
  const generated = sourceSecrets(source);
  if (generated) return generated;
  const names = new Set<string>();
  for (const [, name] of source.matchAll(/\b(?:env|secrets)\s*\??\.\s*([A-Z][A-Z0-9_]*)\b/g)) names.add(name);
  for (const [, , name] of source.matchAll(/\b(?:env|secrets)\s*(?:\?\.)?\[\s*(["'`])([A-Z][A-Z0-9_]*)\1\s*\]/g)) names.add(name);
  for (const [, list] of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:env|secrets)\b/g))
    for (const part of list.split(",")) if (/^[A-Z][A-Z0-9_]*$/.test(part.trim().split(/[\s:=]/)[0])) names.add(part.trim().split(/[\s:=]/)[0]);
  return [...names].filter((name) => !name.startsWith("RUNKLE_"));
}

const SYNC = "Sync it in runkle. If that fails too, check the server and its credentials.";

// What the portal knows about any integration, app or not.
function portalProblems(s: any): Problem[] {
  const problems: Problem[] = [];
  const error = s.error_details?.cause ?? s.error;
  if (error) problems.push({ kind: "upstream_error", reason: `The portal reports: ${String(error).slice(0, 200)}`, fix: SYNC });
  else if (s.status === "stale") problems.push({ kind: "upstream_error", reason: "The portal could not refresh its tools at the last sync.", fix: SYNC });
  if (s.status === "waiting" || /^(?:required|expired|invalid|failed)$/i.test(s.authentication_status ?? ""))
    problems.push({
      kind: "needs_sign_in",
      reason: `The portal has no working sign-in to it${s.authentication_status ? ` (${s.authentication_status})` : ""}.`,
      fix:
        s.auth_config_summary?.auth_mode === "manual"
          ? "Sign in to it once from an agent when the portal asks, then sync it in runkle."
          : "Open Admin sign-in in runkle, re-authenticate this server on the MCP servers tab, then sync it in runkle.",
    });
  return problems;
}

// Asks the app to run its probe. The key goes into runkle's inbox first, where
// the app checks it, so only runkle can make an app call its upstream this way.
async function probe(env: Env, s: any): Promise<{ problem?: Problem; note?: string }> {
  const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await inbox(env.INBOX)("probe_key", { app: s.id, key });
  const res = await appFetch(env, new URL(s.hostname).host, "/manifest/probe", {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (res?.status === 404) return { note: "Not probed: it was deployed before health checks. Update it in runkle once (the same script will do) to add them." };
  if (!res?.ok)
    return { problem: { kind: "upstream_error", reason: `It did not answer runkle's probe${res ? ` (HTTP ${res.status})` : ""}.`, fix: `Read the logs of the Worker ${scriptName(s.id)} in the Cloudflare dashboard.` } };
  const out: any = await res.json().catch(() => ({}));
  if (!out.probed) return { note: "Its code declares no probe, so only its secrets and the portal's record were checked." };
  if (!out.ok) return { problem: { kind: "upstream_error", reason: `Its probe failed: ${String(out.error).slice(0, 200)}`, fix: "Check its secrets and the service it calls, then check again." } };
  return {};
}

async function appProblems(env: Env, s: any, dates: Record<string, string>, today: number): Promise<{ problems: Problem[]; note?: string }> {
  const [config, source, probed] = await Promise.all([appConfig(env, s.id), deployedSource(env, s.id), probe(env, s)]);
  const reads = secretReads(source);
  const problems: Problem[] = [];
  for (const name of reads)
    if (!config.secrets.includes(name))
      problems.push({ kind: "missing_secret", secret: name, reason: `Its code reads ${name}, which is not set.`, fix: "Enter it under Update script or secrets in runkle, or have an agent send you a link with request_credentials." });
  for (const name of config.secrets)
    if (!reads.includes(name))
      problems.push({
        kind: "unused_secret",
        secret: name,
        reason: `${name} is set, but its code never reads it by name.`,
        fix: `If nothing needs it, delete it from the Worker ${scriptName(s.id)} in the Cloudflare dashboard (Settings, Variables and Secrets).`,
      });
  for (const [name, date] of Object.entries(dates)) {
    if (!config.secrets.includes(name)) continue;
    const days = Math.floor((Date.parse(`${date}T00:00:00Z`) - today) / DAY);
    if (days > SOON) continue;
    const when = days < 0 ? `expired on ${date}` : days === 0 ? `expires today (${date})` : `expires on ${date}, in ${days} day${days === 1 ? "" : "s"}`;
    problems.push({ kind: "expiring", secret: name, reason: `${name} ${when}.`, fix: "Rotate it, then enter the new value and its new expiry date under Update script or secrets in runkle." });
  }
  if (probed.problem) problems.push(probed.problem);
  return { problems, note: probed.note };
}

// `session` is how long a sign-in to the portal lasts (its Access application's session_duration).
export async function check(env: Env, servers: any[], session?: string): Promise<Report> {
  const now = Date.now();
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const expiries = await inbox(env.INBOX)("expiries");
  const integrations = await Promise.all(
    servers.map(async (s): Promise<Health> => {
      const problems = portalProblems(s);
      let note: string | undefined;
      if (isApp(s)) {
        try {
          const app = await appProblems(env, s, expiries[s.id] ?? {}, today);
          problems.push(...app.problems);
          note = app.note;
        } catch (error) {
          problems.push({ kind: "upstream_error", reason: `runkle could not read the app: ${(error as Error).message}`, fix: "Check again later; if it persists, check runkle's API token." });
        }
      }
      problems.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
      return { id: s.id, name: s.name, status: problems[0]?.kind ?? "ok", problems, ...(note && { note }) };
    }),
  );
  return {
    checked_at: new Date(now).toISOString(),
    integrations,
    sign_in:
      "Each person's own sign-ins to the portal and to OAuth servers are held by Cloudflare out of runkle's sight, so one that lapses shows only when a call fails." +
      (session ? ` A portal sign-in lasts ${session} (the portal's Access session duration); after that, agents sign in again.` : ""),
  };
}

// One inbox alert per problem. The id names the integration, the kind and the
// secret, so a problem that stands is the same open item and notifies once; an
// alert whose problem is gone is closed. The report is kept for the UI.
export async function alert(env: Env, report: Report, ui?: string) {
  const box = inbox(env.INBOX);
  const open = new Set<string>();
  for (const i of report.integrations)
    for (const p of i.problems) {
      const id = ["health", i.id, p.kind.replace(/_/g, "-"), ...(p.secret ? [p.secret.toLowerCase().replace(/_/g, "-")] : [])].join(":");
      open.add(id);
      await box("open", { ui, item: { id, kind: "alert", app: i.id, title: `${i.name}: ${p.reason}`, detail: p.fix } });
    }
  for (const item of (await box("list")).waiting) if (item.id.startsWith("health:") && !open.has(item.id)) await box("close", { id: item.id, state: "done" });
  await box("health", { report });
  return report;
}
