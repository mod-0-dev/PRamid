import { cy } from "./graph"

// ─── Filter state ─────────────────────────────────────────────────────────────

interface FilterState {
  search: string
  ciStatus: Set<string>
  reviewStatus: Set<string>
  author: string
}

const filters: FilterState = {
  search: "",
  ciStatus: new Set(),
  reviewStatus: new Set(),
  author: "",
}

// ─── Apply ────────────────────────────────────────────────────────────────────

export function applyFilters(): void {
  const search = filters.search.toLowerCase()
  const author = filters.author.toLowerCase()

  for (const node of cy.nodes()) {
    const label: string = node.data("label") ?? ""
    const nodeAuthor: string = (node.data("author") ?? "").toLowerCase()
    const ciStatus: string = node.data("ciStatus") ?? "none"
    const reviewStatus: string = node.data("reviewStatus") ?? "none"

    const matchesSearch = !search || label.toLowerCase().includes(search)
    const matchesCi = filters.ciStatus.size === 0 || filters.ciStatus.has(ciStatus)
    const matchesReview = filters.reviewStatus.size === 0 || filters.reviewStatus.has(reviewStatus)
    const matchesAuthor = !author || nodeAuthor.includes(author)

    if (matchesSearch && matchesCi && matchesReview && matchesAuthor) {
      node.removeClass("dimmed")
    } else {
      node.addClass("dimmed")
    }
  }

  for (const edge of cy.edges()) {
    if (edge.source().hasClass("dimmed") || edge.target().hasClass("dimmed")) {
      edge.addClass("dimmed")
    } else {
      edge.removeClass("dimmed")
    }
  }
}

// ─── Wire up DOM controls ─────────────────────────────────────────────────────

export function setupFilterControls(): void {
  const searchInput = document.getElementById("search") as HTMLInputElement
  const authorInput = document.getElementById("author-input") as HTMLInputElement
  const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement

  searchInput.addEventListener("input", () => {
    filters.search = searchInput.value
    applyFilters()
  })

  authorInput.addEventListener("input", () => {
    filters.author = authorInput.value
    applyFilters()
  })

  for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip[data-filter]")) {
    chip.addEventListener("click", () => {
      const filterGroup = chip.dataset.filter as string
      const value = chip.dataset.value as string
      const set = filterGroup === "ci" ? filters.ciStatus : filters.reviewStatus

      if (set.has(value)) {
        set.delete(value)
        chip.classList.remove("active")
      } else {
        set.add(value)
        chip.classList.add("active")
      }

      applyFilters()
    })
  }

  clearBtn.addEventListener("click", () => {
    filters.search = ""
    filters.author = ""
    filters.ciStatus.clear()
    filters.reviewStatus.clear()

    searchInput.value = ""
    authorInput.value = ""
    for (const c of document.querySelectorAll(".chip.active")) c.classList.remove("active")

    applyFilters()
  })
}
