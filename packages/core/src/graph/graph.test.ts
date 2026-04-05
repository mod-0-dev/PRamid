import { describe, expect, test } from "bun:test"
import { addNode, buildEdges, buildGraph, createGraph } from "./graph.ts"
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

const PR1 = makePr(1, "stack/1", "main")
const PR2 = makePr(2, "stack/2", "stack/1")
const PR4 = makePr(4, "fix/typo", "main")

describe("buildEdges", () => {
  test("links PRs by branch names", () => {
    const graph = createGraph()
    addNode(graph, PR1)
    addNode(graph, PR2)
    buildEdges(graph)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual({
      parentId: "github:owner/repo#1",
      childId: "github:owner/repo#2",
    })
  })

  test("produces no edges when no branches match", () => {
    const graph = createGraph()
    addNode(graph, PR1)
    addNode(graph, PR4)
    buildEdges(graph)

    expect(graph.edges).toHaveLength(0)
  })
})

describe("buildGraph", () => {
  test("creates graph with nodes and edges from PR list", () => {
    const graph = buildGraph([PR1, PR2, makePr(3, "stack/3", "stack/2")])

    expect(graph.nodes.size).toBe(3)
    expect(graph.edges).toHaveLength(2)
  })

  test("returns empty graph for empty list", () => {
    const graph = buildGraph([])
    expect(graph.nodes.size).toBe(0)
    expect(graph.edges).toHaveLength(0)
  })

  test("handles unrelated PRs with no edges", () => {
    const graph = buildGraph([PR1, PR4])
    expect(graph.nodes.size).toBe(2)
    expect(graph.edges).toHaveLength(0)
  })
})
