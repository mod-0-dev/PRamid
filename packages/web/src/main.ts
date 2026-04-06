import "./style.css"
import { fetchAndRender, setupBranchSelect } from "./api"
import { setupFilterControls } from "./filters"
import { cy, setupGraph } from "./graph"
import { setupStacksView } from "./stacks"

// ─── View navigation ──────────────────────────────────────────────────────────

function setupNav(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".nav-tab")
  const views = document.querySelectorAll<HTMLElement>(".view")

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.view as string
      for (const t of tabs) t.classList.toggle("active", t.dataset.view === target)
      for (const v of views) v.classList.toggle("hidden", v.id !== target)

      if (target === "view-graph") {
        cy.resize()
        cy.fit()
      }
    })
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

setupGraph(fetchAndRender)
setupFilterControls()
setupStacksView()
setupBranchSelect(fetchAndRender)
setupNav()

document.fonts.ready.then(() => {
  fetchAndRender()
  setInterval(fetchAndRender, 30_000)
})
