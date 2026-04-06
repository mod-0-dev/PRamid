import { describe, expect, mock, test } from "bun:test"
import type { RepoRef, VcsClient } from "../clients/vcs-client.ts"
import type { GitRunner } from "../git/git-ops.ts"
import type { PullRequest } from "../graph/graph.ts"
import { reorderStack, splitStack } from "./reorder-service.ts"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: "acme", repo: "app" }
const CWD = "/tmp/repo"

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

// Linear stack: main ← PR1(stack/1) ← PR2(stack/2) ← PR3(stack/3)
const PR1 = makePr(1, "stack/1", "main")
const PR2 = makePr(2, "stack/2", "stack/1")
const PR3 = makePr(3, "stack/3", "stack/2")

function makeClient(prs: PullRequest[]): VcsClient {
  return {
    listOpenPRs: mock(() => Promise.resolve(prs)),
    getPR: mock(() => Promise.reject(new Error("not used"))),
    createPR: mock(() => Promise.reject(new Error("not used"))),
    updateBaseBranch: mock(() => Promise.resolve()),
    forcePush: mock(() => Promise.reject(new Error("not used"))),
    rebaseBranch: mock(() => Promise.reject(new Error("not used"))),
    mergePR: mock(() => Promise.resolve()),
    closePR: mock(() => Promise.resolve()),
    updatePRBody: mock(() => Promise.resolve()),
    getCIStatus: mock(() => Promise.resolve("none" as const)),
    getReviewStatus: mock(() => Promise.resolve("none" as const)),
  }
}

function makeGitRunner(rebaseExitCode = 0): GitRunner {
  return {
    run: mock((args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", exitCode: 0 }
      }
      if (args[0] === "checkout") {
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      if (args[0] === "rebase") {
        return {
          stdout: rebaseExitCode !== 0 ? "CONFLICT (content): Merge conflict in src/auth.ts\n" : "",
          stderr: "",
          exitCode: rebaseExitCode,
        }
      }
      if (args[0] === "push") {
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }),
  }
}

// ─── reorderStack tests ───────────────────────────────────────────────────────

describe("reorderStack", () => {
  test("promotes branch above its parent in a 2-PR stack", async () => {
    const client = makeClient([PR1, PR2])
    const runner = makeGitRunner(0)

    const result = await reorderStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).toBeNull()
    expect(result.promotedPr.headBranch).toBe("stack/2")
    expect(result.demotedPr.headBranch).toBe("stack/1")
    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/2", "stack/1"])
  })

  test("promotes branch above its parent and restacks descendants", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await reorderStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).toBeNull()
    // stack/2 promoted above stack/1; stack/3 (was child of stack/2) moves under stack/1
    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/2", "stack/1", "stack/3"])
  })

  test("updates base branches on GitHub", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    await reorderStack(client, { repo: REPO, branch: "stack/2", cwd: CWD, _gitRunner: runner })

    // stack/2 base → main (was stack/1's base)
    expect(client.updateBaseBranch).toHaveBeenCalledWith("github:acme/app#2", "main")
    // stack/1 base → stack/2 (now below stack/2)
    expect(client.updateBaseBranch).toHaveBeenCalledWith("github:acme/app#1", "stack/2")
    // stack/3 base → stack/1 (moves from stack/2 to stack/1)
    expect(client.updateBaseBranch).toHaveBeenCalledWith("github:acme/app#3", "stack/1")
  })

  test("uses --onto form for all rebases", async () => {
    const client = makeClient([PR1, PR2])
    const runner = makeGitRunner(0)

    await reorderStack(client, { repo: REPO, branch: "stack/2", cwd: CWD, _gitRunner: runner })

    const rebaseCalls = (runner.run as ReturnType<typeof mock>).mock.calls.filter(
      ([args]: [string[]]) => args[0] === "rebase",
    )
    // All rebase calls should use --onto
    for (const [args] of rebaseCalls) {
      expect(args).toContain("--onto")
    }
  })

  test("reports conflict and returns skipped PRs", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(1)

    const result = await reorderStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).not.toBeNull()
    expect(result.conflict?.pr.headBranch).toBe("stack/2")
    expect(result.conflict?.files).toContain("src/auth.ts")
    expect(result.restacked).toHaveLength(0)
  })

  test("dry-run prints plan without calling git or API", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await reorderStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      dryRun: true,
      _gitRunner: runner,
    })

    expect(result.restacked).toHaveLength(0)
    expect(result.conflict).toBeNull()
    expect(runner.run).not.toHaveBeenCalled()
    expect(client.updateBaseBranch).not.toHaveBeenCalled()
  })

  test("throws when branch has no matching PR", async () => {
    const client = makeClient([PR1, PR2])

    await expect(
      reorderStack(client, {
        repo: REPO,
        branch: "nonexistent",
        cwd: CWD,
        _gitRunner: makeGitRunner(),
      }),
    ).rejects.toThrow('No open PR found with head branch "nonexistent"')
  })

  test("throws when branch is a root PR", async () => {
    const client = makeClient([PR1, PR2])

    await expect(
      reorderStack(client, {
        repo: REPO,
        branch: "stack/1",
        cwd: CWD,
        _gitRunner: makeGitRunner(),
      }),
    ).rejects.toThrow("root PR")
  })
})

// ─── splitStack tests ─────────────────────────────────────────────────────────

describe("splitStack", () => {
  test("detaches branch from parent, rebases it onto grandparent", async () => {
    const client = makeClient([PR1, PR2])
    const runner = makeGitRunner(0)

    const result = await splitStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).toBeNull()
    expect(result.splitPr.headBranch).toBe("stack/2")
    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/2"])
  })

  test("rebases entire subtree when splitting", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await splitStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).toBeNull()
    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/2", "stack/3"])
  })

  test("updates split PR base branch on GitHub", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    await splitStack(client, { repo: REPO, branch: "stack/2", cwd: CWD, _gitRunner: runner })

    // stack/2 base → main (was stack/1's base = "main")
    expect(client.updateBaseBranch).toHaveBeenCalledWith("github:acme/app#2", "main")
    // stack/3 base unchanged (still stack/2)
    const calls = (client.updateBaseBranch as ReturnType<typeof mock>).mock.calls
    expect(calls.some(([id]: [string]) => id === "github:acme/app#3")).toBe(false)
  })

  test("reports conflict when rebase fails", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(1)

    const result = await splitStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).not.toBeNull()
    expect(result.conflict?.pr.headBranch).toBe("stack/2")
    expect(result.skipped.map((p) => p.headBranch)).toEqual(["stack/3"])
  })

  test("dry-run prints plan without calling git or API", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await splitStack(client, {
      repo: REPO,
      branch: "stack/2",
      cwd: CWD,
      dryRun: true,
      _gitRunner: runner,
    })

    expect(result.restacked).toHaveLength(0)
    expect(result.conflict).toBeNull()
    expect(runner.run).not.toHaveBeenCalled()
    expect(client.updateBaseBranch).not.toHaveBeenCalled()
  })

  test("throws when branch has no matching PR", async () => {
    const client = makeClient([PR1])

    await expect(
      splitStack(client, {
        repo: REPO,
        branch: "nonexistent",
        cwd: CWD,
        _gitRunner: makeGitRunner(),
      }),
    ).rejects.toThrow('No open PR found with head branch "nonexistent"')
  })

  test("throws when branch is already a root PR", async () => {
    const client = makeClient([PR1, PR2])

    await expect(
      splitStack(client, { repo: REPO, branch: "stack/1", cwd: CWD, _gitRunner: makeGitRunner() }),
    ).rejects.toThrow("root PR")
  })
})
