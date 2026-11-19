// generate_secret: a credential runkle makes itself and sets where it is used,
// so no person has to paste it and no agent ever sees it. This file is the
// pure part: what a request may ask for, what the person is shown, and the
// value. The operation is `generateSecret` in src/ops.ts.

import { InputError, secretName } from "./mapping.ts";

// Where a value goes: a secret binding on an app's Worker, or the bearer token
// the portal sends to a remote MCP server.
export type Target = { app: string; secret: string } | { server: string };
// Where a copy is kept: a runkle app that exports `vault` (scripts/onepassword.js).
export type CopyTo = { app: string; vault: string; item: string; field: string };
export type Request = { targets: Target[]; length: number; alphabet: Alphabet; copy_to?: CopyTo };

export const ALPHABETS = {
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  hex: "0123456789abcdef",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
};
type Alphabet = keyof typeof ALPHABETS;

const id = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,32}$/.test(value)) throw new InputError(`${label} must be an integration id from list_integrations`);
  return value;
};
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new InputError(`${label} is required (at most 200 characters)`);
  return value.trim();
};

// The one shape a request is kept in, so the same request always finds the
// same inbox item, and the person is shown exactly what will run.
export function generateRequest(input: any): Request {
  if (!Array.isArray(input?.targets) || !input.targets.length || input.targets.length > 10) throw new InputError("Name 1 to 10 targets");
  const targets: Target[] = input.targets.map((t: any) =>
    t?.server !== undefined && t?.app === undefined && t?.secret === undefined
      ? { server: id(t.server, "server") }
      : { app: id(t?.app, "app"), secret: secretName(t?.secret) },
  );
  const keys = targets.map((t) => ("server" in t ? `server ${t.server}` : `${t.app} ${t.secret}`));
  if (new Set(keys).size !== keys.length) throw new InputError("A target is named twice");
  const length = input.length ?? 40;
  if (!Number.isInteger(length) || length < 16 || length > 128) throw new InputError("length must be a whole number from 16 to 128");
  const alphabet = input.alphabet ?? "alphanumeric";
  if (!Object.hasOwn(ALPHABETS, alphabet)) throw new InputError(`alphabet must be one of ${Object.keys(ALPHABETS).join(", ")}`);
  const c = input.copy_to;
  const copy_to = c == null ? undefined : { app: id(c.app, "copy_to.app"), vault: text(c.vault, "copy_to.vault"), item: text(c.item, "copy_to.item"), field: text(c.field, "copy_to.field") };
  return { targets, length, alphabet, ...(copy_to && { copy_to }) };
}

// What the person approves. Names where the value goes, never a value (there is none yet).
export function describe(r: Request, unreviewed: string[]): string {
  const where = r.targets.map((t) => ("server" in t ? `as the bearer token the portal sends to ${t.server}` : `as ${t.secret} on ${t.app}`));
  return [
    `Generate a ${r.length}-character ${r.alphabet} secret and set it ${where.join(" and ")}.`,
    r.copy_to ? `Keep a copy in vault "${r.copy_to.vault}", item "${r.copy_to.item}", field "${r.copy_to.field}" (through ${r.copy_to.app}).` : "No copy is kept anywhere else.",
    unreviewed.length ? `${unreviewed.join(" and ")} ${unreviewed.length > 1 ? "hold" : "holds"} no secrets yet, so no person has reviewed that code, and it can read the value.` : "",
    "Nobody sees the value.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Uniform over the alphabet: bytes past the last whole multiple of its size are drawn again.
export function randomSecret(length: number, alphabet: Alphabet): string {
  const chars = ALPHABETS[alphabet];
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length)
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) if (byte < limit && out.length < length) out += chars[byte % chars.length];
  return out;
}

// The same JSON whatever order the keys came in (as in src/app-runtime.ts).
export const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(v === undefined ? null : v);
