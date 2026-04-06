import { describe, expect, test } from "bun:test"
import {
  detectCycles,
  getChildren,
  getDescendants,
  getParent,
  getRoots,
  getStack,
  markStale,
  topologicalOrder,
} from "./dag.ts"
import { buildGraph } from "./graph.ts"
import type { PullRequest } from "./graph.ts"

const makePr = (n: number, head: string, base: string): PullRequest => ({
  id: `github:owner/repo#${n}`,
  platform: "github",
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/owner/repo/pull/${n}`,
  author: "test-user",
  headBranch: head,
  baseBranch: base,
  body: "",
  ciStatus: "none",
  reviewStatus: "none",
  mergeable: null,
  stale: false,
  merged: false,
  draft: false,
})

// Linear stack: main ← PR1 ← PR2 ← PR3
const PR1 = makePr(1, "stack/1", "main")
const PR2 = makePr(2, "stack/2", "stack/1")
const PR3 = makePr(3, "stack/3", "stack/2")

// Branching: main ← PR1 ← PR2
//                       └─ PR3b
const PR3b = makePr(3, "stack/3b", "stack/1")

// Unrelated PR
const PR4 = makePr(4, "fix/typo", "main")

describe("getRoots", () => {
  test("returns only root PRs in a linear stack", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    const roots = getRoots(graph)

    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe(PR1.id)
  })

  test("returns multiple roots for independent stacks", () => {
    const graph = buildGraph([PR1, PR4])
    const ids = getRoots(graph).map((p) => p.id)

    expect(ids).toHaveLength(2)
    expect(ids).toContain(PR1.id)
    expect(ids).toContain(PR4.id)
  })
})

describe("getParent", () => {
  test("returns parent for a child PR", () => {
    const graph = buildGraph([PR1, PR2, PR3])

    expect(getParent(graph, PR2.id)?.id).toBe(PR1.id)
    expect(getParent(graph, PR3.id)?.id).toBe(PR2.id)
  })

  test("returns null for a root PR", () => {
    expect(getParent(buildGraph([PR1, PR2]), PR1.id)).toBeNull()
  })

  test("returns null for unknown prId", () => {
    expect(getParent(buildGraph([PR1]), "github:owner/repo#999")).toBeNull()
  })
})

describe("getChildren", () => {
  test("returns direct children", () => {
    const graph = buildGraph([PR1, PR2, PR3])

    expect(getChildren(graph, PR1.id).map((p) => p.id)).toEqual([PR2.id])
    expect(getChildren(graph, PR2.id).map((p) => p.id)).toEqual([PR3.id])
  })

  test("returns multiple children in a branching stack", () => {
    const graph = buildGraph([PR1, PR2, PR3b])
    const ids = getChildren(graph, PR1.id).map((p) => p.id)

    expect(ids).toHaveLength(2)
    expect(ids).toContain(PR2.id)
    expect(ids).toContain(PR3b.id)
  })

  test("returns empty array for a leaf", () => {
    expect(getChildren(buildGraph([PR1, PR2, PR3]), PR3.id)).toHaveLength(0)
  })
})

describe("getStack", () => {
  test("returns the full linear stack from any member", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    const expected = [PR1.id, PR2.id, PR3.id]

    expect(getStack(graph, PR1.id).map((p) => p.id)).toEqual(expected)
    expect(getStack(graph, PR2.id).map((p) => p.id)).toEqual(expected)
    expect(getStack(graph, PR3.id).map((p) => p.id)).toEqual(expected)
  })

  test("first element is always the root", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    expect(getStack(graph, PR3.id)[0]?.id).toBe(PR1.id)
  })

  test("returns the full branching tree from any member", () => {
    const graph = buildGraph([PR1, PR2, PR3b])
    const ids = getStack(graph, PR2.id).map((p) => p.id)

    expect(ids).toHaveLength(3)
    expect(ids).toContain(PR1.id)
    expect(ids).toContain(PR2.id)
    expect(ids).toContain(PR3b.id)
  })

  test("returns just the PR when it has no neighbours", () => {
    expect(getStack(buildGraph([PR4]), PR4.id)).toHaveLength(1)
  })
})

describe("topologicalOrder", () => {
  test("returns linear stack in root-to-leaf order regardless of input order", () => {
    const graph = buildGraph([PR3, PR1, PR2])
    expect(topologicalOrder(graph).map((p) => p.id)).toEqual([PR1.id, PR2.id, PR3.id])
  })

  test("root appears before all children in a branching stack", () => {
    const graph = buildGraph([PR2, PR3b, PR1])
    const order = topologicalOrder(graph)
    const idx = (pr: PullRequest) => order.findIndex((p) => p.id === pr.id)

    expect(idx(PR1)).toBeLessThan(idx(PR2))
    expect(idx(PR1)).toBeLessThan(idx(PR3b))
  })

  test("returns all nodes for an acyclic graph", () => {
    expect(topologicalOrder(buildGraph([PR1, PR2, PR3]))).toHaveLength(3)
  })
})

describe("detectCycles", () => {
  test("returns empty array for an acyclic graph", () => {
    expect(detectCycles(buildGraph([PR1, PR2, PR3]))).toHaveLength(0)
  })

  test("detects a 2-node cycle", () => {
    const a = makePr(10, "branch-a", "branch-b")
    const b = makePr(11, "branch-b", "branch-a")
    expect(detectCycles(buildGraph([a, b])).length).toBeGreaterThan(0)
  })

  test("detects a 3-node cycle", () => {
    const a = makePr(10, "branch-a", "branch-c")
    const b = makePr(11, "branch-b", "branch-a")
    const c = makePr(12, "branch-c", "branch-b")
    expect(detectCycles(buildGraph([a, b, c])).length).toBeGreaterThan(0)
  })

  test("returns empty for an isolated PR", () => {
    expect(detectCycles(buildGraph([PR4]))).toHaveLength(0)
  })
})

describe("getDescendants", () => {
  test("returns the PR itself and all descendants", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    const ids = getDescendants(graph, PR1.id).map((p) => p.id)

    expect(ids).toHaveLength(3)
    expect(ids).toContain(PR1.id)
    expect(ids).toContain(PR2.id)
    expect(ids).toContain(PR3.id)
  })

  test("returns only the subtree, not siblings", () => {
    const graph = buildGraph([PR1, PR2, PR3b])
    const ids = getDescendants(graph, PR2.id).map((p) => p.id)

    expect(ids).toHaveLength(1)
    expect(ids).toContain(PR2.id)
    expect(ids).not.toContain(PR3b.id)
  })

  test("returns just the PR for a leaf", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    expect(getDescendants(graph, PR3.id)).toHaveLength(1)
  })
})

describe("markStale", () => {
  test("marks the target PR and all descendants stale", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    markStale(graph, PR1.id)

    expect(graph.nodes.get(PR1.id)?.stale).toBe(true)
    expect(graph.nodes.get(PR2.id)?.stale).toBe(true)
    expect(graph.nodes.get(PR3.id)?.stale).toBe(true)
  })

  test("does not mark unrelated PRs stale", () => {
    const graph = buildGraph([PR1, PR2, PR4])
    markStale(graph, PR1.id)

    expect(graph.nodes.get(PR4.id)?.stale).toBe(false)
  })

  test("marking a leaf only affects that leaf", () => {
    const graph = buildGraph([PR1, PR2, PR3])
    markStale(graph, PR3.id)

    expect(graph.nodes.get(PR3.id)?.stale).toBe(true)
    expect(graph.nodes.get(PR1.id)?.stale).toBe(false)
    expect(graph.nodes.get(PR2.id)?.stale).toBe(false)
  })

  test("does not mutate other fields on the PR", () => {
    const graph = buildGraph([PR1, PR2])
    markStale(graph, PR1.id)

    const updated = graph.nodes.get(PR1.id) as PullRequest
    expect(updated.title).toBe(PR1.title)
    expect(updated.headBranch).toBe(PR1.headBranch)
  })
})
