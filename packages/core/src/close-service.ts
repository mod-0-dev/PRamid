import type { VcsClient, RepoRef } from "./vcs-client.ts"
import type { PullRequest } from "./graph.ts"
import { buildGraph } from "./graph.ts"
import { getChildren } from "./dag.ts"

export interface CloseParams {
  repo: RepoRef
  /** The head branch of the PR to close. */
  branch: string
  /** If true, show what would happen without making changes. */
  dryRun?: boolean
}

export interface CloseResult {
  /** The PR that was (or would be) closed. */
  closedPr: PullRequest
  /** Direct child PRs that were (or would be) re-targeted to closedPr.baseBranch. */
  retargeted: PullRequest[]
}

/**
 * Close a PR and re-target its direct children onto its base branch,
 * so the rest of the stack remains intact.
 *
 * Before: main → A → B → C
 * Close A: main → B → C   (B retargeted from A.head to A.base = main)
 */
export async function closePR(client: VcsClient, params: CloseParams): Promise<CloseResult> {
  const { repo, branch, dryRun = false } = params

  const prs = await client.listOpenPRs(repo)
  const graph = buildGraph(prs)

  const pr = prs.find((p) => p.headBranch === branch)
  if (!pr) throw new Error(`No open PR found for branch "${branch}"`)

  const children = getChildren(graph, pr.id)

  if (dryRun) return { closedPr: pr, retargeted: children }

  // Re-target each direct child onto this PR's base before closing
  for (const child of children) {
    await client.updateBaseBranch(child.id, pr.baseBranch)
  }

  await client.closePR(pr.id)

  return { closedPr: pr, retargeted: children }
}
