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

<!-- ilk:begin layer=ilk/compound-lessons region=instructions — managed by ilk — edits inside this block are overwritten; run `ilk rm` to remove it -->
When something goes wrong twice, or a review comment repeats, the fix is not to
remember harder. Encode it: a new check, a new skill, a convention written down, or a
change to a layer. Advice that depends on everybody hearing and remembering it does
not survive the next joiner or the next session.

Record it as `docs/reference/LESSON-*.md`, and say in its frontmatter what
durable change it produced. `ilk check` will not accept a lesson that changed nothing.
<!-- ilk:end layer=ilk/compound-lessons region=instructions -->

<!-- ilk:begin layer=ilk/gates region=instructions — managed by ilk — edits inside this block are overwritten; run `ilk rm` to remove it -->
Work is not done because it looks done. Before claiming a task is complete, run
`ilk check` and let it decide. It runs this repository's tests and build,
and every failure it prints comes with the fix.

The same gates run on `git push` and in CI, so a claim that cannot survive them will
not survive review either. Never disable a gate, mark a test skipped, or weaken an
assertion to make a check pass — if a gate is genuinely wrong, say so plainly and
leave it failing rather than quietly removing the thing that would have caught you.

When you report that work is finished, state what you ran and what it said. "Tests
pass" with no output behind it is a claim, not evidence.
<!-- ilk:end layer=ilk/gates region=instructions -->

<!-- ilk:begin layer=ilk/record region=instructions — managed by ilk — edits inside this block are overwritten; run `ilk rm` to remove it -->
This repository keeps a **project record** next to the code. Agents cannot inherit
what was never written down, so anything a future session would need to know goes
in a file, not in a chat.

| Directory | Holds | Filename grammar |
|---|---|---|
| `docs/reference/` | What is true now | `ARCH-system-overview.md` — uppercase type, kebab slug |
| `docs/plans/` | What we intend to build, and what "accepted" means | `PLAN-billing-rewrite.md` |
| `docs/log/` | What happened, dated | `2026-08-06-shipped-billing.md` |
| `scratch/` | Rough notes. Ungoverned, unchecked, gitignored | anything |

The first three sit together under `docs/`, whose `README.md` indexes
them. Create documents with `ilk record new <dir> <title>` so the naming and
frontmatter are right the first time. Documents in `docs/reference/`
also declare `covers:` — the paths they describe. Staleness is measured against
those paths rather than the calendar, so a document goes stale exactly when its
subject changes.

Rules that matter:

- **Put rough thinking in `scratch/`.** It exists so the
  other three stay clean. A governed system needs an ungoverned annex, or the
  governance leaks.
- **Never edit inside an `ilk:begin` / `ilk:end` block.** Those lines are generated.
- **If your change touches a path some document `covers:`, that document is yours
  this session.** Update it in the same change, or run `ilk record review <file>` to
  see what moved and record that you read it.

Verify before claiming done: `ilk check` validates the record and prints the fix for
anything it rejects. `ilk brief` prints the current state. Both accept `--json`.
<!-- ilk:end layer=ilk/record region=instructions -->

<!-- ilk:begin layer=ilk/secrets region=instructions — managed by ilk — edits inside this block are overwritten; run `ilk rm` to remove it -->
Every commit is scanned for credentials — `ilk check --only secrets.clean`, and a
blocking pre-commit hook.

When one is found, **rotate it first**. A credential is compromised the moment it is
pushed, and deleting it in a new commit leaves it in the history, in every clone and in
every fork. Removal is cleanup; rotation is the fix.

Follow the `handle-a-leaked-credential` skill in the order it gives, and never paste the
value into an issue, a commit message or a pull request.
<!-- ilk:end layer=ilk/secrets region=instructions -->

<!-- ilk:begin layer=target:agents-md region=skills — managed by ilk — edits inside this block are overwritten; run `ilk rm` to remove it -->
## Skills

Detailed procedures live in files, not in this document. Read the matching
file when its situation applies — do not read them all up front.

- **add-a-layer** — Evaluate a layer and add it to this repository. Use when asked to add, install or try an ilk layer, when someone links to one, or when deciding whether a published layer is worth taking on.
  `.agents/skills/add-a-layer/SKILL.md`
- **apply-ilk-changes** — Reconcile the repository with its declared layers. Use when `ilk status` reports drift, after editing .ilk/config.yaml by hand, when `ilk check` reports ilk.drift, or when upgrading a layer to a new version.
  `.agents/skills/apply-ilk-changes/SKILL.md`
- **compound-a-lesson** — Turn something that went wrong, or went well, into a change that alters default behaviour for every future session. Use after an incident, a repeated review comment, a near-miss, or when the same mistake has now been made twice.
  `.agents/skills/compound-a-lesson/SKILL.md`
- **configure-ilk** — Change what ilk does in this repository — capabilities, agent targets, layer variables, budgets and check exemptions. Use when a check is skipped for want of a capability, when adding support for another coding agent, or when a layer's defaults do not fit.
  `.agents/skills/configure-ilk/SKILL.md`
- **contribute-upstream** — Send a change or a complaint about a layer back to its maintainer, with the evidence attached. Use when a layer's output has been edited here and the edit is standing, when one of its checks cannot be satisfied, when a default was overridden and stayed overridden, or when asked whether a local fix should go upstream.
  `.agents/skills/contribute-upstream/SKILL.md`
- **handle-a-leaked-credential** — Work out what to do about a credential that has been committed, pushed, or pasted where it should not have been. Use the moment a scanner flags one, when a key turns up in a diff, a log or an issue, and before telling anybody about it.
  `.agents/skills/handle-a-leaked-credential/SKILL.md`
- **prove-it** — Turn a claim that work is done into evidence a reviewer can check. Use before marking a task complete, opening a pull request, or reporting a result.
  `.agents/skills/prove-it/SKILL.md`
- **resolve-an-ilk-conflict** — Decide what to do when ilk refuses to write a file because it was edited after ilk wrote it. Use when a plan shows CONFLICT, when a merge reports conflicting hunks, or when `ilk check` reports ilk.conflicts.
  `.agents/skills/resolve-an-ilk-conflict/SKILL.md`
- **review-changes** — Review a change the way this repository expects, before it is proposed. Use when preparing a pull request or when asked to review a diff.
  `.agents/skills/review-changes/SKILL.md`
- **update-record** — Bring the project record back in line with the code after a change. Use after shipping work that alters architecture, interfaces, or operational behaviour, or when `ilk check` reports a stale document.
  `.agents/skills/update-record/SKILL.md`
- **write-a-layer** — Author a new ilk layer, or change an existing one. Use when a practice worth repeating should become installable — a directory contract, a check, a skill, a hook or a subcommand — or when asked to extend what ilk does.
  `.agents/skills/write-a-layer/SKILL.md`
- **write-decision** — Record an architectural or process decision so future sessions inherit it. Use when a choice is made that a later reader would otherwise have to reverse-engineer, or would plausibly undo by accident.
  `.agents/skills/write-decision/SKILL.md`
<!-- ilk:end layer=target:agents-md region=skills -->
