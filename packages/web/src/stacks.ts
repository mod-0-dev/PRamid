import type { ApiPR } from "./types"
import { showToast } from "./toast"
import { postAction, handleConflict } from "./api-actions"

// ─── Stack detection ──────────────────────────────────────────────────────────

interface Stack {
  root: ApiPR
  prs: ApiPR[]
  depth: number
  ciRollup: ApiPR["ciStatus"]
  reviewRollup: ApiPR["reviewStatus"]
  staleCount: number
}

function detectStacks(prs: ApiPR[]): Stack[] {
  const headBranchSet = new Set(prs.map((pr) => pr.headBranch))

  // Root = PR whose baseBranch isn't any other PR's headBranch
  const roots = prs.filter((pr) => !headBranchSet.has(pr.baseBranch))

  function traverse(pr: ApiPR): ApiPR[] {
    const children = prs.filter((p) => p.baseBranch === pr.headBranch)
    return [pr, ...children.flatMap(traverse)]
  }

  return roots.map((root) => {
    const members = traverse(root)

    // CI rollup: failure > pending > success > none
    let ciRollup: ApiPR["ciStatus"] = "none"
    for (const pr of members) {
      if (pr.ciStatus === "failure") { ciRollup = "failure"; break }
      if (pr.ciStatus === "pending") ciRollup = "pending"
      else if (pr.ciStatus === "success" && ciRollup === "none") ciRollup = "success"
    }

    // Review rollup: changes_requested > pending > approved > none
    let reviewRollup: ApiPR["reviewStatus"] = "none"
    const revs = new Set(members.map((pr) => pr.reviewStatus))
    if (revs.has("changes_requested"))       reviewRollup = "changes_requested"
    else if (revs.has("pending"))             reviewRollup = "pending"
    else if (members.every((pr) => pr.reviewStatus === "approved")) reviewRollup = "approved"

    return {
      root,
      prs: members,
      depth: members.length,
      ciRollup,
      reviewRollup,
      staleCount: members.filter((pr) => pr.stale).length,
    }
  })
}

// ─── Stack actions ────────────────────────────────────────────────────────────

function triggerRestack(branch: string, btn: HTMLButtonElement): void {
  void postAction<
    | { ok: true; restacked: number }
    | { ok: false; conflict?: { branch: string; files: string[] }; error?: string }
  >("/api/restack", { branch }, btn, "Restacking…", (data) => {
    if (data.ok) showToast(`Restacked ${data.restacked} PR(s) from ${branch}`, "success")
    else handleConflict(data, "Restack failed")
  })
}

function triggerSync(branch: string, btn: HTMLButtonElement): void {
  void postAction<
    | { ok: true; synced: number; baseBranch: string }
    | { ok: false; conflict?: { branch: string; files: string[] }; error?: string }
  >("/api/sync", { branch }, btn, "Syncing…", (data) => {
    if (data.ok) showToast(`Synced ${data.synced} PR(s) onto ${data.baseBranch}`, "success")
    else handleConflict(data, "Sync failed")
  })
}

function triggerMergeStack(branch: string, strategy: string, btn: HTMLButtonElement): void {
  void postAction<{
    ok: boolean; merged?: number; warnings?: string[]; failedAt?: string; error?: string
  }>("/api/merge-stack", { branch, strategy }, btn, "Merging…", (data) => {
    for (const w of data.warnings ?? []) showToast(`⚠ ${w}`, "info")
    if (data.ok) showToast(`Merged ${data.merged} PR(s) in stack`, "success")
    else if (data.failedAt) showToast(`Stopped at ${data.failedAt}`, "error")
    else showToast(`Merge failed: ${data.error ?? "unknown error"}`, "error")
  })
}

// ─── Table render ─────────────────────────────────────────────────────────────

const CI_DOT: Record<string, string>     = { success: "●", failure: "●", pending: "●", none: "○" }
const REVIEW_TEXT: Record<string, string> = {
  approved: "approved",
  changes_requested: "changes needed",
  pending: "review pending",
  none: "—",
}

function renderTable(stacks: Stack[]): void {
  const tbody = document.querySelector("#stacks-table tbody")!
  tbody.innerHTML = ""

  if (stacks.length === 0) {
    const row = document.createElement("tr")
    row.innerHTML = `<td colspan="6" class="stacks-empty">No open stacked PRs found.</td>`
    tbody.appendChild(row)
    return
  }

  for (const stack of stacks) {
    const row = document.createElement("tr")

    row.innerHTML = `
      <td class="col-stack">
        <span class="stack-root-num">#${stack.root.number}</span>
        <span class="stack-root-title">${escHtml(stack.root.title)}</span>
        <span class="stack-base">← ${escHtml(stack.root.baseBranch)}</span>
      </td>
      <td class="col-depth">${stack.depth}</td>
      <td class="col-ci">
        <span class="ci-dot ci-${stack.ciRollup}">${CI_DOT[stack.ciRollup] ?? "○"}</span>
        ${stack.ciRollup}
      </td>
      <td class="col-review">
        <span class="review-badge review-${stack.reviewRollup}">
          ${REVIEW_TEXT[stack.reviewRollup] ?? stack.reviewRollup}
        </span>
      </td>
      <td class="col-stale">${stack.staleCount > 0 ? `<span class="stale-badge">${stack.staleCount}</span>` : "—"}</td>
      <td class="col-actions">
        <div class="action-group">
          <div class="rebase-group">
            <button class="restack-btn" data-branch="${escAttr(stack.root.headBranch)}">Restack</button>
            <button class="sync-btn" data-branch="${escAttr(stack.root.headBranch)}">Sync</button>
          </div>
          <div class="merge-stack-group">
            <select class="strategy-select" aria-label="Merge strategy">
              <option value="merge">merge</option>
              <option value="squash">squash</option>
              <option value="rebase">rebase</option>
            </select>
            <button class="merge-stack-btn" data-branch="${escAttr(stack.root.headBranch)}">Merge Stack</button>
          </div>
        </div>
      </td>
    `

    tbody.appendChild(row)
  }
}

// ─── Event delegation ─────────────────────────────────────────────────────────

function setupDelegation(tbody: Element): void {
  tbody.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest("button") as HTMLButtonElement | null
    if (!btn || btn.disabled) return
    const branch = btn.dataset["branch"] ?? ""
    if (!branch) return

    if (btn.classList.contains("restack-btn")) {
      triggerRestack(branch, btn)
    } else if (btn.classList.contains("sync-btn")) {
      triggerSync(branch, btn)
    } else if (btn.classList.contains("merge-stack-btn")) {
      const strategy = (
        btn.closest(".merge-stack-group")?.querySelector(".strategy-select") as HTMLSelectElement | null
      )?.value ?? "merge"
      triggerMergeStack(branch, strategy, btn)
    }
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function updateStacksView(prs: ApiPR[]): void {
  const stacks = detectStacks(prs)

  const countEl = document.getElementById("stacks-count")
  if (countEl) countEl.textContent = `${stacks.length} stack${stacks.length !== 1 ? "s" : ""}  ·  ${prs.length} PRs`

  renderTable(stacks)
}

export function setupStacksView(): void {
  const tbody = document.querySelector("#stacks-table tbody")!
  setupDelegation(tbody)
  renderTable([])
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function escAttr(str: string): string {
  return str.replace(/"/g, "&quot;")
}
