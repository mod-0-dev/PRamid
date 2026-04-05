export type Platform = "github" | "gitlab"

export type PrId = string // format: "platform:owner/repo#number"

export type CiStatus = "success" | "failure" | "pending" | "none"
export type ReviewStatus = "approved" | "changes_requested" | "pending" | "none"

export interface PullRequest {
  id: PrId
  platform: Platform
  number: number
  title: string
  url: string
  author: string
  headBranch: string
  baseBranch: string
  ciStatus: CiStatus
  reviewStatus: ReviewStatus
  /** true = mergeable, false = conflicting, null = GitHub hasn't computed it yet */
  mergeable: boolean | null
  stale: boolean
  merged: boolean
  draft: boolean
  body: string
}

export interface StackEdge {
  parentId: PrId
  childId: PrId
}

export interface StackGraph {
  nodes: Map<PrId, PullRequest>
  edges: StackEdge[]
}

export function createGraph(): StackGraph {
  return { nodes: new Map(), edges: [] }
}

export function addNode(graph: StackGraph, pr: PullRequest): void {
  graph.nodes.set(pr.id, pr)
}

export function buildEdges(graph: StackGraph): void {
  const byHead = new Map<string, PrId>()
  for (const [id, pr] of graph.nodes) {
    byHead.set(pr.headBranch, id)
  }
  graph.edges = []
  for (const [, pr] of graph.nodes) {
    const parentId = byHead.get(pr.baseBranch)
    if (parentId) {
      graph.edges.push({ parentId, childId: pr.id })
    }
  }
}

export function buildGraph(prs: PullRequest[]): StackGraph {
  const graph = createGraph()
  for (const pr of prs) addNode(graph, pr)
  buildEdges(graph)
  return graph
}
