import type { MergeStrategy, RepoRef, VcsClient } from "../clients/vcs-client.ts"
import { getChildren, getDescendants, topologicalOrder } from "../graph/dag.ts"
import type { PullRequest } from "../graph/graph.ts"
import { buildGraph } from "../graph/graph.ts"

// ─── Single-PR merge ──────────────────────────────────────────────────────────

export interface MergeSingleParams {
  repo: RepoRef
  /** Head branch of the PR to merge. */
  branch: string
  strategy?: MergeStrategy
  dryRun?: boolean
}

export interface MergeSingleResult {
  mergedPr: PullRequest
  /** Direct children re-targeted onto mergedPr.baseBranch. */
  retargeted: PullRequest[]
  warnings: string[]
}

/**
 * Merge one PR and re-target its direct children onto its base branch.
 *
 * Before: main → A → B → C
 * Merge A: main → B → C  (B re-targeted from A.head to A.base = main)
 */
export async function mergeSinglePR(
  client: VcsClient,
  params: MergeSingleParams,
): Promise<MergeSingleResult> {
  const { repo, branch, strategy = "merge", dryRun = false } = params

  const prs = await client.listOpenPRs(repo)
  const graph = buildGraph(prs)

  const pr = prs.find((p) => p.headBranch === branch)
  if (!pr) throw new Error(`No open PR found for branch "${branch}"`)

  const warnings = collectWarnings([pr])
  const children = getChildren(graph, pr.id)

  if (dryRun) return { mergedPr: pr, retargeted: children, warnings }

  if (pr.draft) {
    throw new Error(
      `PR #${pr.number} is a draft -- mark it ready for review before merging, or use \`pramid stack close ${pr.headBranch}\` to skip it.`,
    )
  }

  if (pr.mergeable === false) {
    throw new Error(
      `PR #${pr.number} (${pr.headBranch}) has conflicts and cannot be merged. Run \`pramid stack restack ${pr.headBranch}\` to resolve.`,
    )
  }

  await client.mergePR(pr.id, strategy)
  for (const child of children) {
    await client.updateBaseBranch(child.id, pr.baseBranch)
  }

  return { mergedPr: pr, retargeted: children, warnings }
}

// ─── Stack merge (bottom-up) ──────────────────────────────────────────────────

export interface MergeStackParams {
  repo: RepoRef
  /** Head branch of the PR to start from (all descendants are included). */
  branch: string
  strategy?: MergeStrategy
  dryRun?: boolean
}

export interface MergeStackResult {
  /**
   * In dry-run mode: all PRs that would be merged (in order).
   * In live mode: PRs that were successfully merged before any failure.
   */
  merged: PullRequest[]
  retargeted: { pr: PullRequest; newBase: string }[]
  warnings: string[]
  /** Set if a merge failed mid-stack; subsequent PRs were not processed. */
  failedAt?: { pr: PullRequest; error: string }
}

/**
 * Merge an entire stack bottom-up, starting from the PR with the given head branch.
 * After each merge, direct children are re-targeted onto the merged PR's base so
 * subsequent merges land on the correct integration branch.
 *
 * Before: main → A → B → C
 * After merging A: re-target B → main, merge B, re-target C → main, merge C.
 */
export async function mergeStack(
  client: VcsClient,
  params: MergeStackParams,
): Promise<MergeStackResult> {
  const { repo, branch, strategy = "merge", dryRun = false } = params

  const prs = await client.listOpenPRs(repo)
  const graph = buildGraph(prs)

  const startPr = prs.find((p) => p.headBranch === branch)
  if (!startPr) throw new Error(`No open PR found for branch "${branch}"`)

  // Collect all PRs to merge: startPr + all descendants, topological order (root first)
  const toMergeIds = new Set(getDescendants(graph, startPr.id).map((p) => p.id))
  const ordered = topologicalOrder(graph).filter((p) => toMergeIds.has(p.id))

  const warnings = collectWarnings(ordered)

  if (dryRun) {
    return { merged: ordered, retargeted: [], warnings }
  }

  // Track live base for each PR (updated as children are re-targeted)
  const liveBase = new Map(ordered.map((p) => [p.id, p.baseBranch]))

  const merged: PullRequest[] = []
  const retargeted: { pr: PullRequest; newBase: string }[] = []

  for (const pr of ordered) {
    if (pr.draft) {
      return {
        merged,
        retargeted,
        warnings,
        failedAt: {
          pr,
          error: `PR #${pr.number} is a draft -- mark it ready for review before merging, or use \`pramid stack close ${pr.headBranch}\` to skip it.`,
        },
      }
    }

    if (pr.mergeable === false) {
      return {
        merged,
        retargeted,
        warnings,
        failedAt: {
          pr,
          error: `PR #${pr.number} (${pr.headBranch}) has conflicts and cannot be merged. Run \`pramid stack restack ${pr.headBranch}\` to resolve.`,
        },
      }
    }

    try {
      await client.mergePR(pr.id, strategy)
      merged.push(pr)

      const currentBase = liveBase.get(pr.id) ?? pr.baseBranch

      // Re-target direct children that are part of this merge run
      for (const child of getChildren(graph, pr.id)) {
        if (!toMergeIds.has(child.id)) continue
        await client.updateBaseBranch(child.id, currentBase)
        liveBase.set(child.id, currentBase)
        retargeted.push({ pr: child, newBase: currentBase })
      }
    } catch (err) {
      return { merged, retargeted, warnings, failedAt: { pr, error: (err as Error).message } }
    }
  }

  return { merged, retargeted, warnings }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectWarnings(prs: PullRequest[]): string[] {
  const warnings: string[] = []
  for (const pr of prs) {
    if (pr.ciStatus === "failure") warnings.push(`#${pr.number} has failing CI`)
    else if (pr.ciStatus === "pending") warnings.push(`#${pr.number} CI is still running`)
    if (pr.reviewStatus === "changes_requested")
      warnings.push(`#${pr.number} has changes requested`)
    else if (pr.reviewStatus !== "approved") warnings.push(`#${pr.number} is not approved`)
  }
  return warnings
}
