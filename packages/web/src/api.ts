import type cytoscape from "cytoscape"
import { updateStaleBanner } from "./banner"
import { applyFilters } from "./filters"
import { buildElements, cy, highlightCurrentBranch } from "./graph"
import { updateStacksView } from "./stacks"
import { showToast } from "./toast"
import type { ApiPR } from "./types"

const statusEl = document.getElementById("status") as HTMLElement
const selectEl = document.getElementById("branch-select") as HTMLSelectElement

function populateBranchSelect(
  branches: Array<{ name: string; upstream: string | null }>,
  current: string,
): void {
  // Only rebuild options when the list changes to avoid flicker
  const existing = Array.from(selectEl.options).map((o) => o.value)
  const same =
    existing.length === branches.length && branches.every((b, i) => b.name === existing[i])
  if (!same) {
    selectEl.innerHTML = ""
    for (const b of branches) {
      const opt = document.createElement("option")
      opt.value = b.name
      opt.textContent = b.upstream ? `${b.name} ↑` : b.name
      selectEl.appendChild(opt)
    }
  }
  selectEl.value = current
}

export function setupBranchSelect(onAction: () => void): void {
  let busy = false
  selectEl.addEventListener("change", async () => {
    if (busy) return
    const branch = selectEl.value
    busy = true
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (data.ok) {
        showToast(`Checked out ${branch}`, "success")
      } else {
        showToast(`Checkout failed: ${data.error ?? "unknown error"}`, "error")
      }
    } catch {
      showToast("Network error — could not reach the server", "error")
    } finally {
      busy = false
      onAction()
    }
  })
}

export async function fetchAndRender(): Promise<void> {
  try {
    const [graphRes, branchRes] = await Promise.all([fetch("/api/graph"), fetch("/api/branches")])
    if (!graphRes.ok) throw new Error(`HTTP ${graphRes.status}`)
    const { prs } = (await graphRes.json()) as { prs: ApiPR[] }

    let currentBranch = ""
    if (branchRes.ok) {
      const { current, branches } = (await branchRes.json()) as {
        current: string
        branches: Array<{ name: string; upstream: string | null }>
      }
      currentBranch = current ?? ""
      if (branches?.length) populateBranchSelect(branches, currentBranch)
    }

    cy.elements().remove()
    cy.add(buildElements(prs))

    // dagre-specific options are not in the Cytoscape base layout types
    cy.layout({
      name: "dagre",
      rankDir: "TB",
      padding: 56,
      nodeSep: 44,
      rankSep: 80,
      animate: false,
    } as cytoscape.LayoutOptions).run()

    applyFilters()
    updateStaleBanner(prs)
    updateStacksView(prs)
    highlightCurrentBranch(currentBranch)

    statusEl.textContent = `${prs.length} PR(s) · ${new Date().toLocaleTimeString()}`
  } catch (err) {
    statusEl.textContent = `Error: ${(err as Error).message}`
  }
}
