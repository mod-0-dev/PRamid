import { describe, expect, test } from "bun:test"
import { stackGoto, stackNext, stackPrev } from "./nav-service.ts"
import type { PullRequest } from "./graph.ts"

const makePr = (n: number, head: string, base: string): PullRequest => ({
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
})

// Linear stack: main → feat/a (#1) → feat/b (#2) → feat/c (#3)
const LINEAR = [makePr(1, "feat/a", "main"), makePr(2, "feat/b", "feat/a"), makePr(3, "feat/c", "feat/b")]

// Branching: main → feat/a (#1) → feat/b (#2) and feat/a → feat/c (#3)
const BRANCHING = [makePr(1, "feat/a", "main"), makePr(2, "feat/b", "feat/a"), makePr(3, "feat/c", "feat/a")]

// ─── stackNext ────────────────────────────────────────────────────────────────

describe("stackNext", () => {
  test("returns the single child", () => {
    const result = stackNext(LINEAR, "feat/a")
    expect(result).toEqual({ ok: true, branch: "feat/b" })
  })

  test("returns middle child correctly", () => {
    const result = stackNext(LINEAR, "feat/b")
    expect(result).toEqual({ ok: true, branch: "feat/c" })
  })

  test("errors at the top of the stack", () => {
    const result = stackNext(LINEAR, "feat/c")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("top of the stack")
  })

  test("errors with choices when multiple children", () => {
    const result = stackNext(BRANCHING, "feat/a")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.choices).toHaveLength(2)
      expect(result.error).toContain("2 child branches")
    }
  })

  test("errors for unknown branch", () => {
    const result = stackNext(LINEAR, "nonexistent")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("has no open PR")
  })
})

// ─── stackPrev ────────────────────────────────────────────────────────────────

describe("stackPrev", () => {
  test("returns parent branch", () => {
    const result = stackPrev(LINEAR, "feat/b")
    expect(result).toEqual({ ok: true, branch: "feat/a" })
  })

  test("returns base branch at stack root with atRoot flag", () => {
    const result = stackPrev(LINEAR, "feat/a")
    expect(result).toEqual({ ok: true, branch: "main", atRoot: true })
  })

  test("returns parent when multiple siblings", () => {
    const result = stackPrev(BRANCHING, "feat/b")
    expect(result).toEqual({ ok: true, branch: "feat/a" })
  })

  test("errors for unknown branch", () => {
    const result = stackPrev(LINEAR, "nonexistent")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("has no open PR")
  })
})

// ─── stackGoto ────────────────────────────────────────────────────────────────

describe("stackGoto", () => {
  test("matches by exact branch name", () => {
    expect(stackGoto(LINEAR, "feat/b")).toEqual({ ok: true, branch: "feat/b" })
  })

  test("matches by PR number as string", () => {
    expect(stackGoto(LINEAR, "2")).toEqual({ ok: true, branch: "feat/b" })
  })

  test("matches by PR number with # prefix", () => {
    expect(stackGoto(LINEAR, "#2")).toEqual({ ok: true, branch: "feat/b" })
  })

  test("matches by partial branch name substring", () => {
    expect(stackGoto(LINEAR, "feat/c")).toEqual({ ok: true, branch: "feat/c" })
  })

  test("matches partial substring uniquely", () => {
    const prs = [makePr(1, "feat/add-auth", "main"), makePr(2, "feat/add-tests", "main")]
    // "add-auth" uniquely matches feat/add-auth
    expect(stackGoto(prs, "auth")).toEqual({ ok: true, branch: "feat/add-auth" })
  })

  test("errors with choices when partial matches multiple branches", () => {
    const result = stackGoto(LINEAR, "feat/")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.choices).toHaveLength(3)
      expect(result.error).toContain("3 branches")
    }
  })

  test("errors when no match found", () => {
    const result = stackGoto(LINEAR, "nonexistent")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("No branch matching")
  })

  test("does not match PR number when string has non-numeric characters", () => {
    // "2x" should not match PR #2
    const result = stackGoto(LINEAR, "2x")
    expect(result.ok).toBe(false)
  })
})
