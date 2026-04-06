import type { PrId, PullRequest, StackGraph } from "./graph.ts"

export function getRoots(graph: StackGraph): PullRequest[] {
  const childIds = new Set(graph.edges.map((e) => e.childId))
  return [...graph.nodes.values()].filter((pr) => !childIds.has(pr.id))
}

export function getParent(graph: StackGraph, prId: PrId): PullRequest | null {
  const edge = graph.edges.find((e) => e.childId === prId)
  if (!edge) return null
  return graph.nodes.get(edge.parentId) ?? null
}

export function getChildren(graph: StackGraph, prId: PrId): PullRequest[] {
  return graph.edges
    .filter((e) => e.parentId === prId)
    .map((e) => graph.nodes.get(e.childId))
    .filter((pr): pr is PullRequest => pr !== undefined)
}

export function getStack(graph: StackGraph, prId: PrId): PullRequest[] {
  let rootId = prId
  const ascended = new Set<PrId>()
  while (true) {
    if (ascended.has(rootId)) break
    ascended.add(rootId)
    const parent = getParent(graph, rootId)
    if (!parent) break
    rootId = parent.id
  }

  const result: PullRequest[] = []
  const seen = new Set<PrId>()

  function collect(id: PrId): void {
    if (seen.has(id)) return
    seen.add(id)
    const pr = graph.nodes.get(id)
    if (pr) result.push(pr)
    for (const child of getChildren(graph, id)) collect(child.id)
  }

  collect(rootId)
  return result
}

export function topologicalOrder(graph: StackGraph): PullRequest[] {
  const inDegree = new Map<PrId, number>()
  const children = new Map<PrId, PrId[]>()

  for (const id of graph.nodes.keys()) {
    inDegree.set(id, 0)
    children.set(id, [])
  }
  for (const { parentId, childId } of graph.edges) {
    inDegree.set(childId, (inDegree.get(childId) ?? 0) + 1)
    children.get(parentId)?.push(childId)
  }

  const queue: PrId[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const result: PullRequest[] = []
  while (queue.length > 0) {
    const id = queue.shift() as PrId
    const pr = graph.nodes.get(id)
    if (pr) result.push(pr)
    for (const childId of children.get(id) ?? []) {
      const newDeg = (inDegree.get(childId) ?? 0) - 1
      inDegree.set(childId, newDeg)
      if (newDeg === 0) queue.push(childId)
    }
  }

  return result
}

export function detectCycles(graph: StackGraph): PrId[][] {
  const children = new Map<PrId, PrId[]>()
  for (const id of graph.nodes.keys()) children.set(id, [])
  for (const { parentId, childId } of graph.edges) {
    children.get(parentId)?.push(childId)
  }

  const visited = new Set<PrId>()
  const onStack = new Set<PrId>()
  const cycles: PrId[][] = []

  function dfs(id: PrId, path: PrId[]): void {
    if (onStack.has(id)) {
      const start = path.indexOf(id)
      cycles.push([...path.slice(start), id])
      return
    }
    if (visited.has(id)) return

    visited.add(id)
    onStack.add(id)
    path.push(id)

    for (const childId of children.get(id) ?? []) {
      dfs(childId, path)
    }

    path.pop()
    onStack.delete(id)
  }

  for (const id of graph.nodes.keys()) {
    if (!visited.has(id)) dfs(id, [])
  }

  return cycles
}

/** All PRs reachable from `prId` downward (inclusive), in no particular order. */
export function getDescendants(graph: StackGraph, prId: PrId): PullRequest[] {
  const result: PullRequest[] = []
  const seen = new Set<PrId>()
  const queue = [prId]
  while (queue.length > 0) {
    const id = queue.shift() as PrId
    if (seen.has(id)) continue
    seen.add(id)
    const pr = graph.nodes.get(id)
    if (pr) result.push(pr)
    for (const child of getChildren(graph, id)) queue.push(child.id)
  }
  return result
}

export function markStale(graph: StackGraph, prId: PrId): void {
  const pr = graph.nodes.get(prId)
  if (!pr) return
  graph.nodes.set(prId, { ...pr, stale: true })
  for (const child of getChildren(graph, prId)) {
    markStale(graph, child.id)
  }
}
