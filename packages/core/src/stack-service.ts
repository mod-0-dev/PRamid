import type { PullRequest, StackGraph } from "./graph.ts"
import { buildGraph, type PrId } from "./graph.ts"
import { getChildren, getParent, getRoots } from "./dag.ts"
import type { VcsClient, RepoRef } from "./vcs-client.ts"
import { type GitRunner } from "./git-ops.ts"
import { setParent } from "./pramid-state.ts"
import { refreshStackNav } from "./stack-nav.ts"

// ─── createStack ──────────────────────────────────────────────────────────────

export interface CreateStackParams {
  /** The base branch (e.g. "main"). Must already exist on the remote. */
  base: string
  /** Branches to stack, in bottom-to-top order. */
  branches: string[]
  /** Override the PR title for a branch. Defaults to branchToTitle(branch). */
  titleFn?: (branch: string) => string
  /** Create new PRs as drafts. */
  draft?: boolean
  /** Local repo path — used to persist pramidParent metadata in git config. */
  cwd?: string
  /** Inject a custom git runner (for testing). */
  _gitRunner?: GitRunner
}

export interface CreateStackResult {
  created: PullRequest[]
  updated: PullRequest[]
  unchanged: PullRequest[]
}

/** Convert a branch name to a human-readable PR title. */
export function branchToTitle(branch: string): string {
  return branch.replace(/\//g, ": ").replace(/-/g, " ")
}

export async function createStack(
  client: VcsClient,
  repo: RepoRef,
  params: CreateStackParams,
): Promise<CreateStackResult> {
  const { base, branches, titleFn = branchToTitle, draft, cwd, _gitRunner } = params
  const existing = await client.listOpenPRs(repo)
  const byHead = new Map(existing.map((pr) => [pr.headBranch, pr]))

  const created: PullRequest[] = []
  const updated: PullRequest[] = []
  const unchanged: PullRequest[] = []

  let prevBranch = base

  for (const branch of branches) {
    const pr = byHead.get(branch)

    if (pr) {
      if (pr.baseBranch !== prevBranch) {
        await client.updateBaseBranch(pr.id, prevBranch)
        updated.push({ ...pr, baseBranch: prevBranch })
      } else {
        unchanged.push(pr)
      }
    } else {
      const newPr = await client.createPR(repo, {
        head: branch,
        base: prevBranch,
        title: titleFn(branch),
        draft,
      })
      created.push(newPr)
    }

    // Persist the parent branch so restack can use --onto after a squash merge
    if (cwd) {
      try { setParent(branch, prevBranch, cwd) } catch { /* ignore */ }
    }

    prevBranch = branch
  }

  // Refresh stack nav in all PR bodies (created + updated + unchanged)
  const allSettled = [...created, ...updated, ...unchanged]
  if (allSettled.length > 0) {
    // Re-fetch so PR bodies and updated base branches are current
    const fresh = await client.listOpenPRs(repo)
    await refreshStackNav(client, repo, fresh, allSettled[0]!)
  }

  return { created, updated, unchanged }
}

// ─── formatStatus ─────────────────────────────────────────────────────────────

const CI_ICON: Record<string, string> = {
  success: "✓",
  failure: "✗",
  pending: "…",
  none: "·",
}

const REVIEW_LABEL: Record<string, string> = {
  approved: "approved",
  changes_requested: "changes",
  pending: "pending",
  none: "none",
}

function prLine(pr: PullRequest, indent: string): string {
  const ci = CI_ICON[pr.ciStatus] ?? "·"
  const review = REVIEW_LABEL[pr.reviewStatus] ?? "none"
  const draft = pr.draft ? " [draft]" : ""
  const stale = pr.stale ? " [stale]" : ""
  const num = `#${pr.number}`.padEnd(5)
  const title = pr.title.length > 40 ? pr.title.slice(0, 37) + "…" : pr.title.padEnd(40)
  return `${indent}${num}  ${title}  ${pr.headBranch} → ${pr.baseBranch}  [CI:${ci} review:${review}]${draft}${stale}`
}

function renderTree(
  graph: StackGraph,
  id: PrId,
  prefix: string,
  isLast: boolean,
  lines: string[],
): void {
  const pr = graph.nodes.get(id)
  if (!pr) return

  const connector = isLast ? "└─ " : "├─ "
  const indent = prefix + connector
  lines.push(prLine(pr, indent))

  const children = getChildren(graph, id)
  const childPrefix = prefix + (isLast ? "   " : "│  ")
  children.forEach((child, i) => {
    renderTree(graph, child.id, childPrefix, i === children.length - 1, lines)
  })
}

export function formatStatus(prs: PullRequest[]): string {
  if (prs.length === 0) return "No open pull requests."

  const graph = buildGraph(prs)
  const roots = getRoots(graph)
  const lines: string[] = []

  // Group roots into connected stacks vs standalone PRs
  const stackRoots = roots.filter((r) => getChildren(graph, r.id).length > 0)
  const standalone = roots.filter((r) => getChildren(graph, r.id).length === 0)

  for (const root of stackRoots) {
    const children = getChildren(graph, root.id)
    lines.push(prLine(root, "   "))
    children.forEach((child, i) => {
      renderTree(graph, child.id, "   ", i === children.length - 1, lines)
    })
    lines.push("")
  }

  if (standalone.length > 0) {
    if (stackRoots.length > 0) lines.push("── Standalone ──")
    for (const pr of standalone) {
      lines.push(prLine(pr, "  "))
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  return lines.join("\n")
}

// ─── formatLog ────────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
}

function colorize(color: keyof typeof ANSI, text: string, useColor: boolean): string {
  if (!useColor) return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

const LOG_CI_ICON: Record<string, string> = {
  success: "✓",
  failure: "✗",
  pending: "●",
  none: "·",
}

const LOG_CI_COLOR: Record<string, keyof typeof ANSI> = {
  success: "green",
  failure: "red",
  pending: "yellow",
  none: "gray",
}

const LOG_REVIEW_LABEL: Record<string, string> = {
  approved: "approved",
  changes_requested: "changes",
  pending: "review",
  none: "",
}

const LOG_REVIEW_COLOR: Record<string, keyof typeof ANSI | null> = {
  approved: "green",
  changes_requested: "red",
  pending: "yellow",
  none: null,
}

function logPrLine(pr: PullRequest, useColor: boolean): string {
  const title = pr.title.length > 45 ? pr.title.slice(0, 42) + "…" : pr.title
  const num = colorize("gray", `(#${pr.number})`, useColor)
  const draft = pr.draft ? colorize("gray", " [draft]", useColor) : ""

  const ciIcon = LOG_CI_ICON[pr.ciStatus] ?? "·"
  const ciColor = LOG_CI_COLOR[pr.ciStatus] ?? "gray"
  const ci = colorize(ciColor, ciIcon, useColor)

  const reviewLabel = LOG_REVIEW_LABEL[pr.reviewStatus] ?? ""
  const reviewColor = LOG_REVIEW_COLOR[pr.reviewStatus] ?? null
  const review = reviewLabel
    ? reviewColor
      ? colorize(reviewColor, reviewLabel, useColor)
      : reviewLabel
    : ""

  const stale = pr.stale ? " " + colorize("yellow", "← restack needed", useColor) : ""

  const parts = [title, num, ci]
  if (review) parts.push(review)

  return parts.join(" ") + draft + stale
}

function renderLogTree(
  graph: StackGraph,
  id: PrId,
  prefix: string,
  isLast: boolean,
  lines: string[],
  useColor: boolean,
): void {
  const pr = graph.nodes.get(id)
  if (!pr) return

  const connector = isLast ? "└── " : "├── "
  const childPrefix = prefix + (isLast ? "    " : "│   ")

  lines.push(prefix + connector + logPrLine(pr, useColor))

  const children = getChildren(graph, id)
  children.forEach((child, i) => {
    renderLogTree(graph, child.id, childPrefix, i === children.length - 1, lines, useColor)
  })
}

function renderStackTree(graph: StackGraph, root: PullRequest, lines: string[], useColor: boolean): void {
  lines.push(colorize("bold", root.baseBranch, useColor))
  lines.push("└── " + logPrLine(root, useColor))

  const children = getChildren(graph, root.id)
  children.forEach((child, i) => {
    renderLogTree(graph, child.id, "    ", i === children.length - 1, lines, useColor)
  })
}

export interface FormatLogOptions {
  /** Only show the stack that contains this branch. Default: show all stacks. */
  branch?: string
  /** Emit ANSI color codes. Default: false. */
  color?: boolean
}

export function formatLog(prs: PullRequest[], opts: FormatLogOptions = {}): string {
  const { branch, color = false } = opts

  if (prs.length === 0) return "No open pull requests."

  const graph = buildGraph(prs)
  const allRoots = getRoots(graph)

  let targetRoots: PullRequest[]

  if (branch) {
    const targetPr = [...graph.nodes.values()].find((pr) => pr.headBranch === branch)
    if (!targetPr) return `No open PR found for branch "${branch}".`
    // Show only the sub-tree rooted at the given branch
    targetRoots = [targetPr]
  } else {
    targetRoots = allRoots
  }

  const stackRoots = targetRoots.filter((r) => getChildren(graph, r.id).length > 0)
  const standalone = branch ? [] : targetRoots.filter((r) => getChildren(graph, r.id).length === 0)

  const lines: string[] = []

  for (const root of stackRoots) {
    renderStackTree(graph, root, lines, color)
    lines.push("")
  }

  // Scoped to a branch that is itself a standalone PR
  if (branch && targetRoots.length > 0 && stackRoots.length === 0) {
    renderStackTree(graph, targetRoots[0]!, lines, color)
  }

  if (standalone.length > 0) {
    if (stackRoots.length > 0) lines.push(colorize("gray", "── Standalone ──", color))
    for (const pr of standalone) {
      lines.push(logPrLine(pr, color))
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  return lines.join("\n")
}
