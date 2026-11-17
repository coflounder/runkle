// GitHub: repositories, pull requests, merges, tags and workflow runs for
// agents that hold no GitHub token of their own. It acts as a GitHub App, so it
// reaches only the repositories the App is installed on, with only the
// permissions the App was given.
//
// Secrets: GITHUB_APP_ID, GITHUB_PRIVATE_KEY (the .pem GitHub gives you; pasting
// it on one line is fine).
//
// Reading and opening pull requests run freely. Merging into a default branch,
// pushing a tag, starting a workflow and creating a repository ask the user first.
// There is no general write tool on purpose: it would be a way round those four.

const API = "https://api.github.com";

async function gh(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "runkle" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error("GitHub: " + ((json && json.message) || "HTTP " + res.status));
  return json;
}

// ---- Acting as the App ----

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s) => new TextEncoder().encode(s);
const der = (tag, bytes) => Uint8Array.from([tag, ...(bytes.length < 128 ? [bytes.length] : bytes.length < 256 ? [0x81, bytes.length] : [0x82, bytes.length >> 8, bytes.length & 255]), ...bytes]);

// GitHub hands out PKCS#1 keys and Web Crypto reads PKCS#8, which is the same key in one more envelope.
async function signingKey(pem) {
  const raw = Uint8Array.from(atob(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const rsa = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const load = (bytes) => crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return load(raw).catch(() => load(der(0x30, [0x02, 0x01, 0x00, ...rsa, ...der(0x04, raw)])));
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + b64url(utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) })));
  return head + "." + b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(env.GITHUB_PRIVATE_KEY), utf8(head)));
}

// A one-hour token for the installation that covers `where` ("repos/owner/name" or "orgs/name"),
// narrowed to one repository when there is one.
// ponytail: a fresh token per call, two extra requests; keep it in ctx.storage for its hour if that shows.
async function tokenFor(env, where, repository) {
  const jwt = await appJwt(env);
  const installation = await gh(jwt, "GET", "/" + where + "/installation");
  return (await gh(jwt, "POST", "/app/installations/" + installation.id + "/access_tokens", repository ? { repositories: [repository] } : undefined)).token;
}

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error('repo must look like "owner/name"');
  return "/repos/" + repo;
}
const inRepo = async (env, repo, method, path, body) => gh(await tokenFor(env, repoPath(repo).slice(1), repo.split("/")[1]), method, repoPath(repo) + path, body);
const short = (sha) => String(sha).slice(0, 7);
const repo = { type: "string", description: '"owner/name"' };
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });

export const tools = {
  list_repos: {
    description: "The repositories this integration can reach.",
    input: { type: "object" },
    async run(_, env) {
      const jwt = await appJwt(env);
      const out = [];
      // ponytail: first 100 installations and 100 repositories each; page when that is not enough.
      for (const installation of await gh(jwt, "GET", "/app/installations?per_page=100")) {
        const { token } = await gh(jwt, "POST", "/app/installations/" + installation.id + "/access_tokens");
        out.push(...(await gh(token, "GET", "/installation/repositories?per_page=100")).repositories.map((r) => ({ repo: r.full_name, private: r.private, default_branch: r.default_branch })));
      }
      return out;
    },
  },
  get: {
    description:
      'Read anything in a repository through the GitHub REST API. path is relative to the repository: "" for the repository itself, "pulls", "pulls/12", "pulls/12/files", "commits/<sha>/check-runs", "contents/README.md", "tags", "actions/runs", "branches".',
    input: obj({ repo, path: { type: "string" }, query: { type: "object", description: 'Query parameters, e.g. {"state": "open", "per_page": 50}' } }, ["repo", "path"]),
    async run({ repo, path, query }, env) {
      if (/\.\.|[?#]/.test(path)) throw new Error("path cannot contain .., ? or #; use query");
      const search = new URLSearchParams(query || {}).toString();
      return inRepo(env, repo, "GET", (path ? "/" + path.replace(/^\/+/, "") : "") + (search ? "?" + search : ""));
    },
  },
  create_pull_request: {
    description: "Open a pull request from a branch that is already pushed.",
    input: obj({ repo, title: { type: "string" }, head: { type: "string", description: "Branch with the changes" }, base: { type: "string", description: "Branch to merge into" }, body: { type: "string" }, draft: { type: "boolean" } }, ["repo", "title", "head", "base"]),
    async run({ repo, title, head, base, body, draft }, env) {
      const pr = await inRepo(env, repo, "POST", "/pulls", { title, head, base, body, draft });
      return { number: pr.number, url: pr.html_url };
    },
  },
  comment: {
    description: "Comment on a pull request or issue.",
    input: obj({ repo, number: { type: "number" }, body: { type: "string" } }),
    async run({ repo, number, body }, env) {
      return { url: (await inRepo(env, repo, "POST", "/issues/" + Number(number) + "/comments", { body })).html_url };
    },
  },
  merge_pull_request: {
    description: "Merge a pull request. sha is the head commit you reviewed (from get pulls/<number>): the merge is refused if the branch has moved since. Merging into the default branch asks the user first.",
    input: obj({ repo, number: { type: "number" }, sha: { type: "string" }, method: { type: "string", enum: ["merge", "squash", "rebase"] } }, ["repo", "number", "sha"]),
    // The person approves this commit going into this branch, so both are read here and the merge is pinned to the commit.
    async approval({ repo, number, sha }, env) {
      const pr = await inRepo(env, repo, "GET", "/pulls/" + Number(number));
      if (pr.head.sha !== sha) throw new Error("The pull request's head is now " + pr.head.sha + ", not " + sha + ". Review it again.");
      if (pr.base.ref !== pr.base.repo.default_branch) return;
      const runs = await inRepo(env, repo, "GET", "/commits/" + sha + "/check-runs").then((c) => c.check_runs, () => null);
      const checks = !runs ? "checks unknown" : !runs.length ? "no checks" : runs.filter((r) => r.conclusion === "success").length + " of " + runs.length + " checks passed";
      return `Merge pull request ${pr.number} "${pr.title}" into ${pr.base.ref} of ${repo}, at commit ${short(sha)} by ${pr.user.login} (${checks}).`;
    },
    async run({ repo, number, sha, method }, env) {
      const done = await inRepo(env, repo, "PUT", "/pulls/" + Number(number) + "/merge", { sha, merge_method: method || "squash" });
      return { merged: done.merged, sha: done.sha };
    },
  },
  create_tag: {
    description: "Push a tag pointing at a commit. Asks the user first.",
    input: obj({ repo, tag: { type: "string" }, sha: { type: "string", description: "Full commit SHA" } }),
    approval: ({ repo, tag, sha }) => `Push tag ${tag} to ${repo}, at commit ${short(sha)}. This may start a release.`,
    async run({ repo, tag, sha }, env) {
      return { ref: (await inRepo(env, repo, "POST", "/git/refs", { ref: "refs/tags/" + tag, sha })).ref };
    },
  },
  run_workflow: {
    description: "Start a GitHub Actions workflow that has a workflow_dispatch trigger. Asks the user first.",
    input: obj({ repo, workflow: { type: "string", description: "File name, e.g. deploy.yml" }, ref: { type: "string", description: "Branch or tag to run on" }, inputs: { type: "object" } }, ["repo", "workflow", "ref"]),
    approval: ({ repo, workflow, ref }) => `Run workflow ${workflow} on ${ref} of ${repo}.`,
    async run({ repo, workflow, ref, inputs }, env) {
      await inRepo(env, repo, "POST", "/actions/workflows/" + encodeURIComponent(workflow) + "/dispatches", { ref, inputs: inputs || {} });
      return { started: workflow, ref };
    },
  },
  create_repository: {
    description: "Create a repository in an organisation the App is installed on. Private unless told otherwise. Asks the user first.",
    input: obj({ owner: { type: "string", description: "Organisation" }, name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, ["owner", "name"]),
    approval: ({ owner, name, private: isPrivate }) => `Create the ${isPrivate === false ? "PUBLIC" : "private"} repository ${owner}/${name}.`,
    async run({ owner, name, description, private: isPrivate }, env) {
      if (!/^[\w.-]+$/.test(owner || "")) throw new Error("owner must be an organisation name");
      const made = await gh(await tokenFor(env, "orgs/" + owner), "POST", "/orgs/" + owner + "/repos", { name, description, private: isPrivate !== false });
      return { repo: made.full_name, url: made.html_url };
    },
  },
};
