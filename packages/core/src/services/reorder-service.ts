import type { RepoRef, VcsClient } from "../clients/vcs-client.ts"
import { type GitRunner, forcePush, rebaseOnto } from "../git/git-ops.ts"
import { unsetParent } from "../git/pramid-state.ts"
import { getChildren, getDescendants, getParent, topologicalOrder } from "../graph/dag.ts"
import type { PullRequest } from "../graph/graph.ts"
import { buildGraph } from "../graph/graph.ts"

// ─── reorderStack ─────────────────────────────────────────────────────────────

export interface ReorderParams {
  repo: RepoRef
  /** The branch to promote — it swaps with its parent in the stack. */
  branch: string
  /** Absolute path to the local git repo. Defaults to process.cwd(). */
  cwd?: string
  /** Git remote name. Defaults to "origin". */
  remote?: string
  /** Print what would happen without touching git or the API. */
  dryRun?: boolean
  /** Inject a custom git runner (for testing). */
  _gitRunner?: GitRunner
}

export interface ReorderResult {
  promotedPr: PullRequest
  demotedPr: PullRequest
  restacked: PullRequest[]
  /** files is empty when git refused to start (e.g. dirty working tree). */
  conflict: { pr: PullRequest; files: string[]; errorMessage?: string } | null
  skipped: PullRequest[]
}

/**
 * Swap `branch` with its parent in the stack.
 *
 * Before: G → A → B → [children of B]
 * After:  G → B → A → [children of B]
 *
 * All descendants are rebased so they stay under A.
 */
export async function reorderStack(
  client: VcsClient,
  params: ReorderParams,
): Promise<ReorderResult> {
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

  const b = [...graph.nodes.values()].find((pr) => pr.headBranch === branch)
  if (!b) throw new Error(`No open PR found with head branch "${branch}"`)

  const a = getParent(graph, b.id)
  if (!a) throw new Error(`"${branch}" is a root PR — cannot promote it above a parent`)

  // gBranch: the branch that A is based on (may be "main" or another PR's head)
  const gBranch = a.baseBranch

  // All original children of B — these move under A after the swap
  const bChildren = getChildren(graph, b.id)

  if (dryRun) {
    console.log(`  [dry-run] promote "${b.headBranch}" above "${a.headBranch}"`)
    console.log(`    rebase ${b.headBranch} --onto ${gBranch} (skip ${a.headBranch})`)
    console.log(`    rebase ${a.headBranch} --onto ${b.headBranch} (skip ${gBranch})`)
    for (const c of bChildren) {
      const subtreeIds = new Set(getDescendants(graph, c.id).map((p) => p.id))
      const ordered = topologicalOrder(graph).filter((p) => subtreeIds.has(p.id))
      for (const pr of ordered) {
        const onto = pr.id === c.id ? a.headBranch : getParent(graph, pr.id)?.headBranch
        console.log(`    rebase ${pr.headBranch} --onto ${onto} (skip ${gBranch})`)
      }
    }
    return { promotedPr: b, demotedPr: a, restacked: [], conflict: null, skipped: [] }
  }

  const restacked: PullRequest[] = []

  // 1. Rebase B onto G (exclude A's commits)
  const r1 = rebaseOnto(b.headBranch, gBranch, a.headBranch, cwd, _gitRunner)
  if (!r1.success) {
    const skipped = [a, ...bChildren.flatMap((c) => getDescendants(graph, c.id))]
    return {
      promotedPr: b,
      demotedPr: a,
      restacked,
      conflict: { pr: b, files: r1.conflictedFiles ?? [], errorMessage: r1.errorMessage },
      skipped,
    }
  }
  forcePush(b.headBranch, cwd, remote, _gitRunner)
  restacked.push(b)

  // 2. Rebase A onto new B (take A's own commits, put on B)
  const r2 = rebaseOnto(a.headBranch, b.headBranch, gBranch, cwd, _gitRunner)
  if (!r2.success) {
    const skipped = bChildren.flatMap((c) => getDescendants(graph, c.id))
    return {
      promotedPr: b,
      demotedPr: a,
      restacked,
      conflict: { pr: a, files: r2.conflictedFiles ?? [], errorMessage: r2.errorMessage },
      skipped,
    }
  }
  forcePush(a.headBranch, cwd, remote, _gitRunner)
  restacked.push(a)

  // 3. Update GitHub base branches
  await client.updateBaseBranch(b.id, gBranch)
  await client.updateBaseBranch(a.id, b.headBranch)

  // 4. Move original children of B under A, rebase their full subtrees
  for (const child of bChildren) {
    const subtreeIds = new Set(getDescendants(graph, child.id).map((p) => p.id))
    const ordered = topologicalOrder(graph).filter((p) => subtreeIds.has(p.id))

    for (const pr of ordered) {
      // Immediate children of B now live under A; deeper descendants stay under their same parent
      const onto = pr.id === child.id ? a.headBranch : (getParent(graph, pr.id)?.headBranch ?? a.headBranch)

      if (pr.id === child.id) {
        await client.updateBaseBranch(pr.id, a.headBranch)
      }

      // Using gBranch as upstream lets git's patch-id dedup skip commits already in 'onto'
      const rn = rebaseOnto(pr.headBranch, onto, gBranch, cwd, _gitRunner)
      if (!rn.success) {
        const remainIdx = ordered.indexOf(pr)
        return {
          promotedPr: b,
          demotedPr: a,
          restacked,
          conflict: { pr, files: rn.conflictedFiles ?? [], errorMessage: rn.errorMessage },
          skipped: ordered.slice(remainIdx + 1),
        }
      }
      forcePush(pr.headBranch, cwd, remote, _gitRunner)
      restacked.push(pr)
    }
  }

  return { promotedPr: b, demotedPr: a, restacked, conflict: null, skipped: [] }
}

// ─── splitStack ───────────────────────────────────────────────────────────────

export interface SplitParams {
  repo: RepoRef
  /** Branch to split off. It and all its descendants become a new independent stack. */
  branch: string
  /** Absolute path to the local git repo. Defaults to process.cwd(). */
  cwd?: string
  /** Git remote name. Defaults to "origin". */
  remote?: string
  /** Print what would happen without touching git or the API. */
  dryRun?: boolean
  /** Inject a custom git runner (for testing). */
  _gitRunner?: GitRunner
}

export interface SplitResult {
  splitPr: PullRequest
  restacked: PullRequest[]
  /** files is empty when git refused to start (e.g. dirty working tree). */
  conflict: { pr: PullRequest; files: string[]; errorMessage?: string } | null
  skipped: PullRequest[]
}

/**
 * Detach `branch` from its parent, making it the root of a new independent stack.
 *
 * Before: G → A → B → [children of B]
 * After:  G → A;  G → B → [children of B]
 *
 * B's commits (and all descendants) are rebased onto G, removing A's changes.
 * This can conflict if B or any descendant depends on A's changes.
 */
export async function splitStack(client: VcsClient, params: SplitParams): Promise<SplitResult> {
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

  const b = [...graph.nodes.values()].find((pr) => pr.headBranch === branch)
  if (!b) throw new Error(`No open PR found with head branch "${branch}"`)

  const a = getParent(graph, b.id)
  if (!a) throw new Error(`"${branch}" is already a root PR — nothing to split`)

  // All PRs from B downward, root-to-leaf
  const subtreeIds = new Set(getDescendants(graph, b.id).map((p) => p.id))
  const ordered = topologicalOrder(graph).filter((p) => subtreeIds.has(p.id))

  if (dryRun) {
    console.log(`  [dry-run] split "${b.headBranch}" off from "${a.headBranch}"`)
    for (const pr of ordered) {
      const onto = pr.id === b.id ? a.baseBranch : getParent(graph, pr.id)?.headBranch
      console.log(`    rebase ${pr.headBranch} --onto ${onto} (skip ${a.headBranch})`)
    }
    return { splitPr: b, restacked: [], conflict: null, skipped: [] }
  }

  const restacked: PullRequest[] = []

  for (const pr of ordered) {
    const onto = pr.id === b.id ? a.baseBranch : (getParent(graph, pr.id)?.headBranch ?? a.baseBranch)

    if (pr.id === b.id) {
      await client.updateBaseBranch(b.id, a.baseBranch)
      // B is now a root PR — its old pramidParent (pointing to A) is no longer valid.
      // Clear it so future restack/sync operations don't treat it as a child of A.
      try {
        unsetParent(b.headBranch, cwd)
      } catch {
        /* ignore */
      }
    }

    // a.headBranch as upstream: exclude A's commits; git dedup skips any already-present commits
    const result = rebaseOnto(pr.headBranch, onto, a.headBranch, cwd, _gitRunner)
    if (!result.success) {
      const remainIdx = ordered.indexOf(pr)
      return {
        splitPr: b,
        restacked,
        conflict: { pr, files: result.conflictedFiles ?? [], errorMessage: result.errorMessage },
        skipped: ordered.slice(remainIdx + 1),
      }
    }
    forcePush(pr.headBranch, cwd, remote, _gitRunner)
    restacked.push(pr)
  }

  return { splitPr: b, restacked, conflict: null, skipped: [] }
}
