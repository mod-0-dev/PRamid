import type { VcsClient, RepoRef } from "./vcs-client.ts"
import type { PullRequest } from "./graph.ts"
import type { PrId } from "./graph.ts"
import { buildGraph } from "./graph.ts"
import { getDescendants, getParent, getStack, topologicalOrder } from "./dag.ts"
import { fetchRemote, rebaseBranch, rebaseOnto, getBranchSha, detectStackParent, forcePush, type GitRunner } from "./git-ops.ts"
import { getParentBranch } from "./pramid-state.ts"
import { saveConflictState } from "./conflict-state.ts"

export interface SyncParams {
  repo: RepoRef
  /**
   * Head branch of any PR in the stack — the entire stack (from root) will be
   * fetched and rebased onto the latest remote base branch.
   */
  branch: string
  cwd?: string
  remote?: string
  dryRun?: boolean
  _gitRunner?: GitRunner
}

export interface SyncResult {
  /** The stack root PR that was rebased onto the updated trunk. */
  root: PullRequest
  /** Base branch that was fetched (e.g. "main"). */
  baseBranch: string
  synced: PullRequest[]
  /** files is empty when git refused to start (e.g. dirty working tree). */
  conflict: { pr: PullRequest; files: string[]; errorMessage?: string } | null
  skipped: PullRequest[]
}

/**
 * Fetch the latest trunk and rebase the entire stack onto it.
 *
 * Unlike plain `restack` (which rebases children onto their existing parents),
 * `syncStack` first does `git fetch origin <baseBranch>` and then rebases the
 * stack root onto `origin/<baseBranch>`. Children cascade from there as usual.
 *
 * Before (trunk has moved): main(old) → A → B → C
 * After:  origin/main(new) → A → B → C
 */
export async function syncStack(client: VcsClient, params: SyncParams): Promise<SyncResult> {
  const {
    repo,
    branch,
    cwd = process.cwd(),
    remote = "origin",
    dryRun = false,
    _gitRunner,
  } = params

  const prs = await client.listOpenPRs(repo)
  const graph = buildGraph(prs)

  const startPr = prs.find((p) => p.headBranch === branch)
  if (!startPr) throw new Error(`No open PR found for branch "${branch}"`)

  // Walk to stack root
  const stackMembers = getStack(graph, startPr.id)
  const root = stackMembers[0]
  if (!root) throw new Error(`Could not determine stack root for branch "${branch}"`)

  const baseBranch = root.baseBranch

  if (dryRun) {
    console.log(`  [dry-run] git fetch ${remote} ${baseBranch}`)
    const subtreeIds = new Set(getDescendants(graph, root.id).map((p) => p.id))
    const ordered = topologicalOrder(graph).filter((p) => subtreeIds.has(p.id))
    for (const pr of ordered) {
      const parent = getParent(graph, pr.id)
      const onto = parent ? parent.headBranch : `${remote}/${baseBranch}`
      console.log(`  [dry-run] rebase ${pr.headBranch} onto ${onto}`)
    }
    return { root, baseBranch, synced: ordered, conflict: null, skipped: [] }
  }

  // Fetch latest trunk
  fetchRemote(remote, baseBranch, cwd, _gitRunner)

  // Collect root + all descendants in topological order
  const subtreeIds = new Set(getDescendants(graph, root.id).map((p) => p.id))
  const ordered = topologicalOrder(graph).filter((p) => subtreeIds.has(p.id))

  const synced: PullRequest[] = []
  const savedTips = new Map<PrId, string>()

  for (const pr of ordered) {
    const parent = getParent(graph, pr.id)
    // Root rebases onto the freshly-fetched remote base; children onto parent head
    const onto = parent ? parent.headBranch : `${remote}/${baseBranch}`

    try {
      savedTips.set(pr.id, getBranchSha(pr.headBranch, cwd, _gitRunner))
    } catch {
      // Branch not found locally; this PR's children will fall back to plain rebase.
    }

    const parentOldTip = parent ? savedTips.get(parent.id) : undefined

    const rootUpstream = !parentOldTip
      ? (getParentBranch(pr.headBranch, cwd) ??
         detectStackParent(pr.headBranch, onto, cwd, _gitRunner))
      : undefined

    const result =
      parentOldTip || rootUpstream
        ? rebaseOnto(pr.headBranch, onto, (parentOldTip ?? rootUpstream)!, cwd, _gitRunner)
        : rebaseBranch(pr.headBranch, onto, cwd, _gitRunner)

    if (!result.success) {
      const skipped = ordered.slice(ordered.indexOf(pr) + 1)
      try {
        saveConflictState(
          {
            command: "sync",
            remote,
            repo,
            conflictBranch: pr.headBranch,
            conflictPr: {
              id: pr.id,
              number: pr.number,
              headBranch: pr.headBranch,
              baseBranch: pr.baseBranch,
              parentHeadBranch: parent?.headBranch ?? null,
            },
            remainingBranches: skipped.map((p) => p.headBranch),
          },
          cwd,
        )
      } catch {
        // Non-fatal: state persistence failure doesn't block the conflict report
      }
      return {
        root,
        baseBranch,
        synced,
        conflict: { pr, files: result.conflictedFiles ?? [], errorMessage: result.errorMessage },
        skipped,
      }
    }

    forcePush(pr.headBranch, cwd, remote, _gitRunner)

    if (parent && pr.baseBranch !== parent.headBranch) {
      await client.updateBaseBranch(pr.id, parent.headBranch)
    }

    synced.push(pr)
  }

  return { root, baseBranch, synced, conflict: null, skipped: [] }
}
