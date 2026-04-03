import type { RebaseResult } from "./vcs-client.ts"

// ─── GitRunner interface ───────────────────────────────────────────────────────

export interface GitRunner {
  run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number }
}

export const defaultRunner: GitRunner = {
  run(args, cwd) {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
      exitCode: proc.exitCode ?? 1,
    }
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(runner: GitRunner, args: string[], cwd: string) {
  return runner.run(args, cwd)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getRemoteUrl(remote: string, cwd: string, runner: GitRunner = defaultRunner): string {
  const { stdout, exitCode, stderr } = run(runner, ["remote", "get-url", remote], cwd)
  if (exitCode !== 0) throw new Error(`Could not get URL for remote "${remote}": ${stderr.trim()}`)
  return stdout.trim()
}

/** Parse "owner/repo" from an SSH or HTTPS git remote URL. Returns null if unrecognised. */
export function parseOwnerRepo(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo[.git]
  let m = remoteUrl.match(/git@[^:]+:(.+?)(?:\.git)?$/)
  if (m) return m[1]!
  // HTTPS: https://github.com/owner/repo[.git]
  m = remoteUrl.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/)
  if (m) return m[1]!
  return null
}

export interface BranchInfo {
  name: string
  upstream: string | null
}

export function listLocalBranches(cwd: string, runner: GitRunner = defaultRunner): BranchInfo[] {
  const { stdout, exitCode } = run(
    runner,
    ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads/"],
    cwd,
  )
  if (exitCode !== 0) return []
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream] = line.split("\t") as [string, string]
      return { name, upstream: upstream.trim() || null }
    })
}

export function getCurrentBranch(cwd: string, runner: GitRunner = defaultRunner): string {
  const { stdout, exitCode, stderr } = run(runner, ["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  if (exitCode !== 0) throw new Error(`git rev-parse failed: ${stderr.trim()}`)
  return stdout.trim()
}

export function getBranchSha(branch: string, cwd: string, runner: GitRunner = defaultRunner): string {
  const { stdout, exitCode, stderr } = run(runner, ["rev-parse", branch], cwd)
  if (exitCode !== 0) throw new Error(`Branch not found: "${branch}": ${stderr.trim()}`)
  return stdout.trim()
}

export function checkoutBranch(branch: string, cwd: string, runner: GitRunner = defaultRunner): void {
  const { exitCode, stderr } = run(runner, ["checkout", branch], cwd)
  if (exitCode !== 0) throw new Error(`git checkout ${branch} failed: ${stderr.trim()}`)
}

/** Create a new branch off the current HEAD and switch to it. */
export function createBranch(name: string, cwd: string, runner: GitRunner = defaultRunner): void {
  const { exitCode, stderr } = run(runner, ["checkout", "-b", name], cwd)
  if (exitCode !== 0) throw new Error(`git checkout -b ${name} failed: ${stderr.trim()}`)
}

/** Push a branch to the remote (plain push, not force). */
export function pushBranch(
  branch: string,
  remote: string,
  cwd: string,
  runner: GitRunner = defaultRunner,
): void {
  const { exitCode, stderr } = run(runner, ["push", remote, `${branch}:${branch}`], cwd)
  if (exitCode !== 0) throw new Error(`git push ${remote} ${branch} failed: ${stderr.trim()}`)
}

export function rebaseBranch(
  branch: string,
  onto: string,
  cwd: string,
  runner: GitRunner = defaultRunner,
): RebaseResult {
  checkoutBranch(branch, cwd, runner)

  const { exitCode, stdout, stderr } = run(runner, ["rebase", onto], cwd)

  if (exitCode !== 0) {
    const conflictedFiles = extractConflictedFiles(stdout + stderr)
    if (conflictedFiles.length === 0) {
      // git refused before starting (e.g. dirty working tree) — not a rebase conflict
      return { success: false, conflictedFiles: [], errorMessage: (stderr || stdout).trim() }
    }
    return { success: false, conflictedFiles }
  }

  return { success: true }
}

export function rebaseOnto(
  branch: string,
  onto: string,
  upstream: string,
  cwd: string,
  runner: GitRunner = defaultRunner,
): RebaseResult {
  checkoutBranch(branch, cwd, runner)

  const { exitCode, stdout, stderr } = run(runner, ["rebase", "--onto", onto, upstream], cwd)

  if (exitCode !== 0) {
    const conflictedFiles = extractConflictedFiles(stdout + stderr)
    if (conflictedFiles.length === 0) {
      // git refused before starting (e.g. dirty working tree) — not a rebase conflict
      return { success: false, conflictedFiles: [], errorMessage: (stderr || stdout).trim() }
    }
    return { success: false, conflictedFiles }
  }

  return { success: true }
}

export function fetchRemote(
  remote: string,
  branch: string,
  cwd: string,
  runner: GitRunner = defaultRunner,
): void {
  const { exitCode, stderr } = run(runner, ["fetch", remote, branch], cwd)
  if (exitCode !== 0) throw new Error(`git fetch ${remote} ${branch} failed: ${stderr.trim()}`)
}

export function forcePush(
  branch: string,
  cwd: string,
  remote = "origin",
  runner: GitRunner = defaultRunner,
): void {
  const { exitCode, stderr } = run(runner, ["push", "--force-with-lease", remote, `${branch}:${branch}`], cwd)
  if (exitCode !== 0) throw new Error(`git push failed for ${branch}: ${stderr.trim()}`)
}

/**
 * Continue an in-progress rebase after conflicts have been staged by the user.
 * Passes `-c core.editor=true` so git never opens an interactive editor for the
 * commit message.
 */
export function rebaseContinue(cwd: string, runner: GitRunner = defaultRunner): RebaseResult {
  const { exitCode, stdout, stderr } = run(runner, ["-c", "core.editor=true", "rebase", "--continue"], cwd)
  if (exitCode !== 0) {
    const conflictedFiles = extractConflictedFiles(stdout + stderr)
    return { success: false, conflictedFiles, errorMessage: (stderr || stdout).trim() }
  }
  return { success: true }
}

/** Abort an in-progress rebase and restore the pre-rebase state. */
export function rebaseAbort(cwd: string, runner: GitRunner = defaultRunner): void {
  run(runner, ["rebase", "--abort"], cwd)
}


/**
 * Find the most recent local branch whose tip is an ancestor of `branch`
 * but NOT an ancestor of `onto`.
 *
 * This detects the old parent branch after a squash merge — e.g. if
 * `feat/differ` was squash-merged into `main`, its tip is still in
 * `feat/cli`'s history but not in `main`'s.  Returns the branch NAME
 * (not a SHA), or null if nothing is found.
 */
export function detectStackParent(
  branch: string,
  onto: string,
  cwd: string,
  runner: GitRunner = defaultRunner,
): string | null {
  const { stdout, exitCode } = run(runner, ["branch", "--format=%(refname:short)"], cwd)
  if (exitCode !== 0) return null

  const candidates: string[] = []
  for (const b of stdout.trim().split("\n").map((s) => s.trim()).filter((s) => s && s !== branch)) {
    const isAncestorOfBranch = run(runner, ["merge-base", "--is-ancestor", b, branch], cwd).exitCode === 0
    if (!isAncestorOfBranch) continue
    const isAncestorOfOnto = run(runner, ["merge-base", "--is-ancestor", b, onto], cwd).exitCode === 0
    if (!isAncestorOfOnto) candidates.push(b)
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!

  // Pick the most recent candidate: fewest commits between it and branch
  let best: string | null = null
  let bestCount = Infinity
  for (const c of candidates) {
    const { stdout: countOut } = run(runner, ["rev-list", "--count", `${c}..${branch}`], cwd)
    const n = parseInt(countOut.trim(), 10)
    if (!Number.isNaN(n) && n < bestCount) {
      bestCount = n
      best = c
    }
  }
  return best
}

// ─── Private ──────────────────────────────────────────────────────────────────

function extractConflictedFiles(output: string): string[] {
  return [...output.matchAll(/CONFLICT[^:]*: (?:Merge conflict in |content conflict in )?(.+)/g)].map(
    (m) => m[1]!.trim(),
  )
}
