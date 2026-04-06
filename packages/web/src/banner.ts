import type { ApiPR } from "./types"

const banner = document.getElementById("stale-banner") as HTMLElement
const bannerText = banner.querySelector(".banner-text") as HTMLElement
const dismissBtn = banner.querySelector(".banner-dismiss") as HTMLButtonElement

let dismissed = false

dismissBtn.addEventListener("click", () => {
  dismissed = true
  banner.classList.add("hidden")
})

export function updateStaleBanner(prs: ApiPR[]): void {
  const stale = prs.filter((pr) => pr.stale)

  if (stale.length === 0) {
    banner.classList.add("hidden")
    dismissed = false // reset so it reappears if staleness returns
    return
  }

  if (dismissed) return

  if (stale.length === 1) {
    const pr = stale[0] as ApiPR
    bannerText.textContent =
      `Restack needed — #${pr.number} (${pr.headBranch}) is out of date.` +
      `  Run: pramid stack restack ${pr.headBranch}`
  } else {
    const list = stale.map((pr) => pr.headBranch).join(", ")
    bannerText.textContent = `Restack needed — ${stale.length} PRs are out of date: ${list}`
  }

  banner.classList.remove("hidden")
}
