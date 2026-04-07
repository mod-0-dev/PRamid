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
  /**
   * Force-push a branch to the remote. Uses the local branch's current tip.
   * GitHub has no server-side force-push API, so this delegates to git.
   * GitLab has server-side force-push via the rebase API, but this method is still
   * a no-op because branch updates happen through other means.
   */
  forcePush(branch: string, sha: string, cwd: string, remote?: string): Promise<void>
  /**
   * Rebase a branch on its parent.
   * For GitHub: uses local git operations (call git-ops directly).
   * For GitLab: uses platform-side rebase API (POST /projects/:id/merge_requests/:iid/rebase).
   */
  rebaseBranch(prId: string): Promise<RebaseResult>
  mergePR(prId: string, strategy: MergeStrategy): Promise<void>
  closePR(prId: string): Promise<void>
  updatePRBody(prId: string, body: string): Promise<void>
  getCIStatus(prId: string): Promise<CiStatus>
  getReviewStatus(prId: string): Promise<ReviewStatus>
}
