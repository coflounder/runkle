# Architecture: runkle

## Stack

Cloudflare only.

| layer | choice | why |
| --- | --- | --- |
| web app | one Worker + static assets (`public/index.html`, no framework) | five screens on one page; nothing to build |
| MCP endpoint | Cloudflare MCP server portal | already aggregates servers, stores per-user upstream tokens, filters tools, logs calls |
| agent sign-in | Access managed OAuth on the portal | OAuth authorization server with client registration, no code |
| UI sign-in | Cloudflare Access in front of the Worker; Worker verifies the Access JWT with `jose` | no user table, no sessions |
| database | one Durable Object, the inbox (`src/inbox.ts`) | everything runkle manages is already stored by Cloudflare; the Worker is a thin, opinionated client of the Cloudflare API. The inbox holds only what waits for a person, its decisions, push subscriptions, and what the health check needs (secret expiry dates, the last report, one-use probe keys) |
| secrets | one Worker secret, `CLOUDFLARE_API_TOKEN` | upstream client secrets and tokens are written straight to Cloudflare and never read back |

## Where things live

| thing | lives in |
| --- | --- |
| Integration | `access/ai-controls/mcp/servers/{id}` + one Access app of type `mcp` so portal users can see it |
| Tool allow/block | the portal's `servers[].updated_tools[].enabled` |
| OAuthClient (upstream) | the server's `auth_credentials` (dynamic registration, or your own client id/secret) |
| Account (per-user upstream token) | the portal, per signed-in user |
| AgentGrant / agent client registration | the portal's Access app, `oauth_configuration` |

## API (Worker, all under Access)

| method path | does | Cloudflare calls |
| --- | --- | --- |
| GET `/api/state` | portal, its integrations and tools, agent sign-in settings, who you are | GET portal, GET access apps |
| POST `/api/integrations` | create server, create its Access app with the portal's policies, attach to portal | POST server, POST access app, PUT portal |
| DELETE `/api/integrations/:id` | detach, delete Access app, delete server | PUT portal, DELETE access app, DELETE server |
| POST `/api/integrations/:id/sync` | re-fetch tools | POST server sync |
| PUT `/api/integrations/:id/tools` | allow or block one tool | PUT portal |
| PUT `/api/agent-auth` | managed OAuth on/off, localhost/loopback, allowed redirect URIs | GET + PUT access app |
| PUT `/api/portal` | code mode, of the main portal or with `collection` of one collection | PUT portal |
| POST `/api/collections` | make a collection: DNS record like the main portal's, portal `runkle-<id>` with the chosen integrations' main-portal mappings, `mcp_portal` Access app with the main portal's policies and OAuth settings; rolled back on failure | GET zones, GET + POST dns_records, POST portal, POST access app |
| PUT `/api/collections/:id` | add or remove integrations | GET portals, PUT portal |
| DELETE `/api/collections/:id` | delete the portal, then its Access app, then the DNS record runkle made (found by its comment) | DELETE portal, DELETE access app, DELETE dns_record |
| POST `/api/apps` | deploy an uploaded script as a Worker with its secrets, register it | PUT worker script, POST subdomain, then as POST `/api/integrations` |
| PUT `/api/apps/:id` | replace a script's source, set secrets, and/or set its ask-first list (UI only for the list) | PUT worker script or PUT worker secrets |
| GET, POST `/api/apps/:id/proposal` | read an agent's proposed change to a script; approve or reject it (UI only, no MCP tool) | GET worker versions and deployments, then as PUT `/api/apps/:id` |
| POST `/api/sources` | generate an app from an OpenAPI or Discovery document or a GraphQL endpoint, then as POST `/api/apps` | (fetches the document), then as above |
| POST `/api/skills` | generate an app that only carries skills, then as POST `/api/apps` | as above |
| GET, POST `/api/health` | the last health report; run the check now and update its inbox alerts | GET portal, GET access apps, per app GET worker settings, versions, deployments and its source, then the app's `/manifest/probe` |
| POST `/api/generate` | generate a secret and set it on apps and/or a server's bearer token, keeping a copy if asked (a person's request: no inbox item) | PUT worker secrets, PUT server, then the vault app's `/vault` |
| POST `/mcp` | the operations above as MCP tools, minus anything that carries a secret; `generate_secret` waits for approval in the inbox | as above |

Token permissions: `MCP Portals Write`, `Access: Apps and Policies Write`,
`Workers Scripts Write`; for collections, `Zone Read` and `DNS Edit` on the
portal's zone.

A collection is a second portal (`runkle-<id>`) with a subset of the main
portal's servers. Every integration is registered in the main portal, which
apps, health checks and generated secrets keep using; a collection only
points at servers that already exist. Each server's own Access app applies in
every portal it is in, so a collection narrows what an agent sees but not who
may use a server. Removing an integration detaches it from every collection
first.

## Uploaded scripts

A script is one module exporting `tools`. runkle uploads it beside a fixed
entry module (`src/app-runtime.ts`) that serves those tools over MCP and only
answers a bearer token runkle generates. The token is set as a secret on the
script's Worker and as the portal's credential for it, and kept nowhere else.
The entry module is hand-written rather than the MCP SDK because an uploaded
script has no bundler. runkle's own `/mcp` does use the SDK.

What the entry module adds to a script's tools, so agents searching hundreds
of them can tell them apart and call them safely:

- `tools/list` carries a tool's `annotations` and its `output` schema (as
  `outputSchema`) when the module declares them. Generated API tools get
  annotations from the HTTP method and a description that is never empty.
- A plain object returned by `run` is sent as `structuredContent` beside the
  text. The generated HTTP client returns JSON responses parsed for this.
- Arguments the input schema's `properties` does not name are refused with
  an error naming the allowed ones, unless the schema sets
  `additionalProperties: true`. A schema with no `properties` takes anything.

An existing app only gets a new entry module when it is uploaded again
(`update_script`, `update_api_source`).

## Apps: everything that is not an MCP server

The portal only aggregates MCP servers, so anything else becomes one: an "app",
its own Worker running `src/app-runtime.ts` beside one app module.
`src/sources.ts` generates that module for HTTP APIs and skill packs; for a
script it is the upload itself. No second mechanism exists.

| app feature | Cloudflare primitive | set up by |
| --- | --- | --- |
| tools, skills | the app's `/mcp` | portal registration |
| storage | a SQLite Durable Object in the app's own Worker (`exports` in the upload) | the upload |
| schedules | Cron Triggers | PUT `workers/scripts/{name}/schedules` |
| webhooks | the app's `/webhooks/<name>`, public | nothing |
| pages | the app's `/pages/<name>` behind a `self_hosted` Access app with the portal's policies. It has to cover the whole hostname (Access on workers.dev cannot finish its login for a path-scoped app), so a second app bypasses Access for `/mcp`, `/webhooks` and `/manifest`. The runtime checks `ctx.access.aud` and fails closed | POST `access/apps` twice, aud stored as a Worker secret |
| workflows | one Cloudflare Workflow per app that dispatches by name | PUT `workflows/{name}` |

runkle cannot evaluate an uploaded module, so after each upload it asks the
app for a manifest (`/manifest`) to learn its schedules, pages and workflows.
The request carries a key generated for that upload and set as a secret in the
same upload, so nothing is stored and an answer proves the new version is live.

Pages are served from the app's own origin, never runkle's, because their HTML
is arbitrary script output.

An HTTP API's credential is one shared Worker secret (`API_TOKEN`). Per-user
OAuth exists only for MCP servers, where the portal does it.

An API source can be read-only (`read_only`, GET operations only) and still
carry the few writes it needs, named in `operations`. Fields named in `redact`
are replaced with `[redacted]` in every response, at any depth, so an API that
returns secrets (Dokploy returns an app's env) never hands them to an agent.
`update_api_source` regenerates a source in place, keeping its id, secrets and
portal registration; like any agent change to a script with secrets, it waits
for review.

## Generated secrets

`generate_secret` (`generateSecret` in `src/ops.ts`, the pure part in
`src/generate.ts`) is the one MCP tool that changes a credential, so it asks
first the same way an app's gated tool does: the normalized request (targets,
length, alphabet, where to keep a copy) is an `approval` item whose id is a
SHA-256 of it, the agent gets a link, and its repeated call runs once after a
person approves. Every rule is checked before the item is opened. The value
does not exist until then: it is made in the call that runs, with
`crypto.getRandomValues` and rejection sampling, and lives only in that call.

| step | where it goes |
| --- | --- |
| 1. copy, if asked | the vault app's `/vault`, see below. First, so a value never goes live with no copy |
| 2. targets | `PUT workers/scripts/runkle-app-<id>/secrets` per app secret; `PUT access/ai-controls/mcp/servers/<id>` with `auth_credentials` per remote bearer server |
| 3. mark | `RUNKLE_COPY_<NAME>`, a secret binding on the app whose value says nothing. Its name is how `appConfig` reports `secrets_copied`. A value set by hand deletes it |

Error text from any step has the value replaced before it is returned. A
person generating from the UI (`POST /api/generate`) is their own approval.

A copy goes to a runkle app that exports `vault` (`scripts/onepassword.js`,
which writes to a 1Password Connect server), because the 1Password credential
must live as an app's secret, not runkle's. runkle sets a fresh key as the
app's `RUNKLE_SETUP` (the same secret it reads `/manifest` with), then POSTs
the value to the app's `/vault` with it; the entry module checks the key and
hands the value to `vault.save` as an argument. The app's env never holds it,
no MCP tool reaches `vault`, and runkle keeps neither the key nor the value.
Setting the key is a Worker deployment, so the call retries on 401 for a few
seconds while it spreads. The vault app must hold secrets, so its code is
reviewed code.

Why Connect and not a service account: service accounts have no HTTP API
(only the `op` CLI and the Go, JavaScript and Python SDKs), and the JavaScript
SDK's WebAssembly core is loaded with `fs.readFileSync(__dirname + ...)`, which
Workers cannot run (onepassword-sdk-js#184, open). Bundling a patched 14 MB
core would also need a WebAssembly module in an app's upload, which apps do not take.

Not covered: a target script that holds no secrets can be one an agent wrote,
and its code can read the value; the approval says so. And a portal server's
new token is only useful once the upstream server has the same value, which
is what the copy is for.

## Credential links

An agent cannot be given a secret, so it asks for a link (`credentialLink`,
`serverLink` in `src/ops.ts`) and hands that to the user. The link is runkle's
own UI with a fragment naming the form and its non-secret fields; Access is the
only gate and nothing is stored. The page validates the fragment and never
reads a secret from it. `secrets_set` in the state lists secret names per app
so the agent can see when the user is done.

## Review of script changes

A script's code is handed its secrets, so whoever can change the code can read
them. An agent's `update_script` on a script that holds secrets is therefore
not deployed. runkle uploads it as a Worker version without deploying it
(`POST workers/scripts/{name}/versions`), which is the whole store: the
proposal is "the newest version is not the deployed one". The person opens the
review link, reads the diff of the two versions' `app.js`, and approves or
rejects. Either answer is an ordinary upload (of the proposed or the current
source), because Cloudflare cannot delete a version and refuses secret edits
while the newest version is not deployed. The decision names the version that
was read, so a later proposal cannot use an earlier approval.

Not covered: a script without secrets deploys at once, including one that
keeps tokens it obtained itself in `ctx.storage`. And the review routes trust
Access plus a same-origin `Origin` header, which separates a browser from an
agent that behaves, not from one that holds an Access token and forges the
header. Agents that reach runkle through the portal never hold that token.

## Approvals and the inbox

A tool call that needs a person is stopped in the app's own runtime
(`gate` in `src/app-runtime.ts`), because that is the one place every call to
an app passes through. Two things make a tool ask: the person's list, a
`RUNKLE_ASK` plain-text binding on the app's Worker (set at creation or from
the UI, read back from the Worker's settings), and an `approval` on the tool
in the script, which may be a function of the call.

The call then waits in runkle's inbox, one Durable Object (`Inbox` in
`src/inbox.ts`) in runkle's own Worker. Apps reach it through a cross-script
Durable Object binding, `RUNKLE_INBOX`, that the app's code is never handed.

| step | where |
| --- | --- |
| the call arrives | the item's id is a SHA-256 of the app, tool name and canonical arguments, so a repeat finds the same item |
| the person is told | the inbox sends Web Push to every browser that tapped **Notify me** (`/api/push`); the agent gets a link to the item and is told whether anyone was notified |
| the person decides | runkle's UI, behind its Access application; `POST /api/inbox/<id>`; the decision and the Access email go to the inbox's log |
| the call resumes | the agent repeats the call; an approved item turns to used in the same Durable Object step that answers, so it runs once |

Requests and unused approvals lapse after an hour. Nothing blocks while
waiting: holding a tool call open for minutes does not survive the portal.

The other kinds of item are opened and closed by runkle itself: a proposed
script change (closed when the review is decided, in the review screen, never
from the inbox), secrets an agent asked for (closed when they are set), an
integration to set up (closed when it is added), and alerts. Opening an item
that is already open does not notify again.

Push needs a VAPID key pair. The inbox makes one on first use and keeps it in
its own storage; it is not a credential to anything, only the signature
browsers check on runkle's notifications. A notification carries the item's
title and kind, never a call's arguments. Subscriptions that a push service
reports gone (404 or 410) are dropped.

Not covered:

- **Remote MCP servers.** The portal calls them directly, so runkle cannot
  stop a call to one. To gate an operation, serve it from an app.
- **Apps without secrets.** An agent can replace their code unreviewed, and
  so rename a tool out of the list. Nothing such an app can do needs a
  secret, and a script's own `approval` only changes with its code.
- **Apps uploaded before the inbox** have no `RUNKLE_INBOX` binding. Their
  gated tools refuse to run, and say so, until the app is updated in runkle.
- **iPhone and iPad** only offer push to the app opened from the Home Screen.

## Health

`src/health.ts` checks every integration with what runkle can see without
anyone's token, and nothing it does changes an integration.

| signal | from |
| --- | --- |
| last sync failed, admin sign-in missing | the portal's server record (`error_details`, `status`, `authentication_status`) |
| missing and unused secrets | secret names in the app Worker's settings against the env names its deployed `app.js` reads. A generated API module reads its credentials by a name held in its config, so `sourceSecrets` in `src/sources.ts` answers for it |
| expiring secrets | dates entered beside values (UI) or with `set_secret_expiry` (agents), kept per app in the inbox. A new value takes the date given with it, or none |
| upstream works | the app's own `probe` export |

runkle cannot call an app's tools: only the portal holds the app's token. So
it asks the app to run its probe at `/manifest/probe` (under `/manifest`,
which Access already lets through on an app with pages). The request carries
a random key that runkle put in its inbox a moment before; the app's runtime
checks and uses up that key through its `RUNKLE_INBOX` binding. The key
lasts a minute and opens nothing but the probe.

A Cron Trigger on runkle's Worker (`triggers.crons`, `scheduled` in
`src/index.ts`) runs the check daily and opens one inbox `alert` per problem,
with an id built from the integration, the kind of problem and the secret
(`health:garmin:expiring:garmin-token`), so a standing problem stays one open
item and notifies once. Alerts whose problem is gone are closed. The UI's
**Check now** does the same. `check_integrations` only reports. A scheduled
run has no request, so its notifications are signed with the address of the
page that subscribed, kept with each subscription.

Not covered: each person's own sign-in to the portal and to OAuth servers
lives in the portal, which does not show it to the API. The report gives the
portal's Access session duration instead. An app deployed before health
checks answers 404 at `/manifest/probe` and is reported as not probed until
it is updated once. HTTP API sources declare no probe.

## The parts that bite

- **Portal PUT replaces the whole server mapping.** Omit a server and it is
  detached; omit a field and it resets. Every write rebuilds the full mapping
  from a fresh GET (`src/mapping.ts`, tested). Two admins toggling at the
  same moment can lose one toggle: last write wins.
- **Admin sign-in for dynamically registered OAuth servers is dashboard-only.**
  The API has no way to start it, so the UI links to the dashboard for that
  one step. Servers with your own client need no admin sign-in.
- **Creating a portal through the API makes no DNS record.** Without one the
  hostname answers 522, so runkle copies the main portal's record. A
  hostname two labels under the zone (`personal.mcp.example.com`) gets no
  certificate from Universal SSL, hence `mcp-<id>.example.com`.
- **CSRF.** Access authenticates by cookie, so mutations require a
  same-origin `Origin` header.
- **Non-atomic add/remove.** Three Cloudflare calls; a failure midway is
  reported and the add is rolled back best-effort.
- **Nothing lists an app's webhooks and pages later.** They are returned by
  the upload and follow a fixed URL pattern; there is nowhere to keep them.
- **runkle and every app need `global_fetch_strictly_public`.** Without that
  compatibility flag a Worker fetching another Worker on the same workers.dev
  subdomain gets a 404 (error 1042), so the manifest request fails, and an app
  such as Access Check cannot open a Workers Preview. With it, such a fetch
  goes through Cloudflare's front door, Access included.
