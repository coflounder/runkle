# runkle

One MCP endpoint for all your integrations, self-hosted entirely on Cloudflare.

Add remote MCP servers in a small web UI, choose which of their tools agents
may call, and point any agent at a single URL. Each person signs in to each
integration with their own account; credentials never reach the agent.

Things that are not MCP servers can be integrations too: an HTTP API described
by an OpenAPI or Google Discovery document, a GraphQL endpoint, a pack of
skills, or your own script with storage, schedules, webhooks, pages and
workflows. Agents can manage all of it through runkle's own MCP tools.

runkle is one Cloudflare Worker and no database. It is a management layer over
things Cloudflare already runs for you:

- **[MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)**
  serve the endpoint, hold each user's upstream tokens, filter tools, and log calls.
- **[Access managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)**
  lets agents register as OAuth clients and sign users in.
- **Workers** run each script, API source and skill pack, with secrets held as
  Worker secrets. Durable Objects give scripts storage, Cron Triggers run their
  schedules, and Workflows run their workflows.

## What it does

- Add an integration by URL: no auth, an access token, OAuth set up
  automatically, or OAuth with your own client ID and secret.
- Add an HTTP API and get one tool per operation (see [HTTP APIs](#http-apis)).
- Publish skills: written instructions agents can read (see [Skills](#skills)).
- Upload a script and get its functions as tools, plus storage, schedules,
  webhooks, pages and workflows (see [Scripts](#scripts)).
- Allow or block each tool, or have it ask you first (see [Approvals](#approvals) and [Inbox](#inbox)).
- Generate a credential nobody types or sees, set it where it is used, and
  keep a copy in 1Password (see [Generated secrets](#generated-secrets)).
- Re-sync and remove integrations.
- Check that every integration works, daily and on demand, and hear about problems first (see [Health](#health)).
- Choose which agent clients may register (localhost, loopback, listed redirect URIs).
- Turn on code mode, where agents get `search` and `execute` instead of every tool.
- Group integrations into collections, each its own endpoint, such as
  Personal and Work (see [Collections](#collections)).
- Do all of the above from an agent (see [Managing runkle from an agent](#managing-runkle-from-an-agent)).

## What it doesn't

- An HTTP API uses one credential shared by everyone. Per-person sign-in is
  only for MCP servers.
- "Ask me first" works for tools that run on runkle (scripts, HTTP APIs).
  The portal calls a remote MCP server directly, so its tools can only be
  allowed or blocked.
- The one-time admin sign-in for automatically registered OAuth servers
  happens in the Cloudflare dashboard; the API has no way to start it.
  Integrations that use your own OAuth client don't need it.
- Collections share the main portal's Access policy, so they scope what an
  agent sees, not who may sign in.
- Uploaded scripts are a single module with no npm imports. They can `fetch`
  and use the Web APIs.
- No catalog of ready-made apps beyond the few in `scripts/`.

## Scripts

A script is one JavaScript module that exports `tools`:

```js
export const tools = {
  recent_activities: {
    description: "List my most recent Garmin activities",
    input: { type: "object", properties: { limit: { type: "number" } } }, // JSON Schema
    annotations: { readOnlyHint: true }, // optional MCP tool annotations
    async run({ limit = 10 }, env) {
      const res = await fetch("https://example.com/activities?limit=" + limit, {
        headers: { Authorization: "Bearer " + env.GARMIN_TOKEN },
      });
      return res.json(); // anything JSON-serialisable, or a string
    },
  },
};
```

A tool may also declare `output`, a JSON Schema of what `run` returns, sent
to agents as its `outputSchema`, and `annotations`, passed through as-is (MCP's
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). A plain
object `run` returns reaches the agent both as text and as `structuredContent`.
An argument whose name `input.properties` does not list is refused with an
error naming the allowed ones, unless `input` sets `additionalProperties: true`.

Choose **Add integration > Upload a script**, pick the file, and add the
secrets it reads from `env`. runkle deploys it as a Worker named
`runkle-app-<name>` on your account and registers it with the portal.

A tool can ask you first. Add `approval: true`, or a function that decides
per call and says what you would be agreeing to:

```js
merge: {
  approval: async ({ repo, number }, env) => `Merge pull request ${number} in ${repo}`, // return nothing to run unasked
  async run({ repo, number }, env) { /* ... */ },
},
```

`tools` is one of seven things a script can export. All are optional:

```js
// Instructions agents can read through a `skills` tool.
export const skills = {
  weekly_report: { description: "How to write my weekly training report", content: "# Steps\n..." },
};

// Run on a cron expression (UTC).
export const schedules = {
  nightly: { cron: "0 6 * * *", async run(env, ctx) { await ctx.storage.put("synced", Date.now()); } },
};

// Public at https://runkle-app-<name>.<you>.workers.dev/webhooks/activity
export const webhooks = {
  async activity(request, env, ctx) {
    // Anyone can call this. Check the sender's signature with a secret from env.
    await ctx.storage.put("last", await request.json());
    return "ok";
  },
};

// At .../pages/dashboard, for people your portal's Access policies allow.
export const pages = {
  dashboard: async (request, env, ctx) => "<h1>Last sync: " + (await ctx.storage.get("synced")) + "</h1>",
};

// Durable multi-step runs on Cloudflare Workflows: each step is retried and remembered.
export const workflows = {
  async backfill(step, input, env, ctx) {
    const ids = await step.do("list", async () => [1, 2, 3]);
    for (const id of ids) await step.do("fetch " + id, async () => ctx.storage.put("a:" + id, id));
  },
};

// A cheap call that throws when the script's secrets or the service behind it
// do not work. runkle runs it when it checks integrations (see Health).
export const probe = async (env, ctx) => {
  const res = await fetch("https://example.com/me", { headers: { Authorization: "Bearer " + env.GARMIN_TOKEN } });
  if (!res.ok) throw new Error("HTTP " + res.status);
};

// Keeps a copy of a secret runkle generated (see Generated secrets). Only runkle
// calls it, with the value as an argument; no agent can.
export const vault = {
  async save({ vault, item, field, value }, env, ctx) { /* write it to your password manager */ },
};
```

Every handler gets `env` (the script's secrets) and `ctx`:

| | |
| --- | --- |
| `ctx.storage` | `get(key)`, `put(key, value)`, `delete(key)`, `list(prefix)`. Durable, private to the script, kept across updates, deleted with it. |
| `ctx.origin` | The script's own address, in tools, webhooks and pages. A page is at `ctx.origin + "/pages/<name>"`. |
| `ctx.workflows` | `start(name, input)` returns a run id; `status(id)` reports on it. |

Tools get it as their third argument: `run(input, env, ctx)`. After an upload
runkle shows the script's webhook and page addresses.

Cloudflare's free plan allows five cron schedules per account.

Anyone who can open runkle can run code on your Cloudflare account this way.
Keep the Access policy on the runkle Worker to people you would give that to.

## HTTP APIs

Choose **Add integration > HTTP API** and give the address of an OpenAPI 3 or
Google Discovery document (JSON or YAML), or upload it. Each operation becomes
a tool, described by its summary or else by its method and path
(`POST /compose.redeploy`), and marked read-only for GET, destructive for
DELETE and idempotent for GET, PUT and DELETE. JSON responses come back
structured. For a GraphQL endpoint you get two tools, `query` and `schema`.

If the API needs a key, say how it is sent (bearer token, a named header, or a
named query parameter) and enter it. It is stored as the integration's
`API_TOKEN` secret and used for every caller. A very large API has to be
narrowed with the filter field, for example to one path prefix.

Two more options exist only for agents, on the `add_api_source` tool:
`read_only` imports just the GET operations, and `secret_headers` covers an
API that needs several credentials by naming a secret for each header (for
example `{"x-api-key": "API_KEY"}`). You then set those secrets under
**Update script or secrets**, or through a link from `request_credentials`.

## Skills

Choose **Add integration > Skills** and pick one or more Markdown files:

```md
---
name: weekly-report
description: How to write my weekly training report
---
# Steps
...
```

Agents see a `skills` tool whose description lists each skill, and call it to
read one. A script can carry skills of its own (see [Scripts](#scripts)).

## Secrets

runkle stores no secrets itself. Everything typed into the UI is passed
straight to Cloudflare and can be replaced but never read back:

| secret | where it lives |
| --- | --- |
| access token for an integration, OAuth client secret | the portal's server record, encrypted by Cloudflare |
| a script's secrets, an HTTP API's key | secret bindings on that integration's Worker |
| the token that lets the portal call a script | generated by runkle, set on both sides, never shown or stored |
| a [generated secret](#generated-secrets) | wherever it was set, plus a copy in 1Password if you asked |
| each person's sign-in to an integration | the portal, per user |

In the browser, secret fields are masked and wiped when their dialog closes,
responses are never cached, and a strict content security policy blocks any
script that isn't runkle's own. A script only receives its own secrets, and
only answers requests that carry the portal's token.

Don't paste a secret into a script's source. Use a secret field, or have
runkle generate it.

A secret that expires can carry the date beside its value. The date is all
runkle keeps (in its inbox); a new value takes the date entered with it, or
none. Agents can record a date with `set_secret_expiry`, never a value.

A script's code can read its secrets, so an agent cannot change a script that
holds any. Its update waits as a proposal in your [inbox](#inbox): you read the diff and
approve or reject it. An update that changes nothing in the code you last
approved goes out at once. Until
then the code you last approved keeps running, and the script's secrets cannot
be edited.

## Generated secrets

Many credentials are just a random string that two sides must share: a token
the portal sends to your own MCP server, a webhook signing key, a password for
a tunnel. runkle can make one itself, so nobody pastes it anywhere:

- **From the UI**: in **Update script or secrets**, add a secret name and tick
  **Generate** instead of typing a value.
- **From an agent**: `generate_secret` names where the value goes (secrets on
  scripts or HTTP APIs, and/or the bearer token of a remote MCP server), its
  length (16 to 128, default 40) and alphabet (`alphanumeric`, `hex` or
  `base64url`). It waits in your [inbox](#inbox) until you approve; the agent
  then repeats the call and it runs once.

Either way runkle makes the value with `crypto.getRandomValues`, sets it on
every target, and forgets it. It is never returned, logged or stored by
runkle, and no agent or person sees it.

Ask for a copy (`copy_to`, or **Keep generated values in 1Password** in the
dialog) and runkle first saves it to a field of an item in a 1Password vault,
through the [1Password script](#ready-made-scripts). From there you can give the
same value to the other side, or find it again. Secrets with a copy are listed
by name (`secrets_copied`, and in the UI). Typing a new value by hand removes
that mark, because the copy no longer matches.

The script that keeps copies must hold secrets of its own, so its code is code
you reviewed. A script that holds no secrets yet can be one an agent just
wrote, and its code can read whatever it is given: the request you approve
says so when a target is such a script.

## Approvals

Some calls should not run until you have said yes: minting a token, merging
to main, deleting something. A tool asks first when either

- you list it under **Update script or secrets > Ask me first** (tool names,
  `*` matches anything; agents can set this list when they create an
  integration and never afterwards), or
- its script says so with `approval` (see [Scripts](#scripts)).

Such a call does not run. It waits in your [inbox](#inbox), with the tool, its
arguments and the script's one-line summary, and **Approve** and **Deny**. The
agent gets a link to the same item and is told whether you were notified. It
repeats the call and the call runs, once, with exactly the arguments you saw.
A request you don't answer lapses after an hour, and so does an approval that
is never used.

## Inbox

Everything that waits for you lands at the top of runkle's page: calls that
ask first, proposed script changes, secrets an agent asked you to enter, and
integrations it asked you to set up. Each shows what to do about it; items it
cannot settle itself (a review, a form) open where you act. **Decided** keeps
the last 50 decisions for 30 days, with who made each one.

runkle is an installable web app. Open it on your phone and add it to the Home
Screen (on iPhone: Share, then **Add to Home Screen**), open it from there and
tap **Notify me**. That device then gets a notification for each new item, and
tapping it opens that item. A notification names the tool or the app, never a
call's arguments. Do the same on any computer you want to hear on. Nothing to
configure: runkle makes its own key for signing notifications on first use and
keeps it in its inbox.

## Health

runkle checks every integration once a day, and when you press **Check now**,
so a broken one shows up before an agent fails on it. For each it reports one
of:

| status | means |
| --- | --- |
| `upstream_error` | the portal's last sync failed, or the app's own `probe` threw |
| `needs_sign_in` | the portal has no working admin sign-in to an OAuth server |
| `missing_secret` | the code reads `env.NAME` but no such secret is set |
| `expiring` | a secret's expiry date is 14 days away or less, or has passed |
| `unused_secret` | a secret is set that the code never reads by name |

with a one-line reason and what to do. Each problem opens one inbox alert,
which notifies once and stays open while the problem does; when the problem
is gone the alert closes. Agents get the same report from
`check_integrations`, which alerts no one.

What runkle can see: the portal's record of each integration, the secret
*names* on an app's Worker against the names its deployed code reads
(`env.NAME`, `env["NAME"]`, `{ NAME } = env`; for an HTTP API, the
credentials it was set up with), and the result of the app's `probe`. A
script without a probe is only checked that far. An app deployed before
health checks is not probed until it is updated in runkle once. Each person's
own sign-in to the portal and to OAuth servers is held by Cloudflare, out of
runkle's sight: those still only show when a call fails. The report says how
long a portal sign-in lasts.

The daily check is a Cron Trigger on runkle's own Worker (14:00 UTC). It
counts toward your account's Cron Triggers, five on the free plan.

### Ready-made scripts

`scripts/cloudflare-tokens.js` mints Cloudflare API tokens for agents that
never see them. An agent names a purpose, permissions, a lifetime and a Worker
secret to fill; you approve; the token goes straight to that secret. With no
Worker named, you get a page that shows it once. Every mint asks first. A
constant at the top, `SKIP_APPROVAL_FOR_SHORT_READ_ONLY`, lets read-only
tokens of an hour or less through to runkle's own scripts unasked; it is off.
Upload it under **Add integration > Upload a script** with the secrets
`MINTER_TOKEN` (an account token with `Account API Tokens Write`) and
`ACCOUNT_ID`.

`scripts/onepassword.js` lets agents look up and rotate credentials in
1Password without an `op` session of their own, and keeps the copies of
[generated secrets](#generated-secrets). Listing and metadata run freely and
never include a value. Reading a value into the agent's conversation, creating
an item and every rotation write ask first. No tool takes a secret: a new value
is generated by 1Password (`generate_field`) or copied from one field to
another inside it (`copy_field`), so a password can be staged, set on a site
and promoted without anyone seeing it.

It needs a [1Password Connect](https://www.1password.dev/connect) server,
because Connect is the only 1Password product with an HTTP API. A service
account works only through the `op` CLI or the SDKs, and the JavaScript SDK
does not run on Workers: it loads a 14 MB WebAssembly core from disk with
Node's `fs`
([onepassword-sdk-js#184](https://github.com/1Password/onepassword-sdk-js/issues/184)).
A Connect token is limited to the vaults you pick, like a service account.

1. In 1Password, make a vault for agents (say `Agents`) and move in only what
   they may use.
2. On 1Password.com, under Developer, create a Connect server with access to
   that vault, and save its `1password-credentials.json` and an access token
   that can read and write that vault.
3. Run the two Connect containers (`1password/connect-api`,
   `1password/connect-sync`) somewhere that serves HTTPS, for example on your
   own server behind a Cloudflare Tunnel, ideally behind Access too.
4. Upload the script with the secrets `OP_CONNECT_HOST` (its https address)
   and `OP_CONNECT_TOKEN`, plus `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET` if it is behind Access.

`scripts/fastmail.js` gives agents your Fastmail mail, contacts and calendar.
It stands in front of Fastmail's own MCP server, so the tools are Fastmail's:
the script's `tools` lists them and `call` runs one. Searching, reading,
listing and drafting an email run at once. Everything else asks first:
sending, deleting, moving mail, and creating or changing events and contacts.
A tool Fastmail adds later also asks first, until you add it to `FREE` at the
top of the script. Upload it with the secret `FASTMAIL_TOKEN`, an API token of
type MCP from Fastmail's Settings > Privacy & Security > Manage API tokens.

Adding Fastmail's MCP server to the portal directly also works, but then
nothing asks first: the portal calls it without passing through runkle.

`scripts/github.js` gives agents repositories, pull requests, merges, tags and
workflow runs without a GitHub token of their own. It acts as a GitHub App,
so it reaches only the repositories you install the App on. Reading and
opening pull requests run freely. Merging into a default branch, pushing a
tag, starting a workflow and creating a repository ask first; a merge
approval names the commit, and the merge is refused if the branch has moved.

1. Create a GitHub App (your organisation's Settings > Developer settings >
   GitHub Apps) with no webhook and these repository permissions: Contents
   read and write, Pull requests read and write, Actions read and write,
   Checks read, Metadata read, and Administration read and write if it should
   create repositories.
2. Generate a private key for it and install it on the repositories agents
   may touch.
3. Upload the script with the secrets `GITHUB_APP_ID` and
   `GITHUB_PRIVATE_KEY` (the contents of the `.pem` file).

It does not push commits: an agent still needs its own way to push a branch.
Branch protection on GitHub remains the real rule on what can be merged; the
approval is who gets asked.

## Collections

A collection is its own MCP endpoint that serves only the integrations you
pick, such as Personal or Work. An agent connected to the Personal
collection sees your notes and your watch and nothing from work.

Name it in the UI or have an agent call `create_collection`, and runkle
makes everything a Cloudflare MCP portal needs: the portal on
`mcp-<name>.<your domain>` (one label under the main portal's domain, so
the domain's certificate covers it), its DNS record pointing where the main
portal's does, and its Access application with the main portal's policies
and agent sign-in settings. Then tick the integrations it serves. Each joins
with the tool settings it has in the main portal; after that, its tools and
code mode can be changed in the collection alone. Deleting a collection
removes those three things and nothing else.

The main portal keeps serving everything, and every integration is
registered there first. runkle only touches portals whose ID starts with
`runkle-`.

What you still do yourself: add the collection's endpoint to your agent as
a new connector (in claude.ai, Settings > Connectors) and sign in, including
to each integration that signs every person in with OAuth.

## Managing runkle from an agent

runkle serves its own MCP endpoint at `https://<your runkle hostname>/mcp`
with tools to list, add, sync and remove integrations, upload and update
scripts, add HTTP APIs and skills, allow or block tools, and change sign-in
and code mode settings.

It sits behind the same Access application as the UI. Turn on **Managed
OAuth** for that application (Zero Trust > Access controls > Applications >
your runkle app > Advanced settings) so agents can sign in.

No tool accepts a secret, because anything an agent handles passes through
the model. Instead the agent asks runkle for a link and hands it to you: it
opens this UI, behind the same sign-in, with the form filled in except for
the secret values. The agent can see which secret names are set, never the
values. An agent can upload a script that reads `env.GARMIN_TOKEN`, then it
sends you to the UI to enter the value. The same goes for an HTTP API's key.
A value nobody needs to know, such as a shared token or a signing key, the
agent asks runkle to [generate](#generated-secrets) instead.
MCP servers that need an access token or your own OAuth client are added in
the UI.

## Deploy

You need a Cloudflare account with a domain on it and Zero Trust set up with
an identity provider.

1. **Create the portal.** In the dashboard, go to Zero Trust > Access controls >
   MCP Portals and create a portal on a hostname such as `mcp.example.com`.
   Creating it there also makes its DNS record and Access application. Add an
   Access policy for the people who should use it. Note the portal's ID.
2. **Create an API token** with `MCP Portals Write`,
   `Access: Apps and Policies Write` and `Workers Scripts Write`, plus
   `Zone Read` and `DNS Edit` on the portal's zone for
   [collections](#collections). Uploaded
   scripts are served from your account's `workers.dev` subdomain, so it
   must be set up.
3. **Configure and deploy.**

   ```sh
   npm install
   # set ACCOUNT_ID and PORTAL_ID in wrangler.jsonc
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   npm run deploy
   ```
4. **Put the Worker behind Access.** In the Worker's Settings > Domains &
   Routes, enable Cloudflare Access (or add a self-hosted Access application
   for its hostname) and allow only your admins. Copy the team domain
   (`<team>.cloudflareaccess.com`) and the application's AUD tag into
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`, then deploy again.

### Deploy on every merge with Workers Builds

Connect the Worker to your repository (or fork) in the dashboard under the
Worker's Settings > Builds, so every push to `main` deploys with no token in
GitHub. Set the build variables `ACCOUNT_ID`, `PORTAL_ID`,
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, turn off builds for other branches, and
use this deploy command:

```sh
npx wrangler deploy --var "ACCOUNT_ID:$ACCOUNT_ID" --var "PORTAL_ID:$PORTAL_ID" --var "ACCESS_TEAM_DOMAIN:$ACCESS_TEAM_DOMAIN" --var "ACCESS_AUD:$ACCESS_AUD"
```

The `CLOUDFLARE_API_TOKEN` secret from step 3 stays on the Worker across
deploys. GitHub Actions only runs the tests.

Until step 4 is done, every API request is refused. Anyone the Worker's
Access policy lets in can add and remove integrations, so keep it to admins.

## Development

```sh
npm test             # Node 22.18+
npm run typecheck

# run the UI against an in-memory fake of the Cloudflare API
printf 'AUTH_DISABLED=true\nCLOUDFLARE_API_TOKEN=test-token\nACCOUNT_ID=acct\nPORTAL_ID=main\nCF_API_BASE=http://localhost:8799\n' > .dev.vars
node test/fake-cloudflare.ts &
npm run dev
```

`AUTH_DISABLED` skips the Access check. It belongs in `.dev.vars` only.

## License

[MIT](LICENSE)
