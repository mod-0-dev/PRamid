import { createInterface } from "readline"
import {
  readConfig,
  readLocalConfig,
  readMergedConfig,
  isInsideGitRepo,
  credentialRetrieve,
  resolveGitHubUser,
  resolveGitLabUser,
  getGitLabHost,
  type TokenSource,
} from "./config.ts"
import { getRemoteUrl, parseOwnerRepo, GitHubClient, GitLabClient } from "@pramid/core"
import type { VcsClient } from "@pramid/core"

export function getToken(): string {
  const envToken = process.env["GITHUB_TOKEN"]
  if (envToken) return envToken

  // Resolve user (local .git/config → global config.json), then look up credential
  const cwd = process.cwd()
  const user = resolveGitHubUser(cwd)
  if (user) {
    const credToken = credentialRetrieve("github.com", user)
    if (credToken) return credToken
  }

  // Plaintext fallback
  const config = readMergedConfig(cwd)
  if (config.githubToken) return config.githubToken

  console.error("Error: No GitHub token found.")
  console.error("Run `pramid auth --global` to set one up, or set the GITHUB_TOKEN environment variable.")
  process.exit(1)
}

export function getGitLabToken(): string {
  const envToken = process.env["GITLAB_TOKEN"]
  if (envToken) return envToken

  const cwd = process.cwd()
  const host = getGitLabHost(cwd)
  const user = resolveGitLabUser(cwd)
  if (user) {
    const credToken = credentialRetrieve(host, user)
    if (credToken) return credToken
  }

  const config = readMergedConfig(cwd)
  if (config.gitlabToken) return config.gitlabToken

  console.error("Error: No GitLab token found.")
  console.error("Run `pramid auth --global --gitlab` to set one up, or set the GITLAB_TOKEN environment variable.")
  process.exit(1)
}

/** Determine where a GitHub token is coming from and which user. */
export function getGitHubTokenSource(): { source: TokenSource; user?: string } {
  if (process.env["GITHUB_TOKEN"]) return { source: "env" }
  const cwd = process.cwd()
  const user = resolveGitHubUser(cwd)
  if (user) {
    const credToken = credentialRetrieve("github.com", user)
    if (credToken) return { source: "credential", user }
  }
  if (isInsideGitRepo(cwd)) {
    const local = readLocalConfig(cwd)
    if (local.githubToken) return { source: "local" }
  }
  const global = readConfig()
  if (global.githubToken) return { source: "global" }
  return { source: "none" }
}

/** Determine where a GitLab token is coming from and which user. */
export function getGitLabTokenSource(): { source: TokenSource; user?: string } {
  if (process.env["GITLAB_TOKEN"]) return { source: "env" }
  const cwd = process.cwd()
  const host = getGitLabHost(cwd)
  const user = resolveGitLabUser(cwd)
  if (user) {
    const credToken = credentialRetrieve(host, user)
    if (credToken) return { source: "credential", user }
  }
  if (isInsideGitRepo(cwd)) {
    const local = readLocalConfig(cwd)
    if (local.gitlabToken) return { source: "local" }
  }
  const global = readConfig()
  if (global.gitlabToken) return { source: "global" }
  return { source: "none" }
}

export async function validateGitLabToken(
  token: string,
  baseUrl = "https://gitlab.com/api/v4",
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  try {
    const resp = await fetch(`${baseUrl}/user`, {
      headers: {
        "PRIVATE-TOKEN": token,
        "User-Agent": "pramid/0.0.1",
      },
    })
    if (resp.status === 401) return { ok: false, error: "Invalid or expired token (401 Unauthorized)" }
    if (!resp.ok) return { ok: false, error: `GitLab API returned ${resp.status}` }
    const data = (await resp.json()) as { username: string }
    return { ok: true, login: data.username }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Detect which platform (GitHub or GitLab) a remote URL belongs to.
 * Falls back to GitHub when the URL cannot be matched.
 */
export function detectPlatform(remoteUrl: string): "github" | "gitlab" {
  if (remoteUrl.includes("github.com")) return "github"
  if (remoteUrl.includes("gitlab.com")) return "gitlab"

  // Check for a self-hosted GitLab instance configured via gitlabUrl
  const config = readMergedConfig(process.cwd())
  if (config.gitlabUrl) {
    try {
      const configuredHost = new URL(config.gitlabUrl).hostname
      const remoteHost = remoteUrl.includes("://")
        ? new URL(remoteUrl).hostname
        : remoteUrl.split(":")[0]?.split("@").pop() ?? ""
      if (configuredHost && remoteHost.includes(configuredHost)) return "gitlab"
    } catch {
      // URL parsing failed — fall through to default
    }
  }

  return "github"
}

/**
 * Resolve the appropriate VcsClient for the given remote name.
 * Platform is auto-detected from the remote URL.
 */
export function resolveClient(remote: string): VcsClient {
  let remoteUrl: string
  try {
    remoteUrl = getRemoteUrl(remote, process.cwd())
  } catch {
    // Not in a git repo or remote not found — default to GitHub
    return new GitHubClient(getToken())
  }

  const platform = detectPlatform(remoteUrl)
  if (platform === "gitlab") {
    const config = readMergedConfig(process.cwd())
    const baseUrl = config.gitlabUrl ? `${config.gitlabUrl}/api/v4` : "https://gitlab.com/api/v4"
    return new GitLabClient(getGitLabToken(), { baseUrl })
  }
  return new GitHubClient(getToken())
}

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(`Error: Invalid repo format "${slug}". Expected "owner/repo".`)
    process.exit(1)
  }
  return { owner: parts[0], repo: parts[1] }
}

export function openBrowser(url: string): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["cmd", "/c", "start", "", url])
  } else if (process.platform === "darwin") {
    Bun.spawnSync(["open", url])
  } else {
    Bun.spawnSync(["xdg-open", url])
  }
}

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export async function validateToken(
  token: string,
): Promise<{ ok: true; login: string; scopes: string | null } | { ok: false; error: string }> {
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "pramid/0.0.1",
        Accept: "application/vnd.github+json",
      },
    })
    if (resp.status === 401) return { ok: false, error: "Invalid or expired token (401 Unauthorized)" }
    if (!resp.ok) return { ok: false, error: `GitHub API returned ${resp.status}` }
    const data = (await resp.json()) as { login: string }
    const scopes = resp.headers.get("x-oauth-scopes")
    return { ok: true, login: data.login, scopes: scopes && scopes.length > 0 ? scopes : null }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Resolve owner/repo from --repo flag, or auto-detect from the git remote. */
export function resolveRepo(repoFlag: string | undefined, remote: string): { owner: string; repo: string } {
  if (repoFlag) return parseRepoSlug(repoFlag)

  let url: string
  try {
    url = getRemoteUrl(remote, process.cwd())
  } catch {
    console.error(`Error: Could not read git remote "${remote}". Run from inside the repo or use --repo <owner/repo>.`)
    process.exit(1)
  }

  const slug = parseOwnerRepo(url)
  if (!slug) {
    console.error(`Error: Could not parse owner/repo from remote URL "${url}". Use --repo <owner/repo>.`)
    process.exit(1)
  }

  return parseRepoSlug(slug)
}

/**
 * Print a rebase failure and suggest the appropriate next step.
 *
 * When files is empty it means git refused to start the rebase (e.g. dirty
 * working tree) rather than hitting a merge conflict.  In that case we show
 * the raw git error and ask the user to commit/stash, not to run
 * `git rebase --continue`.
 */
export function printRebaseFailure(
  conflict: { pr: { headBranch: string }; files: string[]; errorMessage?: string },
  skipped: { headBranch: string }[],
  remote = "origin",
  commandName?: "restack" | "sync",
): void {
  if (conflict.files.length === 0 && conflict.errorMessage) {
    console.error(`\nRebase failed in ${conflict.pr.headBranch}:`)
    for (const line of conflict.errorMessage.split("\n")) console.error(`  ${line}`)
    console.error("\nCommit or stash any uncommitted changes, then retry.")
  } else {
    console.log(`\nConflict in ${conflict.pr.headBranch}:`)
    for (const f of conflict.files) console.log(`  ${f}`)
    console.log("\nResolve the conflict, then:")
    if (commandName) {
      console.log(`  git add . && pramid stack ${commandName} --continue`)
    } else {
      console.log(`  git add . && git rebase --continue`)
      console.log(`  git push --force-with-lease ${remote} ${conflict.pr.headBranch}`)
      if (skipped.length > 0) {
        console.log(`  pramid stack restack ${skipped[0]!.headBranch}`)
      }
    }
  }
}
