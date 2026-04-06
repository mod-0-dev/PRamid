import type { RepoRef, VcsClient } from "../clients/vcs-client.ts"
import { getStack } from "../graph/dag.ts"
import type { PullRequest } from "../graph/graph.ts"
import { buildGraph } from "../graph/graph.ts"

const NAV_START = "<!-- pramid-nav:start -->"
const NAV_END = "<!-- pramid-nav:end -->"

// ─── Block generation ─────────────────────────────────────────────────────────

/**
 * Build the markdown nav block for one PR in the context of its ordered stack.
 * `orderedPrs` must be in topological order (root/base first).
 */
export function buildNavBlock(orderedPrs: PullRequest[], currentPrId: string): string {
  const count = orderedPrs.length
  const rows = orderedPrs.map((pr) => {
    const isCurrent = pr.id === currentPrId
    const marker = isCurrent ? "→" : " "
    const title = isCurrent
      ? `**[#${pr.number} ${esc(pr.title)}](${pr.url})**`
      : `[#${pr.number} ${esc(pr.title)}](${pr.url})`
    const branch = `\`${pr.headBranch}\``
    return `| ${marker} | ${title} | ${branch} |`
  })

  return [
    NAV_START,
    `**Stack** (${count} PR${count !== 1 ? "s" : ""})`,
    "",
    "| | PR | Branch |",
    "|:---:|---|---|",
    ...rows,
    "",
    "_Managed by [PRamid](https://github.com/mod-0-dev/PRamid) · do not edit this block_",
    NAV_END,
  ].join("\n")
}

/**
 * Replace an existing nav block in `body`, or append one if not present.
 * Content outside the markers is preserved.
 */
export function injectNavBlock(body: string, navBlock: string): string {
  const startIdx = body.indexOf(NAV_START)
  const endIdx = body.indexOf(NAV_END)

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block
    const before = body.slice(0, startIdx).trimEnd()
    const after = body.slice(endIdx + NAV_END.length).trimStart()
    const parts = [navBlock]
    if (before) parts.unshift(`${before}\n\n`)
    if (after) parts.push(`\n\n${after}`)
    return parts.join("")
  }

  // Append
  const trimmed = body.trimEnd()
  return trimmed ? `${trimmed}\n\n${navBlock}` : navBlock
}

// ─── Stack-level update ───────────────────────────────────────────────────────

/**
 * Refresh the nav block in every PR that belongs to the same stack as `seedPr`.
 * `allPrs` is the full list of open PRs for the repo (from `listOpenPRs`).
 */
export async function refreshStackNav(
  client: VcsClient,
  _repo: RepoRef,
  allPrs: PullRequest[],
  seedPr: PullRequest,
): Promise<void> {
  const graph = buildGraph(allPrs)
  // getStack walks up to the root then collects all descendants — topological BFS
  const stackPrs = getStack(graph, seedPr.id)
  if (stackPrs.length === 0) return

  for (const pr of stackPrs) {
    const navBlock = buildNavBlock(stackPrs, pr.id)
    const newBody = injectNavBlock(pr.body, navBlock)
    if (newBody !== pr.body) {
      await client.updatePRBody(pr.id, newBody)
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/[[\]()]/g, "\\$&")
}
