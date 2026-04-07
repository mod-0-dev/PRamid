import { getChildren, getParent } from "../graph/dag.ts"
import { buildGraph } from "../graph/graph.ts"
import type { PullRequest } from "../graph/graph.ts"

export type NavResult =
  | { ok: true; branch: string; atRoot?: true }
  | { ok: false; error: string; choices?: string[] }

/**
 * Return the single child branch of `currentBranch` in the stack.
 * If there are multiple children the result is an error with the list of choices.
 * If there are no children the result is an error indicating it is the top of the stack.
 */
export function stackNext(prs: PullRequest[], currentBranch: string): NavResult {
  const graph = buildGraph(prs)
  const current = [...graph.nodes.values()].find((pr) => pr.headBranch === currentBranch)

  if (!current) {
    return {
      ok: false,
      error: `"${currentBranch}" has no open PR -- switch to a stacked branch first.`,
    }
  }

  const children = getChildren(graph, current.id)

  if (children.length === 0) {
    return { ok: false, error: `"${currentBranch}" is the top of the stack -- no child branches.` }
  }

  if (children.length === 1 && children[0]) {
    return { ok: true, branch: children[0].headBranch }
  }

  return {
    ok: false,
    error: `"${currentBranch}" has ${children.length} child branches. Use \`pramid stack checkout <branch>\` to select one:`,
    choices: children.map((c) => `  ${c.headBranch}  (#${c.number})`),
  }
}

/**
 * Return the parent branch of `currentBranch` in the stack.
 * At the stack root the base branch (e.g. "main") is returned.
 */
export function stackPrev(prs: PullRequest[], currentBranch: string): NavResult {
  const graph = buildGraph(prs)
  const current = [...graph.nodes.values()].find((pr) => pr.headBranch === currentBranch)

  if (!current) {
    return {
      ok: false,
      error: `"${currentBranch}" has no open PR -- switch to a stacked branch first.`,
    }
  }

  const parent = getParent(graph, current.id)

  // Root PR: go to the base branch (e.g. "main")
  if (!parent) {
    return { ok: true, branch: current.baseBranch, atRoot: true }
  }

  return { ok: true, branch: parent.headBranch }
}

/**
 * Find a branch in the open PRs by exact branch name, PR number (#N or N),
 * or partial branch name substring. Returns an error with choices if ambiguous.
 */
export function stackGoto(prs: PullRequest[], query: string): NavResult {
  // Exact branch name match
  const exact = prs.find((pr) => pr.headBranch === query)
  if (exact) return { ok: true, branch: exact.headBranch }

  // PR number match: "12" or "#12"
  const numStr = query.startsWith("#") ? query.slice(1) : query
  const num = Number.parseInt(numStr, 10)
  if (!Number.isNaN(num) && String(num) === numStr) {
    const byNumber = prs.find((pr) => pr.number === num)
    if (byNumber) return { ok: true, branch: byNumber.headBranch }
  }

  // Partial branch name substring match
  const partial = prs.filter((pr) => pr.headBranch.includes(query))

  if (partial.length === 1 && partial[0]) return { ok: true, branch: partial[0].headBranch }

  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${query}" matches ${partial.length} branches. Be more specific:`,
      choices: partial.map((pr) => `  ${pr.headBranch}  (#${pr.number})`),
    }
  }

  return { ok: false, error: `No branch matching "${query}" found in open PRs.` }
}
