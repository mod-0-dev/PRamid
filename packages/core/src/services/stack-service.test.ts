import { describe, expect, mock, test } from "bun:test"
import type { RepoRef, VcsClient } from "../clients/vcs-client.ts"
import type { PullRequest } from "../graph/graph.ts"
import { branchToTitle, createStack, formatLog, formatStatus } from "./stack-service.ts"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: "acme", repo: "app" }

const makePr = (
  n: number,
  head: string,
  base: string,
  extra: Partial<PullRequest> = {},
): PullRequest => ({
  id: `github:acme/app#${n}`,
  platform: "github",
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/acme/app/pull/${n}`,
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
  ...extra,
})

function makeClient(prs: PullRequest[], overrides: Partial<VcsClient> = {}): VcsClient {
  return {
    listOpenPRs: mock(() => Promise.resolve(prs)),
    getPR: mock(() => Promise.reject(new Error("not implemented"))),
    createPR: mock((_repo, params) =>
      Promise.resolve(makePr(99, params.head, params.base, { title: params.title })),
    ),
    updateBaseBranch: mock(() => Promise.resolve()),
    forcePush: mock(() => Promise.reject(new Error("not implemented"))),
    rebaseBranch: mock(() => Promise.reject(new Error("not implemented"))),
    mergePR: mock(() => Promise.resolve()),
    closePR: mock(() => Promise.resolve()),
    updatePRBody: mock(() => Promise.resolve()),
    getCIStatus: mock(() => Promise.resolve("none" as const)),
    getReviewStatus: mock(() => Promise.resolve("none" as const)),
    ...overrides,
  }
}

// ─── branchToTitle ────────────────────────────────────────────────────────────

describe("branchToTitle", () => {
  test("converts slash to colon-space", () => {
    expect(branchToTitle("feat/add-auth")).toBe("feat: add auth")
  })

  test("converts hyphens to spaces", () => {
    expect(branchToTitle("fix/typo-in-readme")).toBe("fix: typo in readme")
  })

  test("handles branch with no slash", () => {
    expect(branchToTitle("my-feature")).toBe("my feature")
  })
})

// ─── createStack ──────────────────────────────────────────────────────────────

describe("createStack", () => {
  test("creates PRs for branches that have none", async () => {
    const client = makeClient([])
    const result = await createStack(client, REPO, {
      base: "main",
      branches: ["feat/step-1", "feat/step-2"],
    })

    expect(result.created).toHaveLength(2)
    expect(result.updated).toHaveLength(0)
    expect(client.createPR).toHaveBeenCalledTimes(2)
  })

  test("sets correct base branch chain when creating", async () => {
    const client = makeClient([])
    await createStack(client, REPO, {
      base: "main",
      branches: ["feat/step-1", "feat/step-2", "feat/step-3"],
    })

    const calls = (client.createPR as ReturnType<typeof mock>).mock.calls as [
      RepoRef,
      { head: string; base: string },
    ][]
    expect(calls[0]?.[1].head).toBe("feat/step-1")
    expect(calls[0]?.[1].base).toBe("main")
    expect(calls[1]?.[1].head).toBe("feat/step-2")
    expect(calls[1]?.[1].base).toBe("feat/step-1")
    expect(calls[2]?.[1].head).toBe("feat/step-3")
    expect(calls[2]?.[1].base).toBe("feat/step-2")
  })

  test("updates base branch when PR exists with wrong base", async () => {
    const existingPr = makePr(1, "feat/step-2", "main") // wrong base — should be feat/step-1
    const client = makeClient([existingPr])

    const result = await createStack(client, REPO, {
      base: "main",
      branches: ["feat/step-1", "feat/step-2"],
    })

    expect(result.created).toHaveLength(1) // feat/step-1 is new
    expect(result.updated).toHaveLength(1) // feat/step-2 updated
    expect(client.updateBaseBranch).toHaveBeenCalledWith(existingPr.id, "feat/step-1")
  })

  test("leaves unchanged when PR already has correct base", async () => {
    const pr1 = makePr(1, "feat/step-1", "main")
    const pr2 = makePr(2, "feat/step-2", "feat/step-1")
    const client = makeClient([pr1, pr2])

    const result = await createStack(client, REPO, {
      base: "main",
      branches: ["feat/step-1", "feat/step-2"],
    })

    expect(result.created).toHaveLength(0)
    expect(result.updated).toHaveLength(0)
    expect(result.unchanged).toHaveLength(2)
    expect(client.createPR).not.toHaveBeenCalled()
    expect(client.updateBaseBranch).not.toHaveBeenCalled()
  })

  test("uses custom titleFn", async () => {
    const client = makeClient([])
    await createStack(client, REPO, {
      base: "main",
      branches: ["feat/step-1"],
      titleFn: (b) => `Custom: ${b}`,
    })

    const calls = (client.createPR as ReturnType<typeof mock>).mock.calls as [
      RepoRef,
      { title: string },
    ][]
    expect(calls[0]?.[1].title).toBe("Custom: feat/step-1")
  })
})

// ─── formatStatus ─────────────────────────────────────────────────────────────

describe("formatStatus", () => {
  test("returns message for empty list", () => {
    expect(formatStatus([])).toBe("No open pull requests.")
  })

  test("shows standalone PR", () => {
    const output = formatStatus([makePr(1, "fix/typo", "main")])
    expect(output).toContain("#1")
    expect(output).toContain("fix/typo → main")
  })

  test("shows stack with parent and child", () => {
    const pr1 = makePr(1, "stack/base", "main")
    const pr2 = makePr(2, "stack/child", "stack/base")
    const output = formatStatus([pr1, pr2])

    expect(output).toContain("#1")
    expect(output).toContain("#2")
    // Child should appear after parent
    expect(output.indexOf("#1")).toBeLessThan(output.indexOf("#2"))
  })

  test("includes CI and review indicators", () => {
    const pr = makePr(1, "feat/x", "main", { ciStatus: "success", reviewStatus: "approved" })
    const output = formatStatus([pr])

    expect(output).toContain("CI:✓")
    expect(output).toContain("review:approved")
  })

  test("shows stale indicator", () => {
    const pr = makePr(1, "feat/x", "main", { stale: true })
    expect(formatStatus([pr])).toContain("[stale]")
  })

  test("shows draft indicator", () => {
    const pr = makePr(1, "feat/x", "main", { draft: true })
    expect(formatStatus([pr])).toContain("[draft]")
  })
})

// ─── formatLog ────────────────────────────────────────────────────────────────

describe("formatLog", () => {
  test("returns message for empty list", () => {
    expect(formatLog([])).toBe("No open pull requests.")
  })

  test("shows base branch label at top of stack", () => {
    const pr1 = makePr(1, "stack/base", "main")
    const pr2 = makePr(2, "stack/child", "stack/base")
    const output = formatLog([pr1, pr2])
    expect(output).toContain("main")
    expect(output.indexOf("main")).toBeLessThan(output.indexOf("(#1)"))
  })

  test("shows PR number and title in tree line", () => {
    const pr1 = makePr(1, "feat/step-1", "main")
    const pr2 = makePr(2, "feat/step-2", "feat/step-1")
    const output = formatLog([pr1, pr2])
    expect(output).toContain("(#1)")
    expect(output).toContain("(#2)")
    expect(output).toContain("PR 1")
    expect(output).toContain("PR 2")
  })

  test("shows CI icons", () => {
    const pr1 = makePr(1, "feat/a", "main", { ciStatus: "success" })
    const pr2 = makePr(2, "feat/b", "feat/a", { ciStatus: "failure" })
    const pr3 = makePr(3, "feat/c", "feat/b", { ciStatus: "pending" })
    const output = formatLog([pr1, pr2, pr3])
    expect(output).toContain("✓")
    expect(output).toContain("✗")
    expect(output).toContain("●")
  })

  test("shows review labels", () => {
    const pr1 = makePr(1, "feat/a", "main", { reviewStatus: "approved" })
    const pr2 = makePr(2, "feat/b", "feat/a", { reviewStatus: "changes_requested" })
    const output = formatLog([pr1, pr2])
    expect(output).toContain("approved")
    expect(output).toContain("changes")
  })

  test("shows stale indicator", () => {
    const pr1 = makePr(1, "feat/a", "main")
    const pr2 = makePr(2, "feat/b", "feat/a", { stale: true })
    const output = formatLog([pr1, pr2])
    expect(output).toContain("← restack needed")
  })

  test("shows draft indicator", () => {
    const pr1 = makePr(1, "feat/a", "main")
    const pr2 = makePr(2, "feat/b", "feat/a", { draft: true })
    const output = formatLog([pr1, pr2])
    expect(output).toContain("[draft]")
  })

  test("scopes to sub-tree rooted at the given branch", () => {
    const pr1 = makePr(1, "stack-a/1", "main")
    const pr2 = makePr(2, "stack-a/2", "stack-a/1")
    const pr3 = makePr(3, "stack-a/3", "stack-a/2")
    const pr4 = makePr(4, "stack-b/1", "main")
    // Scoping to stack-a/2 should show stack-a/2 and its child stack-a/3, but not stack-a/1 or stack-b/1
    const output = formatLog([pr1, pr2, pr3, pr4], { branch: "stack-a/2" })
    expect(output).not.toContain("(#1)")
    expect(output).toContain("(#2)")
    expect(output).toContain("(#3)")
    expect(output).not.toContain("(#4)")
  })

  test("returns not-found message for unknown branch", () => {
    const pr = makePr(1, "feat/x", "main")
    expect(formatLog([pr], { branch: "nonexistent" })).toContain("No open PR found")
  })

  test("uses tree connectors", () => {
    const pr1 = makePr(1, "feat/a", "main")
    const pr2 = makePr(2, "feat/b", "feat/a")
    const pr3 = makePr(3, "feat/c", "feat/a")
    const output = formatLog([pr1, pr2, pr3])
    expect(output).toContain("├──")
    expect(output).toContain("└──")
  })

  test("no ANSI codes in plain mode", () => {
    const pr1 = makePr(1, "feat/a", "main")
    const pr2 = makePr(2, "feat/b", "feat/a")
    const output = formatLog([pr1, pr2], { color: false })
    expect(output).not.toContain("\x1b[")
  })

  test("includes ANSI codes in color mode", () => {
    const pr1 = makePr(1, "feat/a", "main")
    const pr2 = makePr(2, "feat/b", "feat/a")
    const output = formatLog([pr1, pr2], { color: true })
    expect(output).toContain("\x1b[")
  })
})
