// The inbox: everything that waits for a person, in one Durable Object, and
// the browsers to tell when something new arrives. It holds tool calls that ask
// first, proposed script changes, secrets an agent asked for, integrations to
// set up, and alerts. runkle's UI shows it and decides; Web Push announces it.
// Apps reach it through a binding (RUNKLE_INBOX) their own code never sees.
//
// It is a plain Durable Object spoken to with fetch, so the tests can run it
// on Node without the Workers runtime.

import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";

export type Kind = "approval" | "review" | "secrets" | "setup" | "alert";
export type Item = {
  id: string;
  kind: Kind;
  app?: string;
  title: string;
  detail?: string;
  tool?: string;
  input?: unknown;
  link?: string; // where in runkle's UI the person acts, when the inbox itself cannot settle it
  state: "open" | "approved" | "denied" | "used" | "done";
  created: number;
  expires?: number;
  by?: string;
  decided?: number;
};

// How long a tool call waits for a person, and how long their approval waits to be used.
export const WAIT = 60 * 60 * 1000;
// How long decided items and the log are kept.
const KEEP = 30 * 24 * 60 * 60 * 1000;

type Storage = {
  get(key: string): Promise<any>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<Map<string, any>>;
};

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async (text: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).slice(0, 32);

const isOpen = (item: Item | undefined, now: number): boolean => Boolean(item && item.state === "open" && (item.expires ?? Infinity) >= now);

export class Inbox {
  private storage: Storage;
  constructor(state: { storage: Storage }, _env?: unknown) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const { op, ...args } = (await request.json()) as any;
    const handler = (this as any)[`op_${op}`];
    if (typeof handler !== "function") return Response.json({ error: `Unknown op ${op}` }, { status: 400 });
    return Response.json((await handler.call(this, args)) ?? null);
  }

  private item = (id: string): Promise<Item | undefined> => this.storage.get(`item:${id}`);
  private save = (item: Item) => this.storage.put(`item:${item.id}`, item);
  private log = (item: Item) =>
    this.storage.put(`log:${new Date(item.decided ?? Date.now()).toISOString()}:${item.id}`, {
      at: new Date(item.decided ?? Date.now()).toISOString(),
      id: item.id,
      kind: item.kind,
      app: item.app,
      title: item.title,
      tool: item.tool,
      input: item.input,
      decision: item.state === "used" ? "approved" : item.state,
      by: item.by,
    });

  // A tool call that must ask first. The call is the item: the same app, tool
  // and arguments find the same item, so asking again does not start over, and
  // an approval is used up by the one call it covers.
  async op_ask({ id, app, tool, input, summary, ui }: any) {
    const now = Date.now();
    const item = await this.item(id);
    if (item && item.state !== "used" && (item.expires ?? Infinity) >= now) {
      if (item.state === "approved") {
        await this.save({ ...item, state: "used" });
        return { state: "approved" };
      }
      return { state: item.state, by: item.by, expires: item.expires };
    }
    const fresh: Item = { id, kind: "approval", app, tool, input, title: summary || `${tool} on ${app}`, state: "open", created: now, expires: now + WAIT };
    await this.save(fresh);
    return { state: "open", expires: fresh.expires, notified: await this.push(fresh, ui) };
  }

  // Something else that waits for the person. Opening an item that is already
  // open refreshes it without notifying again.
  async op_open({ item, ui }: { item: Pick<Item, "id" | "kind" | "title"> & Partial<Item>; ui: string }) {
    const now = Date.now();
    const old = await this.item(item.id);
    const next: Item = { ...item, state: "open", created: isOpen(old, now) ? old!.created : now } as Item;
    delete next.by;
    delete next.decided;
    await this.save(next);
    return { notified: isOpen(old, now) ? 0 : await this.push(next, ui) };
  }

  // Settled outside the inbox: a review decided, secrets entered, a server added.
  async op_close({ id, state, by }: { id: string; state: Item["state"]; by?: string }) {
    const item = await this.item(id);
    if (!item || !isOpen(item, Date.now())) return { closed: false };
    const done: Item = { ...item, state, by, decided: Date.now() };
    await this.save(done);
    if (state !== "done") await this.log(done);
    return { closed: true };
  }

  async op_decide({ id, approve, by }: { id: string; approve: boolean; by: string }) {
    const now = Date.now();
    const item = await this.item(id);
    if (!item || !isOpen(item, now) || item.kind !== "approval") return null;
    const done: Item = { ...item, state: approve ? "approved" : "denied", by, decided: now, expires: now + WAIT };
    await this.save(done);
    await this.log(done);
    return done;
  }

  op_get = ({ id }: { id: string }) => this.item(id);

  // What is waiting, and the last decisions, newest first. Old entries are dropped here.
  async op_list() {
    const now = Date.now();
    const items = [...(await this.storage.list({ prefix: "item:" })).values()] as Item[];
    const log = [...(await this.storage.list({ prefix: "log:" })).entries()];
    for (const item of items)
      if ((item.decided ?? item.expires ?? item.created) + KEEP < now && !isOpen(item, now)) await this.storage.delete(`item:${item.id}`);
    for (const [key, entry] of log) if (Date.parse(entry.at) + KEEP < now) await this.storage.delete(key);
    return {
      waiting: items.filter((i) => isOpen(i, now)).sort((a, b) => b.created - a.created),
      decided: log
        .map(([, e]) => e)
        .reverse()
        .slice(0, 50),
    };
  }

  // ---- Web Push ----
  //
  // runkle keeps no one's credentials, but it does sign its own notifications:
  // the key is made here on first use and never leaves this object. It can only
  // send notifications to browsers that subscribed to it.

  private async vapid() {
    let keys = await this.storage.get("vapid");
    if (!keys) {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
      keys = { publicKey: b64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: jwk.d };
      await this.storage.put("vapid", keys);
    }
    return keys as { publicKey: string; privateKey: string };
  }

  op_key = async () => ({ publicKey: (await this.vapid()).publicKey });

  async op_subscribe({ subscription, by }: { subscription: PushSubscription; by: string }) {
    const endpoint = subscription?.endpoint;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || !subscription.keys?.p256dh || !subscription.keys?.auth)
      return { error: "Not a push subscription" };
    await this.storage.put(`push:${await sha(endpoint)}`, { endpoint, expirationTime: null, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, by, since: Date.now() });
    return { subscribed: true };
  }

  async op_unsubscribe({ endpoint }: { endpoint: string }) {
    return { unsubscribed: await this.storage.delete(`push:${await sha(String(endpoint))}`) };
  }

  op_test = ({ ui }: { ui: string }) =>
    this.push({ id: "", kind: "alert", title: "Notifications are on", detail: "runkle will tell you here when something needs you.", state: "open", created: Date.now() }, ui);

  // Sends to every subscribed browser and returns how many took it. A browser
  // that unsubscribed is forgotten. The notification names the item, never its arguments.
  private async push(item: Item, ui: string): Promise<number> {
    const subs = [...(await this.storage.list({ prefix: "push:" })).entries()];
    if (!subs.length) return 0;
    const keys = await this.vapid();
    const title = { approval: `Approve ${item.tool}?`, review: "Review a script change", secrets: "Secrets requested", setup: "Integration to set up", alert: item.title }[item.kind];
    const body = item.kind === "alert" ? (item.detail ?? "") : item.title;
    const data = JSON.stringify({ title, body, url: item.id ? `/#${new URLSearchParams({ inbox: item.id })}` : "/#inbox", tag: item.id || "runkle" });
    let sent = 0;
    for (const [key, sub] of subs) {
      try {
        const payload = await buildPushPayload({ data, options: { ttl: item.expires ? Math.round((item.expires - Date.now()) / 1000) : 86400, urgency: "high" } }, sub, {
          subject: ui,
          ...keys,
        });
        const res = await fetch(sub.endpoint, payload);
        if (res.status === 404 || res.status === 410) await this.storage.delete(key);
        else if (res.ok) sent++;
      } catch {
        // One browser failing must not stop the others or the call that asked.
      }
    }
    return sent;
  }
}

// How runkle's own Worker and the app runtime talk to the inbox.
export const inbox = (ns: DurableObjectNamespace) => {
  const stub = ns.get(ns.idFromName("inbox"));
  return async (op: string, args: Record<string, unknown> = {}): Promise<any> =>
    (await stub.fetch("https://inbox/", { method: "POST", body: JSON.stringify({ op, ...args }) })).json();
};
