// Things that are not MCP servers, turned into the source of an app module
// (see app-runtime.ts) so the portal can serve them like any other integration:
// OpenAPI documents, Google Discovery documents, GraphQL endpoints and skills.

import { parse } from "yaml";
import { httpsUrl, InputError, secretName } from "./mapping.ts";

type Param = { name: string; in: string; required?: boolean; schema?: object };
type Op = { name: string; description: string; method: string; path: string; params: { name: string; in: string }[]; body: boolean; input: object };

// Replace every $ref with what it points to. A schema that refers back to
// itself becomes {} (anything) at the point of recursion.
function inline(node: any, lookup: (ref: string) => any, seen: string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => inline(n, lookup, seen));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") return seen.includes(node.$ref) ? {} : inline(lookup(node.$ref), lookup, [...seen, node.$ref]);
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inline(v, lookup, seen)]));
}

function operation(id: string, description: unknown, method: string, path: string, params: Param[], body: unknown): Op {
  const properties: Record<string, unknown> = Object.fromEntries(params.map((p) => [p.name, p.schema ?? {}]));
  // A body schema too big to be useful in a tool listing is left open; the call still goes through.
  if (body)
    properties.body = // ponytail: a parameter that is itself called "body" is shadowed
      JSON.stringify(body).length > 20_000 ? { type: "object", description: "Request body. Its schema is too large to list here; see the API's documentation." } : body;
  return {
    name: id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64),
    description: String(description ?? "").slice(0, 300),
    method: method.toUpperCase(),
    path,
    params: params.map((p) => ({ name: p.name, in: p.in })),
    body: Boolean(body),
    input: { type: "object", properties, required: params.filter((p) => p.required).map((p) => p.name) },
  };
}

function openapi(doc: any, specUrl?: string, baseUrl?: string) {
  if (!doc?.openapi || !doc.paths) throw new InputError("Not an OpenAPI 3 document");
  const lookup = (ref: string) =>
    ref.startsWith("#/") ? ref.slice(2).split("/").reduce((n, k) => n?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc) ?? {} : {};
  const ops: Op[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths))
    for (const method of ["get", "put", "post", "delete", "patch"]) {
      const op = item?.[method];
      if (!op) continue;
      const params: Param[] = inline([...(item.parameters ?? []), ...(op.parameters ?? [])], lookup)
        .filter((p: any) => ["path", "query", "header"].includes(p.in))
        .map((p: any) => ({ name: p.name, in: p.in, required: p.required, schema: { ...p.schema, ...(p.description && { description: p.description }) } }));
      const body = inline(op.requestBody, lookup)?.content?.["application/json"]?.schema;
      ops.push(operation(op.operationId ?? `${method}_${path}`, op.summary ?? op.description, method, path, params, body));
    }
  let base: string | undefined;
  try {
    base = new URL(baseUrl || doc.servers?.[0]?.url || "", specUrl).href;
  } catch {}
  return { base, ops };
}

function discovery(doc: any, baseUrl?: string) {
  if (!doc?.rootUrl) throw new InputError("Not a Google Discovery document");
  const lookup = (ref: string) => doc.schemas?.[ref] ?? {};
  const ops: Op[] = [];
  (function walk(node: any) {
    for (const m of Object.values<any>(node.methods ?? {}))
      ops.push(
        operation(
          m.id,
          m.description,
          m.httpMethod,
          m.path,
          Object.entries<any>(m.parameters ?? {}).map(([name, p]) => ({
            name,
            in: p.location,
            required: p.required,
            schema: { ...(p.repeated ? { type: "array", items: { type: p.type } } : { type: p.type }), ...(p.description && { description: p.description }) },
          })),
          m.request && inline(m.request, lookup),
        ),
      );
    for (const child of Object.values(node.resources ?? {})) walk(child);
  })(doc);
  return { base: baseUrl || doc.rootUrl + (doc.servicePath ?? ""), ops };
}

// The generated module's fixed half. Plain JavaScript; `config` is prepended.
const CLIENT = String.raw`
async function send(method, url, headers, body, env) {
  const auth = config.auth;
  if (auth.type !== "none") {
    if (!env.API_TOKEN) throw new Error("This integration has no credential yet. An admin must set its API_TOKEN secret in runkle.");
    if (auth.type === "bearer") headers.Authorization = "Bearer " + env.API_TOKEN;
    if (auth.type === "header") headers[auth.name] = env.API_TOKEN;
    if (auth.type === "query") url.searchParams.set(auth.name, env.API_TOKEN);
  }
  for (const [name, secret] of Object.entries(config.secretHeaders)) {
    if (!env[secret]) throw new Error("This integration is missing a credential. An admin must set its " + secret + " secret in runkle.");
    headers[name] = env[secret];
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 2000));
  return text;
}

const rest = (op) => (input, env) => {
  // {name} is one path segment; Google's {+name} may span several.
  const path = op.path.replace(/\{(\+?)([^}]+)\}/g, (_, raw, key) => (raw ? encodeURI : encodeURIComponent)(input[key]));
  const url = new URL(config.base.replace(/\/$/, "") + "/" + path.replace(/^\//, ""));
  const headers = {};
  for (const p of op.params) {
    const value = input[p.name];
    if (value == null) continue;
    if (p.in === "query") for (const item of [].concat(value)) url.searchParams.append(p.name, String(item));
    if (p.in === "header") headers[p.name] = String(value);
  }
  if (op.body) headers["Content-Type"] = "application/json";
  return send(op.method, url, headers, op.body ? input.body : undefined, env);
};

const post = (body, env) => send("POST", new URL(config.base), { "Content-Type": "application/json" }, body, env);
const graphql = {
  query: {
    description: "Run a GraphQL query or mutation against " + config.base + ". Call schema first to learn the types.",
    input: { type: "object", properties: { query: { type: "string" }, variables: { type: "object" } }, required: ["query"] },
    run: (input, env) => post({ query: input.query, variables: input.variables }, env),
  },
  schema: {
    description: "List the GraphQL schema's types with their fields and arguments.",
    run: (input, env) => post({ query: "{ __schema { queryType { name } mutationType { name } types { name kind description fields { name description args { name type { name kind ofType { name kind } } } type { name kind ofType { name kind } } } inputFields { name type { name kind ofType { name kind } } } enumValues { name } } } }" }, env),
  },
};

export const tools = config.graphql
  ? graphql
  : Object.fromEntries(config.ops.map((op) => [op.name, { description: op.description, input: op.input, run: rest(op) }]));
`;

export async function sourceApp(input: any): Promise<string> {
  const auth = { type: input.auth ?? "none", name: String(input.auth_name ?? "").trim() };
  if (!["none", "bearer", "header", "query"].includes(auth.type)) throw new InputError("Unknown authentication method");
  if (["header", "query"].includes(auth.type) && !/^[A-Za-z0-9_-]+$/.test(auth.name))
    throw new InputError("Give the name of the header or query parameter that carries the credential");

  // Extra credentials for APIs that need more than one: header name -> name of the secret that fills it.
  const secretHeaders: Record<string, string> = {};
  for (const [header, secret] of Object.entries(input.secret_headers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(header)) throw new InputError(`"${header}" is not a header name`);
    secretHeaders[header] = secretName(secret);
  }

  let config: { base?: string; ops: Op[]; graphql?: boolean };
  if (input.kind === "graphql") config = { base: httpsUrl(input.url, "GraphQL endpoint"), ops: [], graphql: true };
  else if (input.kind === "openapi" || input.kind === "discovery") {
    let text = input.spec;
    if (typeof text !== "string" || !text.trim()) {
      const res = await fetch(httpsUrl(input.url, "Spec URL"));
      if (!res.ok) throw new InputError(`Couldn't fetch the spec (HTTP ${res.status})`);
      text = await res.text();
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text); // far cheaper than the YAML parser on a large document
    } catch {
      try {
        doc = parse(text);
      } catch {
        throw new InputError("The spec is not valid JSON or YAML");
      }
    }
    config = input.kind === "openapi" ? openapi(doc, input.url || undefined, input.base_url) : discovery(doc, input.base_url);
    const filter = String(input.filter ?? "").trim().toLowerCase();
    if (filter) config.ops = config.ops.filter((op) => `${op.name} ${op.path}`.toLowerCase().includes(filter));
    if (input.read_only) config.ops = config.ops.filter((op) => op.method === "GET");
    if (!config.ops.length) throw new InputError("No operations found");
  } else throw new InputError("Pick a format");

  config.base = httpsUrl(config.base, "The API's base URL");
  const source = `const config = ${JSON.stringify({ ...config, auth, secretHeaders })};\n${CLIENT}`;
  // ponytail: every schema is inlined, so a huge API has to be narrowed with `filter`. Share schemas if that bites.
  if (source.length > 1_000_000)
    throw new InputError(`This API is too large to import whole (${config.ops.length} operations). Narrow it with a filter such as a path prefix.`);
  return source;
}

// Each skill is { name, description, content }, or a Markdown string whose
// front matter carries the name and description.
export function skillsApp(list: unknown): string {
  if (!Array.isArray(list) || !list.length) throw new InputError("Add at least one skill");
  const skills: Record<string, { description: string; content: string }> = {};
  for (const item of list) {
    let { name, description, content } = typeof item === "string" ? { name: undefined, description: undefined, content: item } : (item ?? {});
    const front = typeof content === "string" && content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (front) {
      let meta: any;
      try {
        meta = parse(front[1]);
      } catch {
        throw new InputError("A skill's front matter is not valid YAML");
      }
      name ??= meta?.name;
      description ??= meta?.description;
      content = content.slice(front[0].length);
    }
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
      throw new InputError(`Skill name "${name ?? ""}" must be lowercase letters, digits and dashes`);
    if (typeof content !== "string" || !content.trim()) throw new InputError(`Skill ${name} is empty`);
    skills[name] = { description: String(description ?? "").slice(0, 300), content };
  }
  return `export const skills = ${JSON.stringify(skills)};\n`;
}
