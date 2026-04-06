import cytoscape from "cytoscape"
// @ts-expect-error — no bundled types for cytoscape-dagre
import dagre from "cytoscape-dagre"
import { type ActionResponse, handleConflict, postAction } from "./api-actions"
import { showToast } from "./toast"
import type { ApiPR } from "./types"

cytoscape.use(dagre)

// ─── Build Cytoscape elements ─────────────────────────────────────────────────

export function buildElements(prs: ApiPR[]): cytoscape.ElementDefinition[] {
  const byHead = new Map(prs.map((pr) => [pr.headBranch, pr.id]))
  const elements: cytoscape.ElementDefinition[] = []

  for (const pr of prs) {
    const shortTitle = pr.title.length > 30 ? `${pr.title.slice(0, 27)}…` : pr.title
    const shortBranch = pr.headBranch.length > 28 ? `${pr.headBranch.slice(0, 25)}…` : pr.headBranch
    const draft = pr.draft ? " [draft]" : ""
    elements.push({
      data: {
        id: pr.id,
        // Full values for the tooltip
        number: pr.number,
        title: pr.title,
        // Simplified 2-line label — CI/review are shown in the tooltip
        label: `#${pr.number}  ${shortTitle}${draft}\n${shortBranch}`,
        url: pr.url,
        author: pr.author,
        headBranch: pr.headBranch,
        ciStatus: pr.ciStatus,
        reviewStatus: pr.reviewStatus,
        stale: pr.stale,
        draft: pr.draft,
      },
    })
  }

  for (const pr of prs) {
    const parentId = byHead.get(pr.baseBranch)
    if (parentId) {
      elements.push({
        data: {
          id: `${parentId}-->${pr.id}`,
          source: parentId,
          target: pr.id,
          stale: pr.stale,
        },
      })
    }
  }

  return elements
}

// ─── Cytoscape instance ───────────────────────────────────────────────────────

// Cytoscape's bundled types are incomplete (missing shadow-*, rgba colours, etc.).
type CyStyle = cytoscape.StylesheetCSS[]

export const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: [],
  style: [
    // Base node
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": "178px",
        "font-family": '"JetBrains Mono", monospace',
        "font-size": "11px",
        color: "#c5cfe8",
        "background-color": "#1a2540",
        "border-color": "rgba(218, 226, 253, 0.09)",
        "border-width": 1,
        "border-style": "solid",
        width: 210,
        height: 56,
        shape: "roundrectangle",
        "shadow-blur": 22,
        "shadow-color": "#060e20",
        "shadow-opacity": 0.5,
        "shadow-offset-x": 0,
        "shadow-offset-y": 5,
      },
    },
    // CI status → fill
    { selector: "node[ciStatus = 'success']", style: { "background-color": "#0e3320" } },
    { selector: "node[ciStatus = 'failure']", style: { "background-color": "#3d0e0e" } },
    { selector: "node[ciStatus = 'pending']", style: { "background-color": "#3d2200" } },
    // Review status → border
    {
      selector: "node[reviewStatus = 'approved']",
      style: { "border-color": "#22c55e", "border-width": 2 },
    },
    {
      selector: "node[reviewStatus = 'changes_requested']",
      style: { "border-color": "#ef4444", "border-width": 2 },
    },
    {
      selector: "node[reviewStatus = 'pending']",
      style: { "border-color": "#f59e0b", "border-width": 2 },
    },
    // Stale
    {
      selector: "node[?stale]",
      style: { "border-style": "dashed", "border-color": "#f97316", "border-width": 2 },
    },
    // Selected
    { selector: "node:selected", style: { "border-width": 3, "border-color": "#3b82f6" } },
    // Hover — amber glow without touching background or border
    {
      selector: "node.hovered",
      style: {
        "shadow-blur": 36,
        "shadow-color": "#f59e0b",
        "shadow-opacity": 0.38,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
      },
    },
    // Dimmed (filtered out; kept in DOM so layout stays stable)
    { selector: "node.dimmed", style: { opacity: 0.15 } },
    { selector: "edge.dimmed", style: { opacity: 0.08 } },
    // Current local branch — cyan glow + border
    {
      selector: "node.current-branch",
      style: {
        "border-color": "#06b6d4",
        "border-width": 2,
        "shadow-blur": 28,
        "shadow-color": "#06b6d4",
        "shadow-opacity": 0.5,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
      },
    },
    // Edges
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "line-color": "rgba(160, 142, 122, 0.22)",
        "target-arrow-color": "rgba(160, 142, 122, 0.22)",
        width: 1.5,
      },
    },
    {
      selector: "edge[?stale]",
      style: {
        "line-color": "#f97316",
        "target-arrow-color": "#f97316",
        "line-style": "dashed",
      },
    },
  ] as unknown as CyStyle,
})

// ─── Current-branch highlight ─────────────────────────────────────────────────

export function highlightCurrentBranch(branch: string): void {
  cy.nodes().removeClass("current-branch")
  if (branch) {
    cy.nodes(`[headBranch = "${branch}"]`).addClass("current-branch")
  }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

const CI_TEXT: Record<string, string> = {
  success: "✓ success",
  failure: "✗ failure",
  pending: "… pending",
  none: "· none",
}
const REVIEW_TEXT: Record<string, string> = {
  approved: "approved",
  changes_requested: "changes needed",
  pending: "review pending",
  none: "no review",
}

function showTooltip(node: cytoscape.NodeSingular, container: HTMLElement): void {
  const tooltip = document.getElementById("tooltip") as HTMLElement

  const number: number = node.data("number")
  const title: string = node.data("title")
  const author: string = node.data("author") || ""
  const ciStatus: string = node.data("ciStatus") || "none"
  const reviewStatus: string = node.data("reviewStatus") || "none"
  const stale: boolean = node.data("stale")
  const draft: boolean = node.data("draft")
  ;(tooltip.querySelector(".tt-number") as HTMLElement).textContent = `#${number}`

  const draftTag = tooltip.querySelector(".tt-draft") as HTMLElement
  draftTag.classList.toggle("hidden", !draft)
  ;(tooltip.querySelector(".tt-title") as HTMLElement).textContent = title
  ;(tooltip.querySelector(".tt-author") as HTMLElement).textContent = author ? `@${author}` : ""

  const ciBadge = tooltip.querySelector(".tt-ci") as HTMLElement
  ciBadge.textContent = CI_TEXT[ciStatus] ?? ciStatus
  ciBadge.className = `tt-badge tt-ci ci-${ciStatus}`

  const reviewBadge = tooltip.querySelector(".tt-review") as HTMLElement
  reviewBadge.textContent = REVIEW_TEXT[reviewStatus] ?? reviewStatus
  reviewBadge.className = `tt-badge tt-review review-${reviewStatus}`

  const staleBadge = tooltip.querySelector(".tt-stale") as HTMLElement
  staleBadge.classList.toggle("hidden", !stale)

  // Position: prefer right of node, flip left if near viewport edge
  const bb = node.renderedBoundingBox()
  const rect = container.getBoundingClientRect()
  const TW = 240 // tooltip width (matches CSS)

  let x = rect.left + bb.x2 + 14
  let y = rect.top + bb.y1

  if (x + TW > window.innerWidth - 8) {
    x = rect.left + bb.x1 - TW - 14
  }
  // Clamp vertically so it never bleeds off-screen
  const TH = tooltip.offsetHeight || 150
  if (y + TH > window.innerHeight - 8) y = window.innerHeight - TH - 8
  if (y < 8) y = 8

  tooltip.style.left = `${Math.round(x)}px`
  tooltip.style.top = `${Math.round(y)}px`
  tooltip.classList.add("visible")
}

function hideTooltip(): void {
  document.getElementById("tooltip")?.classList.remove("visible")
}

// ─── Graph events ─────────────────────────────────────────────────────────────

export function setupGraph(onAction: () => void): void {
  const container = document.getElementById("cy") as HTMLElement
  const tooltipEl = document.getElementById("tooltip") as HTMLElement

  let mouseInTooltip = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleHide(): void {
    hideTimer = setTimeout(() => {
      if (!mouseInTooltip) hideTooltip()
      hideTimer = null
    }, 80)
  }

  tooltipEl.addEventListener("mouseenter", () => {
    mouseInTooltip = true
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  })

  tooltipEl.addEventListener("mouseleave", () => {
    mouseInTooltip = false
    hideTooltip()
  })

  function bindTooltipAction(
    btn: HTMLButtonElement,
    endpoint: string,
    pendingLabel: string,
    getSuccessMsg: () => string,
  ): void {
    btn.addEventListener("click", () => {
      const branch = btn.dataset.branch ?? ""
      if (!branch) return
      hideTooltip()
      postAction<ActionResponse>(endpoint, { branch }, btn, pendingLabel, (data) => {
        if (data.ok) {
          showToast(getSuccessMsg(), "success")
          onAction()
        } else {
          handleConflict(data, "Failed")
        }
      })
    })
  }

  const reorderBtn = document.getElementById("tt-reorder-btn") as HTMLButtonElement
  const splitBtn = document.getElementById("tt-split-btn") as HTMLButtonElement
  const mergeBtn = document.getElementById("tt-merge-btn") as HTMLButtonElement
  const closeBtn = document.getElementById("tt-close-btn") as HTMLButtonElement
  const checkoutBtn = document.getElementById("tt-checkout-btn") as HTMLButtonElement

  bindTooltipAction(
    reorderBtn,
    "/api/reorder",
    "Reordering…",
    () => `#${reorderBtn.dataset.number} promoted above its parent`,
  )
  bindTooltipAction(
    splitBtn,
    "/api/split",
    "Splitting…",
    () => `#${splitBtn.dataset.number} split off as new stack`,
  )
  bindTooltipAction(mergeBtn, "/api/merge", "Merging…", () => `#${mergeBtn.dataset.number} merged`)
  bindTooltipAction(closeBtn, "/api/close", "Closing…", () => `#${closeBtn.dataset.number} closed`)
  bindTooltipAction(
    checkoutBtn,
    "/api/checkout",
    "Checking out…",
    () => `Checked out ${checkoutBtn.dataset.branch ?? ""}`,
  )

  cy.on("mouseover", "node:not(.dimmed)", (evt) => {
    const node = evt.target as cytoscape.NodeSingular
    const branch: string = node.data("headBranch") ?? ""
    const number: string = String(node.data("number") ?? "")

    // Sync branch/number onto action buttons for their click handlers
    reorderBtn.dataset.branch = branch
    reorderBtn.dataset.number = number
    splitBtn.dataset.branch = branch
    splitBtn.dataset.number = number
    mergeBtn.dataset.branch = branch
    mergeBtn.dataset.number = number
    closeBtn.dataset.branch = branch
    closeBtn.dataset.number = number
    checkoutBtn.dataset.branch = branch

    node.addClass("hovered")
    container.style.cursor = "pointer"
    showTooltip(node, container)
  })

  cy.on("mouseout", "node", (evt) => {
    ;(evt.target as cytoscape.NodeSingular).removeClass("hovered")
    container.style.cursor = "default"
    scheduleHide()
  })

  // Hide tooltip on pan/zoom so it doesn't drift
  cy.on("viewport", () => {
    mouseInTooltip = false
    hideTooltip()
  })

  cy.on("tap", "node:not(.dimmed)", (evt) => {
    const url: string | undefined = (evt.target as cytoscape.NodeSingular).data("url")
    if (url) window.open(url, "_blank", "noopener,noreferrer")
  })
}
