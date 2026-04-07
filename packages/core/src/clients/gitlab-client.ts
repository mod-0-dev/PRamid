import type { CiStatus, PullRequest, ReviewStatus } from "../graph/graph.ts"
import { sleep } from "../utils.ts"
import type {
  CreatePRParams,
  MergeStrategy,
  RebaseResult,
  RepoRef,
  VcsClient,
} from "./vcs-client.ts"

// ─── PrId helpers ─────────────────────────────────────────────────────────────

/** Parse "gitlab:owner/repo#123" into constituent parts. */
function parsePrId(prId: string): { projectPath: string; iid: number } {
  const match = /^gitlab:([^#]+)#(\d+)$/.exec(prId)
  if (!match) {
    throw new Error(`Invalid GitLab PrId: "${prId}". Expected "gitlab:owner/repo#number".`)
  }
  return { projectPath: match[1] as string, iid: Number(match[2]) }
}

function makePrId(projectPath: string, iid: number): string {
  return `gitlab:${projectPath}#${iid}`
}

/** URL-encode a "owner/repo" project path for use in GitLab API paths. */
function encodeProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}

// ─── GitLab REST response shapes ─────────────────────────────────────────────

interface GitLabMR {
  iid: number
  title: string
  description: string | null
  web_url: string
  draft: boolean
  state: "opened" | "closed" | "merged" | "locked"
  source_branch: string
  target_branch: string
  author: { username: string } | null
  merge_status:
    | "can_be_merged"
    | "cannot_be_merged"
    | "checking"
    | "unchecked"
    | "cannot_be_merged_recheck"
    | string
  rebase_in_progress?: boolean
  merge_error?: string | null
}

interface GitLabPipeline {
  id: number
  status:
    | "created"
    | "waiting_for_resource"
    | "preparing"
    | "pending"
    | "running"
    | "success"
    | "failed"
    | "canceled"
    | "skipped"
    | "manual"
    | "scheduled"
}

interface GitLabApprovals {
  approved: boolean
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapCiStatus(pipelines: GitLabPipeline[]): CiStatus {
  if (pipelines.length === 0) return "none"
  const latest = pipelines[0] as GitLabPipeline
  switch (latest.status) {
    case "success":
      return "success"
    case "failed":
      return "failure"
    case "running":
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
      return "pending"
    default:
      return "none"
  }
}

function mapMergeable(mergeStatus: GitLabMR["merge_status"]): boolean | null {
  if (mergeStatus === "can_be_merged") return true
  if (mergeStatus === "cannot_be_merged") return false
  return null
}

function isDraft(mr: GitLabMR): boolean {
  return mr.draft || mr.title.startsWith("Draft:") || mr.title.startsWith("WIP:")
}

function mrToPullRequest(
  mr: GitLabMR,
  projectPath: string,
  ciStatus: CiStatus,
  reviewStatus: ReviewStatus,
): PullRequest {
  return {
    id: makePrId(projectPath, mr.iid),
    platform: "gitlab",
    number: mr.iid,
    title: mr.title,
    body: mr.description ?? "",
    url: mr.web_url,
    author: mr.author?.username ?? "",
    headBranch: mr.source_branch,
    baseBranch: mr.target_branch,
    ciStatus,
    reviewStatus,
    mergeable: mapMergeable(mr.merge_status),
    stale: false,
    merged: mr.state === "merged",
    draft: isDraft(mr),
  }
}

// ─── Rate-limit detection ─────────────────────────────────────────────────────

function getRateLimitWaitMs(resp: Response): number | null {
  if (resp.status === 429) {
    const retryAfter = resp.headers.get("retry-after")
    const resetAt = resp.headers.get("ratelimit-reset")
    if (retryAfter) return Number(retryAfter) * 1000
    if (resetAt) return Math.max(0, Number(resetAt) * 1000 - Date.now()) + 1000
    return 60_000
  }
  return null
}

// ─── GitLabClient ─────────────────────────────────────────────────────────────

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class GitLabClient implements VcsClient {
  readonly #token: string
  readonly #baseUrl: string
  readonly #maxRetries: number
  readonly #fetch: FetchFn

  constructor(
    token: string,
    options?: {
      /** Override the GitLab API base URL (default: "https://gitlab.com/api/v4"). */
      baseUrl?: string
      /** Maximum retries on rate-limit errors (default: 3). */
      maxRetries?: number
      /** Override fetch for testing. */
      _fetch?: FetchFn
    },
  ) {
    this.#token = token
    this.#baseUrl = (options?.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/$/, "")
    this.#maxRetries = options?.maxRetries ?? 3
    this.#fetch = options?._fetch ?? ((...args) => fetch(...args))
  }

  // ── Private: authenticated fetch with retry ────────────────────────────────

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.#baseUrl}${path}`
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.#token,
      "Content-Type": "application/json",
      "User-Agent": "pramid/0.0.1",
      ...(init?.headers as Record<string, string> | undefined),
    }

    let attempt = 0
    while (true) {
      const resp = await this.#fetch(url, { ...init, headers })
      const waitMs = getRateLimitWaitMs(resp)
      if (waitMs !== null && attempt < this.#maxRetries) {
        await sleep(waitMs)
        attempt++
        continue
      }
      return resp
    }
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await this.#request(path, init)
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      throw new Error(`GitLab API ${resp.status} for ${path}: ${body}`)
    }
    return resp.json() as Promise<T>
  }

  // ── listOpenPRs ─────────────────────────────────────────────────────────────

  async listOpenPRs(repo: RepoRef): Promise<PullRequest[]> {
    const projectPath = `${repo.owner}/${repo.repo}`
    const encoded = encodeProject(projectPath)
    const results: PullRequest[] = []
    let page = 1

    while (true) {
      const resp = await this.#request(
        `/projects/${encoded}/merge_requests?state=opened&per_page=100&page=${page}`,
      )
      if (!resp.ok) {
        const body = await resp.text().catch(() => "")
        throw new Error(`GitLab API ${resp.status}: ${body}`)
      }
      const mrs = (await resp.json()) as GitLabMR[]

      for (const mr of mrs) {
        // Fetch pipeline + approvals in parallel for each MR
        const [pipelines, approvals] = await Promise.all([
          this.#json<GitLabPipeline[]>(
            `/projects/${encoded}/merge_requests/${mr.iid}/pipelines?per_page=1`,
          ).catch(() => [] as GitLabPipeline[]),
          this.#json<GitLabApprovals>(
            `/projects/${encoded}/merge_requests/${mr.iid}/approvals`,
          ).catch(() => ({ approved: false })),
        ])
        const ciStatus = mapCiStatus(pipelines)
        const reviewStatus: ReviewStatus = approvals.approved ? "approved" : "none"
        results.push(mrToPullRequest(mr, projectPath, ciStatus, reviewStatus))
      }

      const nextPage = resp.headers.get("x-next-page")
      if (!nextPage || nextPage === "") break
      page = Number(nextPage)
    }

    return results
  }

  // ── getPR ───────────────────────────────────────────────────────────────────

  async getPR(prId: string): Promise<PullRequest> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)

    const [mr, pipelines, approvals] = await Promise.all([
      this.#json<GitLabMR>(`/projects/${encoded}/merge_requests/${iid}`),
      this.#json<GitLabPipeline[]>(
        `/projects/${encoded}/merge_requests/${iid}/pipelines?per_page=1`,
      ).catch(() => [] as GitLabPipeline[]),
      this.#json<GitLabApprovals>(`/projects/${encoded}/merge_requests/${iid}/approvals`).catch(
        () => ({ approved: false }),
      ),
    ])

    const ciStatus = mapCiStatus(pipelines)
    const reviewStatus: ReviewStatus = approvals.approved ? "approved" : "none"
    return mrToPullRequest(mr, projectPath, ciStatus, reviewStatus)
  }

  // ── createPR ────────────────────────────────────────────────────────────────

  async createPR(repo: RepoRef, params: CreatePRParams): Promise<PullRequest> {
    const projectPath = `${repo.owner}/${repo.repo}`
    const encoded = encodeProject(projectPath)

    const mr = await this.#json<GitLabMR>(`/projects/${encoded}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: params.head,
        target_branch: params.base,
        title: params.draft ? `Draft: ${params.title}` : params.title,
        description: params.body ?? "",
        draft: params.draft ?? false,
      }),
    })

    return mrToPullRequest(mr, projectPath, "none", "none")
  }

  // ── updateBaseBranch ────────────────────────────────────────────────────────

  async updateBaseBranch(prId: string, newBase: string): Promise<void> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    await this.#json<GitLabMR>(`/projects/${encoded}/merge_requests/${iid}`, {
      method: "PUT",
      body: JSON.stringify({ target_branch: newBase }),
    })
  }

  // ── mergePR ─────────────────────────────────────────────────────────────────

  async mergePR(prId: string, strategy: MergeStrategy): Promise<void> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    const body = JSON.stringify({ squash: strategy === "squash" })

    // GitLab can return 405 immediately after a base-branch retarget while the
    // internal MR state catches up. Retry a few times with a short back-off.
    const maxAttempts = 4
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await this.#request(`/projects/${encoded}/merge_requests/${iid}/merge`, {
        method: "PUT",
        body,
      })
      if (resp.ok) return
      if (resp.status === 405 && attempt < maxAttempts) {
        await sleep(attempt * 2_000)
        continue
      }
      const text = await resp.text().catch(() => "")
      if (resp.status === 405 && strategy === "squash") {
        throw new Error(
          `GitLab rejected squash merge for MR !${iid} (405). This usually means the branch is not up-to-date with its target. Run \`pramid stack sync\` to rebase the stack onto the latest trunk, then retry.`,
        )
      }
      throw new Error(`GitLab API ${resp.status} for /merge: ${text}`)
    }
  }

  // ── closePR ─────────────────────────────────────────────────────────────────

  async closePR(prId: string): Promise<void> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    await this.#json<GitLabMR>(`/projects/${encoded}/merge_requests/${iid}`, {
      method: "PUT",
      body: JSON.stringify({ state_event: "close" }),
    })
  }

  // ── updatePRBody ────────────────────────────────────────────────────────────

  async updatePRBody(prId: string, body: string): Promise<void> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    await this.#json<GitLabMR>(`/projects/${encoded}/merge_requests/${iid}`, {
      method: "PUT",
      body: JSON.stringify({ description: body }),
    })
  }

  // ── rebaseBranch ────────────────────────────────────────────────────────────

  async rebaseBranch(prId: string): Promise<RebaseResult> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)

    // Trigger the platform-side rebase
    const triggerResp = await this.#request(`/projects/${encoded}/merge_requests/${iid}/rebase`, {
      method: "POST",
    })
    if (!triggerResp.ok) {
      const body = await triggerResp.text().catch(() => "")
      return {
        success: false,
        errorMessage: `Rebase trigger failed (${triggerResp.status}): ${body}`,
      }
    }

    // Poll until rebase_in_progress is false (max 30 polls × 2 s = 60 s)
    const maxPolls = 30
    for (let i = 0; i < maxPolls; i++) {
      await sleep(2_000)
      const mr = await this.#json<GitLabMR>(`/projects/${encoded}/merge_requests/${iid}`)
      if (!mr.rebase_in_progress) {
        if (mr.merge_error) {
          return { success: false, errorMessage: mr.merge_error }
        }
        return { success: true }
      }
    }

    return { success: false, errorMessage: "Rebase timed out after 60 s of polling." }
  }

  // ── getCIStatus ─────────────────────────────────────────────────────────────

  async getCIStatus(prId: string): Promise<CiStatus> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    const pipelines = await this.#json<GitLabPipeline[]>(
      `/projects/${encoded}/merge_requests/${iid}/pipelines?per_page=1`,
    ).catch(() => [] as GitLabPipeline[])
    return mapCiStatus(pipelines)
  }

  // ── getReviewStatus ─────────────────────────────────────────────────────────

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const { projectPath, iid } = parsePrId(prId)
    const encoded = encodeProject(projectPath)
    const approvals = await this.#json<GitLabApprovals>(
      `/projects/${encoded}/merge_requests/${iid}/approvals`,
    ).catch(() => ({ approved: false }))
    return approvals.approved ? "approved" : "none"
  }

  // ── forcePush — git operation, not a GitLab API call ─────────────────────

  async forcePush(
    _branch: string,
    _sha: string,
    _cwd: string,
    _remote?: string,
  ): Promise<void> {
    // forcePush is a local git operation, not a GitLab API call.
    // Use git-ops.forcePush() directly from the calling code.
  }

}
