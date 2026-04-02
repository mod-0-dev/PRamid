export interface ApiPR {
  id: string
  number: number
  title: string
  url: string
  author: string
  headBranch: string
  baseBranch: string
  ciStatus: "success" | "failure" | "pending" | "none"
  reviewStatus: "approved" | "changes_requested" | "pending" | "none"
  stale: boolean
  draft: boolean
}
