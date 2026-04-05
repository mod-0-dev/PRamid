import { describe, expect, test, mock, beforeEach } from "bun:test"
import { GitHubClient } from "./github-client.ts"
import type { RepoRef } from "./vcs-client.ts"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: "acme", repo: "app" }

const PR_NODE_1 = {
  number: 1,
  title: "feat: base layer",
  body: "base PR body",
  url: "https://github.com/acme/app/pull/1",
  isDraft: false,
  state: "OPEN" as const,
  headRefName: "stack/base",
  baseRefName: "main",
  author: { login: "alice" },
  reviewDecision: "APPROVED" as const,
  statusCheckRollup: { state: "SUCCESS" as const },
  mergeable: "MERGEABLE" as const,
}

const PR_NODE_2 = {
  number: 2,
  title: "feat: child layer",
  body: "",
  url: "https://github.com/acme/app/pull/2",
  isDraft: true,
  state: "OPEN" as const,
  headRefName: "stack/child",
  baseRefName: "stack/base",
  author: { login: "bob" },
  reviewDecision: null,
  statusCheckRollup: { state: "PENDING" as const },
  mergeable: "CONFLICTING" as const,
}

function makeGqlMock(pages: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }[]) {
  let call = 0
  return mock((_query: string, _vars?: Record<string, unknown>) => {
    const page = pages[call++] ?? pages[pages.length - 1]!
    const query = _query.trim()
    if (query.startsWith("query ListOpenPRs")) {
      return Promise.resolve({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
            nodes: page.nodes,
          },
        },
      })
    }
    if (query.startsWith("query GetPR")) {
      return Promise.resolve({
        repository: { pullRequest: page.nodes[0] ?? null },
      })
    }
    throw new Error(`Unexpected query: ${query.slice(0, 60)}`)
  })
}

function makeOctokitMock(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      pulls: {
        update: mock(() => Promise.resolve({ data: {} })),
        merge: mock(() => Promise.resolve({ data: { merged: true } })),
        ...overrides,
      },
    },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GitHubClient.listOpenPRs", () => {
  test("maps GraphQL nodes to PullRequest objects", async () => {
    const gql = makeGqlMock([{ nodes: [PR_NODE_1, PR_NODE_2], hasNextPage: false, endCursor: null }])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const prs = await client.listOpenPRs(REPO)

    expect(prs).toHaveLength(2)

    const pr1 = prs[0]!
    expect(pr1.id).toBe("github:acme/app#1")
    expect(pr1.platform).toBe("github")
    expect(pr1.number).toBe(1)
    expect(pr1.title).toBe("feat: base layer")
    expect(pr1.headBranch).toBe("stack/base")
    expect(pr1.baseBranch).toBe("main")
    expect(pr1.ciStatus).toBe("success")
    expect(pr1.reviewStatus).toBe("approved")
    expect(pr1.mergeable).toBe(true)
    expect(pr1.draft).toBe(false)
    expect(pr1.merged).toBe(false)

    const pr2 = prs[1]!
    expect(pr2.id).toBe("github:acme/app#2")
    expect(pr2.ciStatus).toBe("pending")
    expect(pr2.reviewStatus).toBe("none")
    expect(pr2.mergeable).toBe(false)
    expect(pr2.draft).toBe(true)
  })

  test("follows pagination until hasNextPage is false", async () => {
    const gql = makeGqlMock([
      { nodes: [PR_NODE_1], hasNextPage: true, endCursor: "cursor1" },
      { nodes: [PR_NODE_2], hasNextPage: false, endCursor: null },
    ])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const prs = await client.listOpenPRs(REPO)

    expect(prs).toHaveLength(2)
    expect(gql).toHaveBeenCalledTimes(2)
    // Second call should pass cursor
    expect((gql.mock.calls[1] as [string, Record<string, unknown>])[1]?.["cursor"]).toBe("cursor1")
  })

  test("maps CI failure states", async () => {
    const node = { ...PR_NODE_1, statusCheckRollup: { state: "FAILURE" as const } }
    const gql = makeGqlMock([{ nodes: [node], hasNextPage: false, endCursor: null }])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const [pr] = await client.listOpenPRs(REPO)
    expect(pr!.ciStatus).toBe("failure")
  })

  test("maps null statusCheckRollup to 'none'", async () => {
    const node = { ...PR_NODE_1, statusCheckRollup: null }
    const gql = makeGqlMock([{ nodes: [node], hasNextPage: false, endCursor: null }])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const [pr] = await client.listOpenPRs(REPO)
    expect(pr!.ciStatus).toBe("none")
  })

  test("maps CHANGES_REQUESTED review decision", async () => {
    const node = { ...PR_NODE_1, reviewDecision: "CHANGES_REQUESTED" as const }
    const gql = makeGqlMock([{ nodes: [node], hasNextPage: false, endCursor: null }])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const [pr] = await client.listOpenPRs(REPO)
    expect(pr!.reviewStatus).toBe("changes_requested")
  })
})

describe("GitHubClient.getPR", () => {
  test("returns the PR for a valid prId", async () => {
    const gql = makeGqlMock([{ nodes: [PR_NODE_1], hasNextPage: false, endCursor: null }])
    const client = new GitHubClient("tok", { _graphql: gql, _octokit: makeOctokitMock() as never })

    const pr = await client.getPR("github:acme/app#1")

    expect(pr.id).toBe("github:acme/app#1")
    expect(pr.title).toBe("feat: base layer")
  })

  test("throws when PR not found", async () => {
    const gql = makeGqlMock([{ nodes: [], hasNextPage: false, endCursor: null }])
    // Override to return null pullRequest
    const nullGql = mock((_query: string, _vars?: Record<string, unknown>) =>
      Promise.resolve({ repository: { pullRequest: null } }),
    )
    const client = new GitHubClient("tok", { _graphql: nullGql, _octokit: makeOctokitMock() as never })

    await expect(client.getPR("github:acme/app#999")).rejects.toThrow("PR not found")
  })

  test("throws on invalid prId format", async () => {
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: makeOctokitMock() as never,
    })
    await expect(client.getPR("not-a-valid-id")).rejects.toThrow("Invalid GitHub PrId")
  })
})

describe("GitHubClient.updateBaseBranch", () => {
  test("calls REST pulls.update with correct params", async () => {
    const octokit = makeOctokitMock()
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: octokit as never,
    })

    await client.updateBaseBranch("github:acme/app#1", "new-base")

    expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1)
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      pull_number: 1,
      base: "new-base",
    })
  })
})

describe("GitHubClient.mergePR", () => {
  test("calls REST pulls.merge with squash strategy", async () => {
    const octokit = makeOctokitMock()
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: octokit as never,
    })

    await client.mergePR("github:acme/app#1", "squash")

    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      pull_number: 1,
      merge_method: "squash",
    })
  })

  test("calls REST pulls.merge with merge strategy", async () => {
    const octokit = makeOctokitMock()
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: octokit as never,
    })

    await client.mergePR("github:acme/app#2", "merge")

    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      pull_number: 2,
      merge_method: "merge",
    })
  })
})

describe("GitHubClient rate-limit retry", () => {
  test("retries once on 429 and succeeds", async () => {
    let calls = 0
    const gql = mock((_query: string, _vars?: Record<string, unknown>) => {
      calls++
      if (calls === 1) {
        const err = Object.assign(new Error("rate limited"), {
          status: 429,
          headers: { "retry-after": "0" },
        })
        return Promise.reject(err)
      }
      return Promise.resolve({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [PR_NODE_1],
          },
        },
      })
    })

    const client = new GitHubClient("tok", {
      _graphql: gql,
      _octokit: makeOctokitMock() as never,
      maxRetries: 2,
    })

    const prs = await client.listOpenPRs(REPO)
    expect(prs).toHaveLength(1)
    expect(calls).toBe(2)
  })

  test("retries on 403 primary rate limit and succeeds", async () => {
    let calls = 0
    const gql = mock((_query: string, _vars?: Record<string, unknown>) => {
      calls++
      if (calls === 1) {
        const resetEpoch = Math.floor(Date.now() / 1000) // already past — 0 wait
        const err = Object.assign(new Error("API rate limit exceeded"), {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetEpoch),
          },
        })
        return Promise.reject(err)
      }
      return Promise.resolve({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [PR_NODE_1],
          },
        },
      })
    })

    const client = new GitHubClient("tok", {
      _graphql: gql,
      _octokit: makeOctokitMock() as never,
      maxRetries: 2,
    })

    const prs = await client.listOpenPRs(REPO)
    expect(prs).toHaveLength(1)
    expect(calls).toBe(2)
  })

  test("propagates error after exhausting retries", async () => {
    const gql = mock((_query: string) => {
      const err = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "0" },
      })
      return Promise.reject(err)
    })

    const client = new GitHubClient("tok", {
      _graphql: gql,
      _octokit: makeOctokitMock() as never,
      maxRetries: 1,
    })

    await expect(client.listOpenPRs(REPO)).rejects.toThrow("rate limited")
    expect(gql).toHaveBeenCalledTimes(2) // 1 initial + 1 retry
  })
})

describe("GitHubClient unimplemented git operations", () => {
  test("forcePush throws NotImplemented", async () => {
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: makeOctokitMock() as never,
    })
    await expect(client.forcePush("stack/base", "abc123")).rejects.toThrow("git operation")
  })

  test("rebaseBranch throws NotImplemented", async () => {
    const client = new GitHubClient("tok", {
      _graphql: makeGqlMock([]) as never,
      _octokit: makeOctokitMock() as never,
    })
    await expect(client.rebaseBranch("github:acme/app#1")).rejects.toThrow("git operation")
  })
})
