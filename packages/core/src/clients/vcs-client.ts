import type { CiStatus, PullRequest, ReviewStatus } from "../graph/graph.ts"

export interface RepoRef {
  owner: string
  repo: string
}

export type MergeStrategy = "merge" | "squash" | "rebase"

export interface RebaseResult {
  success: boolean
  conflictedFiles?: string[]
  /**
   * Set when git refused to start the rebase (e.g. dirty working tree).
   * In this case conflictedFiles will be empty — no rebase conflict occurred.
   */
  errorMessage?: string
}

export interface CreatePRParams {
  head: string
  base: string
  title: string
  body?: string
  draft?: boolean
}

export interface VcsClient {
  listOpenPRs(repo: RepoRef): Promise<PullRequest[]>
  getPR(prId: string): Promise<PullRequest>
  createPR(repo: RepoRef, params: CreatePRParams): Promise<PullRequest>
  updateBaseBranch(prId: string, newBase: string): Promise<void>
  forcePush(branch: string, sha: string): Promise<void>
  rebaseBranch(prId: string): Promise<RebaseResult>
  mergePR(prId: string, strategy: MergeStrategy): Promise<void>
  closePR(prId: string): Promise<void>
  updatePRBody(prId: string, body: string): Promise<void>
  getCIStatus(prId: string): Promise<CiStatus>
  getReviewStatus(prId: string): Promise<ReviewStatus>
}
