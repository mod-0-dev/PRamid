import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"
import type { VcsClient, RepoRef, MergeStrategy, RebaseResult, CreatePRParams } from "./vcs-client.ts"
import type { PullRequest, CiStatus, ReviewStatus } from "./graph.ts"

// ─── PrId helpers ─────────────────────────────────────────────────────────────

/** Parse "github:owner/repo#123" into constituent parts. */
function parsePrId(prId: string): { owner: string; repo: string; number: number } {
  const match = /^github:([^/]+)\/([^#]+)#(\d+)$/.exec(prId)
  if (!match) {
    throw new Error(`Invalid GitHub PrId: "${prId}". Expected "github:owner/repo#number".`)
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
}

function makePrId(owner: string, repo: string, number: number): string {
  return `github:${owner}/${repo}#${number}`
}

// ─── GraphQL types ─────────────────────────────────────────────────────────────

interface GqlPrNode {
  number: number
  title: string
  body: string
  url: string
  isDraft: boolean
  state: "OPEN" | "CLOSED" | "MERGED"
  headRefName: string
  baseRefName: string
  author: { login: string } | null
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  statusCheckRollup: { state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" } | null
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
}

interface GqlListOpenPRsResponse {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: GqlPrNode[]
    }
  }
}

const LIST_OPEN_PRS_QUERY = `
  query ListOpenPRs($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(
        first: 100
        states: [OPEN]
        after: $cursor
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          url
          isDraft
          state
          headRefName
          baseRefName
          author { login }
          reviewDecision
          statusCheckRollup { state }
          mergeable
        }
      }
    }
  }
`

const GET_PR_QUERY = `
  query GetPR($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        body
        url
        isDraft
        state
        headRefName
        baseRefName
        reviewDecision
        statusCheckRollup { state }
        mergeable
      }
    }
  }
`

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapReviewDecision(
  value: GqlPrNode["reviewDecision"],
): ReviewStatus {
  switch (value) {
    case "APPROVED": return "approved"
    case "CHANGES_REQUESTED": return "changes_requested"
    case "REVIEW_REQUIRED": return "pending"
    default: return "none"
  }
}

function mapCiStatus(
  rollup: GqlPrNode["statusCheckRollup"],
): CiStatus {
  if (!rollup) return "none"
  switch (rollup.state) {
    case "SUCCESS": return "success"
    case "FAILURE":
    case "ERROR": return "failure"
    case "PENDING":
    case "EXPECTED": return "pending"
    default: return "none"
  }
}

function gqlNodeToPullRequest(
  node: GqlPrNode,
  owner: string,
  repo: string,
): PullRequest {
  return {
    id: makePrId(owner, repo, node.number),
    platform: "github",
    number: node.number,
    title: node.title,
    body: node.body ?? "",
    url: node.url,
    author: node.author?.login ?? "",
    headBranch: node.headRefName,
    baseBranch: node.baseRefName,
    ciStatus: mapCiStatus(node.statusCheckRollup),
    reviewStatus: mapReviewDecision(node.reviewDecision),
    mergeable: node.mergeable === "MERGEABLE" ? true : node.mergeable === "CONFLICTING" ? false : null,
    stale: false,
    merged: node.state === "MERGED",
    draft: node.isDraft,
  }
}

// ─── Rate-limit error detection ───────────────────────────────────────────────

interface HttpError {
  status?: number
  headers?: Record<string, string>
  message?: string
}

function isRateLimitError(err: unknown): err is HttpError & { retryAfterMs: number } {
  const e = err as HttpError
  if (e.status === 429) {
    const retryAfter = Number(e.headers?.["retry-after"] ?? 60)
    ;(e as unknown as Record<string, unknown>)["retryAfterMs"] = retryAfter * 1000
    return true
  }
  if (e.status === 403) {
    const remaining = e.headers?.["x-ratelimit-remaining"]
    const reset = e.headers?.["x-ratelimit-reset"]
    if (remaining === "0" && reset) {
      const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000
      ;(e as unknown as Record<string, unknown>)["retryAfterMs"] = waitMs
      return true
    }
    // Secondary rate limit message
    if (e.message?.toLowerCase().includes("secondary rate limit")) {
      ;(e as unknown as Record<string, unknown>)["retryAfterMs"] = 60_000
      return true
    }
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Internal Octokit types for injection ────────────────────────────────────

type GraphqlFn = (query: string, params?: Record<string, unknown>) => Promise<unknown>
type OctokitInstance = InstanceType<typeof Octokit>

// ─── GitHubClient ─────────────────────────────────────────────────────────────

export class GitHubClient implements VcsClient {
  readonly #octokit: OctokitInstance
  readonly #graphql: GraphqlFn
  readonly #maxRetries: number

  constructor(
    token: string,
    options?: {
      /** Override the Octokit REST instance (useful for testing). */
      _octokit?: OctokitInstance
      /** Override the GraphQL function (useful for testing). */
      _graphql?: GraphqlFn
      /** Maximum retries on rate-limit errors (default: 3). */
      maxRetries?: number
    },
  ) {
    this.#octokit =
      options?._octokit ??
      new Octokit({
        auth: token,
        userAgent: "pramid/0.0.1",
      })
    this.#graphql =
      options?._graphql ??
      (graphql.defaults({
        headers: { authorization: `bearer ${token}` },
      }) as unknown as GraphqlFn)
    this.#maxRetries = options?.maxRetries ?? 3
  }

  // ── Private: retry wrapper ──────────────────────────────────────────────────

  async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0
    while (true) {
      try {
        return await fn()
      } catch (err) {
        if (isRateLimitError(err) && attempt < this.#maxRetries) {
          const waitMs = (err as unknown as { retryAfterMs: number }).retryAfterMs
          await sleep(waitMs)
          attempt++
          continue
        }
        throw err
      }
    }
  }

  // ── listOpenPRs ─────────────────────────────────────────────────────────────

  async listOpenPRs(repo: RepoRef): Promise<PullRequest[]> {
    const results: PullRequest[] = []
    let cursor: string | null = null

    do {
      const response = await this.#withRetry(() =>
        this.#graphql(LIST_OPEN_PRS_QUERY, {
          owner: repo.owner,
          repo: repo.repo,
          cursor,
        }) as Promise<GqlListOpenPRsResponse>,
      ) as GqlListOpenPRsResponse

      for (const node of response.repository.pullRequests.nodes) {
        results.push(gqlNodeToPullRequest(node, repo.owner, repo.repo))
      }

      const pageInfo = response.repository.pullRequests.pageInfo
      cursor = pageInfo.hasNextPage ? (pageInfo.endCursor ?? null) : null
    } while (cursor !== null)

    return results
  }

  // ── getPR ───────────────────────────────────────────────────────────────────

  async getPR(prId: string): Promise<PullRequest> {
    const { owner, repo, number } = parsePrId(prId)

    const response = await this.#withRetry(() =>
      this.#graphql(GET_PR_QUERY, { owner, repo, number }) as Promise<{
        repository: { pullRequest: GqlPrNode | null }
      }>,
    ) as { repository: { pullRequest: GqlPrNode | null } }

    const node = response.repository.pullRequest
    if (!node) {
      throw new Error(`PR not found: ${prId}`)
    }
    return gqlNodeToPullRequest(node, owner, repo)
  }

  // ── createPR ────────────────────────────────────────────────────────────────

  async createPR(repo: RepoRef, params: CreatePRParams): Promise<PullRequest> {
    const response = await this.#withRetry(() =>
      this.#octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body ?? "",
        draft: params.draft ?? false,
      }),
    )
    const pr = response.data
    return {
      id: `github:${repo.owner}/${repo.repo}#${pr.number}`,
      platform: "github",
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      url: pr.html_url,
      author: pr.user?.login ?? "",
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      ciStatus: "none",
      reviewStatus: "none",
      mergeable: null,
      stale: false,
      merged: false,
      draft: pr.draft ?? false,
    }
  }

  // ── updateBaseBranch ────────────────────────────────────────────────────────

  async updateBaseBranch(prId: string, newBase: string): Promise<void> {
    const { owner, repo, number } = parsePrId(prId)
    await this.#withRetry(() =>
      this.#octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: number,
        base: newBase,
      }),
    )
  }

  // ── mergePR ─────────────────────────────────────────────────────────────────

  async mergePR(prId: string, strategy: MergeStrategy): Promise<void> {
    const { owner, repo, number } = parsePrId(prId)
    const mergeMethod: "merge" | "squash" | "rebase" = strategy
    await this.#withRetry(() =>
      this.#octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method: mergeMethod,
      }),
    )
  }

  // ── updatePRBody ────────────────────────────────────────────────────────────

  async updatePRBody(prId: string, body: string): Promise<void> {
    const { owner, repo, number } = parsePrId(prId)
    await this.#withRetry(() =>
      this.#octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: number,
        body,
      }),
    )
  }

  // ── closePR ─────────────────────────────────────────────────────────────────

  async closePR(prId: string): Promise<void> {
    const { owner, repo, number } = parsePrId(prId)
    await this.#withRetry(() =>
      this.#octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: number,
        state: "closed",
      }),
    )
  }

  // ── getCIStatus ─────────────────────────────────────────────────────────────

  async getCIStatus(prId: string): Promise<CiStatus> {
    const pr = await this.getPR(prId)
    return pr.ciStatus
  }

  // ── getReviewStatus ─────────────────────────────────────────────────────────

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const pr = await this.getPR(prId)
    return pr.reviewStatus
  }

  // ── forcePush — git operation, not a GitHub API call ───────────────────────

  async forcePush(_branch: string, _sha: string): Promise<void> {
    throw new Error(
      "forcePush is a local git operation — implement in issue #19 (git integration).",
    )
  }

  // ── rebaseBranch — git operation, not a GitHub API call ───────────────────

  async rebaseBranch(_prId: string): Promise<RebaseResult> {
    throw new Error(
      "rebaseBranch is a local git operation — implement in issue #19 (git integration).",
    )
  }
}
