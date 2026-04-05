import type { VcsClient, RepoRef } from "../clients/vcs-client.ts"
import type { PullRequest } from "../graph/graph.ts"
import type { PrId } from "../graph/graph.ts"
import { buildGraph } from "../graph/graph.ts"
import { getDescendants, getParent, topologicalOrder } from "../graph/dag.ts"
import { rebaseBranch, rebaseOnto, getBranchSha, detectStackParent, forcePush, fetchRemote, type GitRunner } from "../git/git-ops.ts"
import { getParentBranch } from "../git/pramid-state.ts"
import { saveConflictState } from "../git/conflict-state.ts"

export interface RestackParams {
  repo: RepoRef
  /** Head branch of the PR to start restacking from (inclusive). */
  startBranch: string
  /** Absolute path to the local git repo. Defaults to process.cwd(). */
  cwd?: string
  /** Git remote name. Defaults to "origin". */
  remote?: string
  /** Print what would happen without touching git or the API. */
  dryRun?: boolean
  /** Inject a custom git runner (for testing). */
  _gitRunner?: GitRunner
}

export interface RestackResult {
  restacked: PullRequest[]
  /** The PR where a rebase failure was hit. files is empty when git refused to start (e.g. dirty working tree). */
  conflict: { pr: PullRequest; files: string[]; errorMessage?: string } | null
  /** PRs that were skipped because a conflict halted the run. */
  skipped: PullRequest[]
}

export async function restack(client: VcsClient, params: RestackParams): Promise<RestackResult> {
  const {
    repo,
    startBranch,
    cwd = process.cwd(),
    remote = "origin",
    dryRun = false,
    _gitRunner,
  } = params

  const prs = await client.listOpenPRs(repo)
  const graph = buildGraph(prs)

  const startPr = [...graph.nodes.values()].find((pr) => pr.headBranch === startBranch)
  if (!startPr) throw new Error(`No open PR found with head branch "${startBranch}"`)

  // Get startPr + all descendants, sorted root-to-leaf
  const subtreeIds = new Set(getDescendants(graph, startPr.id).map((p) => p.id))
  const ordered = topologicalOrder(graph).filter((pr) => subtreeIds.has(pr.id))

  const restacked: PullRequest[] = []
  // Tracks each branch's tip SHA before it is rebased.
  // Children use the saved parent tip as the --onto upstream so that only their
  // own commits are replayed, not the parent's already-merged commits.
  const savedTips = new Map<PrId, string>()

  for (const pr of ordered) {
    const parent = getParent(graph, pr.id)
    const onto = parent?.headBranch ?? pr.baseBranch

    if (dryRun) {
      console.log(`  [dry-run] rebase ${pr.headBranch} onto ${onto}`)
      restacked.push(pr)
      continue
    }

    // Snapshot tip before rebasing so children can use it as --onto upstream.
    try {
      savedTips.set(pr.id, getBranchSha(pr.headBranch, cwd, _gitRunner))
    } catch {
      // Branch not found locally; this PR's children will fall back to plain rebase.
    }

    // For a child whose parent was already rebased in this run, use --onto so that
    // only the child's own commits are replayed (not the parent's, which may have
    // been squash-merged and won't match by patch-id).
    const parentOldTip = parent ? savedTips.get(parent.id) : undefined

    // For root PRs (no parent in this run), the parent branch may have been
    // squash-merged in a previous run.  Detect the old parent via stored config
    // first, then by scanning local branches.
    const rootUpstream = !parentOldTip
      ? (getParentBranch(pr.headBranch, cwd) ??
         detectStackParent(pr.headBranch, onto, cwd, _gitRunner))
      : undefined

    let result
    if (parentOldTip) {
      // Child rebased in this run — use parent's (now-rebased) local head as target
      result = rebaseOnto(pr.headBranch, onto, parentOldTip, cwd, _gitRunner)
    } else if (rootUpstream) {
      // Root PR after squash-merge — fetch remote base and land on its current tip,
      // not on the (possibly stale) local branch.
      fetchRemote(remote, pr.baseBranch, cwd, _gitRunner)
      result = rebaseOnto(pr.headBranch, `${remote}/${pr.baseBranch}`, rootUpstream, cwd, _gitRunner)
    } else {
      result = rebaseBranch(pr.headBranch, onto, cwd, _gitRunner)
    }

    if (!result.success) {
      const skipped = ordered.slice(ordered.indexOf(pr) + 1)
      try {
        saveConflictState(
          {
            command: "restack",
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
        restacked,
        conflict: { pr, files: result.conflictedFiles ?? [], errorMessage: result.errorMessage },
        skipped,
      }
    }

    forcePush(pr.headBranch, cwd, remote, _gitRunner)

    if (parent && pr.baseBranch !== parent.headBranch) {
      await client.updateBaseBranch(pr.id, parent.headBranch)
    }

    restacked.push(pr)
  }

  return { restacked, conflict: null, skipped: [] }
}
