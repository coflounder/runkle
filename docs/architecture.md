# Architecture: runkle

## Stack

Cloudflare only.

| layer | choice | why |
| --- | --- | --- |
| web app | one Worker + static assets (`public/index.html`, no framework) | five screens on one page; nothing to build |
| MCP endpoint | Cloudflare MCP server portal | already aggregates servers, stores per-user upstream tokens, filters tools, logs calls |
| agent sign-in | Access managed OAuth on the portal | OAuth authorization server with client registration, no code |
| UI sign-in | Cloudflare Access in front of the Worker; Worker verifies the Access JWT with `jose` | no user table, no sessions |
| database | none | everything runkle manages is already stored by Cloudflare; the Worker is a thin, opinionated client of the Cloudflare API |
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
| PUT `/api/portal` | code mode | PUT portal |
| POST `/api/apps` | deploy an uploaded script as a Worker with its secrets, register it | PUT worker script, POST subdomain, then as POST `/api/integrations` |
| PUT `/api/apps/:id` | replace a script's source and/or set secrets | PUT worker script or PUT worker secrets |
| GET, POST `/api/apps/:id/proposal` | read an agent's proposed change to a script; approve or reject it (UI only, no MCP tool) | GET worker versions and deployments, then as PUT `/api/apps/:id` |
| POST `/api/sources` | generate an app from an OpenAPI or Discovery document or a GraphQL endpoint, then as POST `/api/apps` | (fetches the document), then as above |
| POST `/api/skills` | generate an app that only carries skills, then as POST `/api/apps` | as above |
| POST `/mcp` | the operations above as MCP tools, minus anything that carries a secret | as above |

Token permissions: `MCP Portals Write`, `Access: Apps and Policies Write`,
`Workers Scripts Write`.

## Uploaded scripts

A script is one module exporting `tools`. runkle uploads it beside a fixed
entry module (`src/app-runtime.ts`) that serves those tools over MCP and only
answers a bearer token runkle generates. The token is set as a secret on the
script's Worker and as the portal's credential for it, and kept nowhere else.
The entry module is hand-written rather than the MCP SDK because an uploaded
script has no bundler. runkle's own `/mcp` does use the SDK.

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

## The parts that bite

- **Portal PUT replaces the whole server mapping.** Omit a server and it is
  detached; omit a field and it resets. Every write rebuilds the full mapping
  from a fresh GET (`src/mapping.ts`, tested). Two admins toggling at the
  same moment can lose one toggle: last write wins.
- **Admin sign-in for dynamically registered OAuth servers is dashboard-only.**
  The API has no way to start it, so the UI links to the dashboard for that
  one step. Servers with your own client need no admin sign-in.
- **CSRF.** Access authenticates by cookie, so mutations require a
  same-origin `Origin` header.
- **Non-atomic add/remove.** Three Cloudflare calls; a failure midway is
  reported and the add is rolled back best-effort.
- **Nothing lists an app's webhooks and pages later.** They are returned by
  the upload and follow a fixed URL pattern; there is nowhere to keep them.
- **runkle needs `global_fetch_strictly_public`.** Without that compatibility
  flag a Worker fetching another Worker on the same workers.dev subdomain gets
  a 404, so the manifest request fails.
