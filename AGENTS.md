# AGENTS.md

Do not preserve backward compatibility. Remove obsolete paths instead of adding
compatibility layers, fallbacks, or migrations.

Choose the simplest implementation that fully meets the current requirements.
Avoid speculative abstractions, configuration, and indirection.

Grow the system in layers. Start from the smallest version that works end to
end, and add each new capability on top of a product that already works. Never
trade a working product for unfinished complexity.

Keep components modular and concerns clearly separated.

Prefer established, well-maintained libraries when they reduce overall
complexity or improve reliability. Do not reimplement common functionality
without a clear reason.

Lean on the dependencies already in the project before writing your own
implementation or adding packages. Do not assume a library lacks a capability
without checking its documentation and types.

Make architectural decisions for the long term. Do not accept a stopgap that
only works for now and is meant to be replaced later.

## runkle

One Cloudflare Worker that manages a Cloudflare MCP server portal. There is no
database: Cloudflare's API is the store. Read `docs/architecture.md` first.

- `src/mapping.ts`: pure input validation and portal-mapping logic.
- `src/ops.ts`: every operation, shared by the UI's API and the MCP tools.
- `src/apps.ts`, `src/app-runtime.ts`: apps (scripts, API sources, skill packs) and the entry module deployed with each.
- `src/sources.ts`: generates an app module from an OpenAPI or Discovery document, a GraphQL endpoint, or skills.
- `src/index.ts`: Access auth and HTTP routes. `src/mcp.ts`: the same operations as MCP tools.
- `public/`: the whole UI, no build step. The CSP in `_headers` forbids inline script and style.
- `npm test` (Node 22.18+), `npm run typecheck`, `npm run dev`.
- Workers Builds deploys every push to `main`, so a merge is a production deploy.

A portal update replaces its whole server mapping. Never send a partial one;
go through `toMapping` and `putPortal`.

Secrets: runkle stores none and returns none. Do not log request bodies, add a
secret to a response, or add an MCP tool parameter that carries one. Only ever
touch Workers named `runkle-app-*`. An agent must not be able to change the
code of a script that holds secrets without a person approving it
(`proposeApp` in `src/apps.ts`): never add an MCP tool that deploys or
approves such a change.

Anything new that is not an MCP server becomes an app. Do not add a second
way to serve tools. Bindings and secrets runkle gives an app are named
`RUNKLE_*` and are never passed to the app's own code.
