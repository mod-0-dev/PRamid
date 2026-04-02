import "./style.css"
import { setupGraph, cy } from "./graph"
import { setupFilterControls } from "./filters"
import { setupStacksView } from "./stacks"
import { fetchAndRender, setupBranchSelect } from "./api"

// ─── View navigation ──────────────────────────────────────────────────────────

function setupNav(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".nav-tab")
  const views = document.querySelectorAll<HTMLElement>(".view")

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset["view"]!
      tabs.forEach((t) => t.classList.toggle("active", t.dataset["view"] === target))
      views.forEach((v) => v.classList.toggle("hidden", v.id !== target))

      if (target === "view-graph") {
        cy.resize()
        cy.fit()
      }
    })
  })
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
