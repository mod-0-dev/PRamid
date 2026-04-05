import { describe, expect, test, mock } from "bun:test"
import { restack } from "./restack-service.ts"
import type { PullRequest } from "../graph/graph.ts"
import type { VcsClient, RepoRef } from "../clients/vcs-client.ts"
import type { GitRunner } from "../git/git-ops.ts"

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

// Linear stack: main ← PR1 ← PR2 ← PR3
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
      if (args[0] === "rev-parse") {
        // getBranchSha: return a deterministic fake SHA based on the branch name
        return { stdout: `sha-${args[1]}\n`, stderr: "", exitCode: 0 }
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("restack", () => {
  test("restacks all descendants from startBranch", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await restack(client, {
      repo: REPO,
      startBranch: "stack/1",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).toBeNull()
    expect(result.skipped).toHaveLength(0)
    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/1", "stack/2", "stack/3"])
  })

  test("restacks only from startBranch downward, not siblings", async () => {
    const PR3b = makePr(4, "stack/3b", "stack/1")
    const client = makeClient([PR1, PR2, PR3b])
    const runner = makeGitRunner(0)

    const result = await restack(client, {
      repo: REPO,
      startBranch: "stack/2",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.restacked.map((p) => p.headBranch)).toEqual(["stack/2"])
    expect(result.restacked.find((p) => p.headBranch === "stack/3b")).toBeUndefined()
  })

  test("stops and reports conflict, skips remaining branches", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(1) // all rebases fail

    const result = await restack(client, {
      repo: REPO,
      startBranch: "stack/1",
      cwd: CWD,
      _gitRunner: runner,
    })

    expect(result.conflict).not.toBeNull()
    expect(result.conflict!.pr.headBranch).toBe("stack/1")
    expect(result.conflict!.files).toContain("src/auth.ts")
    expect(result.skipped).toHaveLength(2) // stack/2 and stack/3 skipped
    expect(result.restacked).toHaveLength(0)
  })

  test("throws when startBranch has no matching open PR", async () => {
    const client = makeClient([PR1, PR2])

    await expect(
      restack(client, { repo: REPO, startBranch: "nonexistent", cwd: CWD, _gitRunner: makeGitRunner() }),
    ).rejects.toThrow('No open PR found with head branch "nonexistent"')
  })

  test("dry-run does not call git or updateBaseBranch", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    const result = await restack(client, {
      repo: REPO,
      startBranch: "stack/1",
      cwd: CWD,
      dryRun: true,
      _gitRunner: runner,
    })

    expect(result.restacked).toHaveLength(3)
    expect(result.conflict).toBeNull()
    expect(runner.run).not.toHaveBeenCalled()
    expect(client.updateBaseBranch).not.toHaveBeenCalled()
  })

  test("does not call updateBaseBranch when base is already correct", async () => {
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    await restack(client, { repo: REPO, startBranch: "stack/1", cwd: CWD, _gitRunner: runner })

    expect(client.updateBaseBranch).not.toHaveBeenCalled()
  })

  test("uses rebase --onto for child branches to replay only their own commits", async () => {
    // Stack: main ← stack/1 ← stack/2 ← stack/3
    // When restacking, stack/2 and stack/3 should use `git rebase --onto <parent> <old-parent-tip>`
    // so that only their own commits are replayed (not the parent's already-merged commits).
    const client = makeClient([PR1, PR2, PR3])
    const runner = makeGitRunner(0)

    await restack(client, {
      repo: REPO,
      startBranch: "stack/1",
      cwd: CWD,
      _gitRunner: runner,
    })

    const calls: string[][] = (runner.run as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[0] as string[],
    )
    const rebaseOntoCalls = calls.filter((args) => args[0] === "rebase" && args[1] === "--onto")

    // stack/2 and stack/3 both have a parent in the ordered set → should use --onto
    expect(rebaseOntoCalls.length).toBe(2)

    // Each --onto call: git rebase --onto <onto> <upstream> (no branch arg — already checked out)
    // onto = parent.headBranch, upstream = saved old tip of parent (e.g. "sha-stack/1")
    const [call2, call3] = rebaseOntoCalls
    expect(call2).toEqual(["rebase", "--onto", "stack/1", "sha-stack/1"])
    expect(call3).toEqual(["rebase", "--onto", "stack/2", "sha-stack/2"])
  })
})
