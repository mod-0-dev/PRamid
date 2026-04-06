import { describe, expect, test } from "bun:test"
import type { PullRequest } from "../graph/graph.ts"
import { GitLabClient } from "./gitlab-client.ts"
import type { RepoRef } from "./vcs-client.ts"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: "acme", repo: "app" }
const PROJECT_PATH = "acme/app"

const MR_1 = {
  iid: 1,
  title: "feat: base layer",
  description: "base MR body",
  web_url: "https://gitlab.com/acme/app/-/merge_requests/1",
  draft: false,
  state: "opened" as const,
  source_branch: "stack/base",
  target_branch: "main",
  author: { username: "alice" },
  merge_status: "can_be_merged" as const,
  rebase_in_progress: false,
  merge_error: null,
}

const MR_2 = {
  iid: 2,
  title: "Draft: child layer",
  description: "",
  web_url: "https://gitlab.com/acme/app/-/merge_requests/2",
  draft: true,
  state: "opened" as const,
  source_branch: "stack/child",
  target_branch: "stack/base",
  author: { username: "bob" },
  merge_status: "checking" as const,
  rebase_in_progress: false,
  merge_error: null,
}

const PIPELINE_SUCCESS = [{ id: 10, status: "success" as const }]
const PIPELINE_FAILED = [{ id: 11, status: "failed" as const }]
const PIPELINE_RUNNING = [{ id: 12, status: "running" as const }]
const APPROVALS_APPROVED = { approved: true }
const APPROVALS_NONE = { approved: false }

// ─── fetch mock helpers ───────────────────────────────────────────────────────

type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response>

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function makeFetch(routes: FetchRoute[]): (url: string, init?: RequestInit) => Promise<Response> {
  let call = 0
  return async (url: string, init?: RequestInit) => {
    const route = routes[call] ?? routes.at(-1)
    call++
    return route(url, init)
  }
}

// ─── GitLabClient.listOpenPRs ─────────────────────────────────────────────────

describe("GitLabClient.listOpenPRs", () => {
  test("maps MR objects to PullRequest — single page", async () => {
    // Page 1 returns both MRs, no next page
    // Then 2 MRs × (1 pipeline call + 1 approvals call) = 4 more calls
    const fetch = makeFetch([
      () => jsonResp([MR_1, MR_2], 200, { "x-next-page": "" }),
      () => jsonResp(PIPELINE_SUCCESS), // MR_1 pipelines
      () => jsonResp(APPROVALS_APPROVED), // MR_1 approvals
      () => jsonResp([]), // MR_2 pipelines (empty)
      () => jsonResp(APPROVALS_NONE), // MR_2 approvals
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const prs = await client.listOpenPRs(REPO)

    expect(prs).toHaveLength(2)

    const pr1 = prs[0] as PullRequest
    expect(pr1.id).toBe(`gitlab:${PROJECT_PATH}#1`)
    expect(pr1.platform).toBe("gitlab")
    expect(pr1.number).toBe(1)
    expect(pr1.title).toBe("feat: base layer")
    expect(pr1.body).toBe("base MR body")
    expect(pr1.headBranch).toBe("stack/base")
    expect(pr1.baseBranch).toBe("main")
    expect(pr1.author).toBe("alice")
    expect(pr1.ciStatus).toBe("success")
    expect(pr1.reviewStatus).toBe("approved")
    expect(pr1.mergeable).toBe(true)
    expect(pr1.draft).toBe(false)
    expect(pr1.merged).toBe(false)

    const pr2 = prs[1] as PullRequest
    expect(pr2.ciStatus).toBe("none")
    expect(pr2.reviewStatus).toBe("none")
    expect(pr2.mergeable).toBeNull()
    expect(pr2.draft).toBe(true)
  })

  test("paginates across multiple pages", async () => {
    const fetch = makeFetch([
      // Page 1 returns MR_1, next page = 2
      () => jsonResp([MR_1], 200, { "x-next-page": "2" }),
      () => jsonResp([]), // MR_1 pipelines
      () => jsonResp(APPROVALS_NONE), // MR_1 approvals
      // Page 2 returns MR_2, no next page
      () => jsonResp([MR_2], 200, { "x-next-page": "" }),
      () => jsonResp([]), // MR_2 pipelines
      () => jsonResp(APPROVALS_NONE), // MR_2 approvals
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const prs = await client.listOpenPRs(REPO)
    expect(prs).toHaveLength(2)
    expect(prs[0]?.number).toBe(1)
    expect(prs[1]?.number).toBe(2)
  })

  test("maps pipeline statuses correctly", async () => {
    const fetch = makeFetch([
      () => jsonResp([MR_1], 200, { "x-next-page": "" }),
      () => jsonResp(PIPELINE_FAILED),
      () => jsonResp(APPROVALS_NONE),
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const prs = await client.listOpenPRs(REPO)
    expect(prs[0]?.ciStatus).toBe("failure")
  })

  test("maps running pipeline to pending", async () => {
    const fetch = makeFetch([
      () => jsonResp([MR_1], 200, { "x-next-page": "" }),
      () => jsonResp(PIPELINE_RUNNING),
      () => jsonResp(APPROVALS_NONE),
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const prs = await client.listOpenPRs(REPO)
    expect(prs[0]?.ciStatus).toBe("pending")
  })
})

// ─── GitLabClient.getPR ───────────────────────────────────────────────────────

describe("GitLabClient.getPR", () => {
  test("fetches a single MR and returns PullRequest", async () => {
    const fetch = makeFetch([
      () => jsonResp(MR_1),
      () => jsonResp(PIPELINE_SUCCESS),
      () => jsonResp(APPROVALS_APPROVED),
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const pr = await client.getPR(`gitlab:${PROJECT_PATH}#1`)
    expect(pr.id).toBe(`gitlab:${PROJECT_PATH}#1`)
    expect(pr.ciStatus).toBe("success")
    expect(pr.reviewStatus).toBe("approved")
  })

  test("throws on invalid prId format", async () => {
    const client = new GitLabClient("tok", { _fetch: makeFetch([]) })
    await expect(client.getPR("github:acme/app#1")).rejects.toThrow("Invalid GitLab PrId")
  })
})

// ─── GitLabClient.createPR ────────────────────────────────────────────────────

describe("GitLabClient.createPR", () => {
  test("POSTs to correct endpoint and returns PullRequest", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp({ ...MR_1, iid: 5, source_branch: "feature", target_branch: "main" })
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const pr = await client.createPR(REPO, { head: "feature", base: "main", title: "Add feature" })
    expect(pr.number).toBe(5)
    expect(pr.headBranch).toBe("feature")
    expect((capturedBody as Record<string, unknown>).source_branch).toBe("feature")
    expect((capturedBody as Record<string, unknown>).target_branch).toBe("main")
  })

  test("prefixes title with Draft: for draft PRs", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp({ ...MR_1, iid: 6, draft: true, title: "Draft: My MR" })
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.createPR(REPO, { head: "feat", base: "main", title: "My MR", draft: true })
    expect((capturedBody as Record<string, unknown>).title).toBe("Draft: My MR")
  })
})

// ─── GitLabClient.updateBaseBranch ────────────────────────────────────────────

describe("GitLabClient.updateBaseBranch", () => {
  test("PUTs target_branch", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp(MR_1)
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.updateBaseBranch(`gitlab:${PROJECT_PATH}#1`, "develop")
    expect((capturedBody as Record<string, unknown>).target_branch).toBe("develop")
  })
})

// ─── GitLabClient.mergePR ─────────────────────────────────────────────────────

describe("GitLabClient.mergePR", () => {
  test("merge strategy → squash: false", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp({})
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.mergePR(`gitlab:${PROJECT_PATH}#1`, "merge")
    expect((capturedBody as Record<string, unknown>).squash).toBe(false)
  })

  test("squash strategy → squash: true", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp({})
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.mergePR(`gitlab:${PROJECT_PATH}#1`, "squash")
    expect((capturedBody as Record<string, unknown>).squash).toBe(true)
  })
})

// ─── GitLabClient.closePR ─────────────────────────────────────────────────────

describe("GitLabClient.closePR", () => {
  test("PUTs state_event: close", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp(MR_1)
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.closePR(`gitlab:${PROJECT_PATH}#1`)
    expect((capturedBody as Record<string, unknown>).state_event).toBe("close")
  })
})

// ─── GitLabClient.updatePRBody ────────────────────────────────────────────────

describe("GitLabClient.updatePRBody", () => {
  test("PUTs description field", async () => {
    let capturedBody: unknown
    const fetch = makeFetch([
      (_, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResp(MR_1)
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    await client.updatePRBody(`gitlab:${PROJECT_PATH}#1`, "new body")
    expect((capturedBody as Record<string, unknown>).description).toBe("new body")
  })
})

// ─── GitLabClient.rebaseBranch ────────────────────────────────────────────────

describe("GitLabClient.rebaseBranch", () => {
  test("returns success when rebase completes on first poll", async () => {
    const fetch = makeFetch([
      () => jsonResp({ rebase_in_progress: true }), // POST rebase trigger
      () => jsonResp({ ...MR_1, rebase_in_progress: false, merge_error: null }), // poll 1
    ])
    // Inject a fast sleep by patching global setTimeout — easier: just use real client
    const client = new GitLabClient("tok", { _fetch: fetch, maxRetries: 0 })
    // We can't easily speed up sleep(2000) in a unit test, so we'll verify the
    // logic flow via a custom _fetch that returns "done" immediately on the poll.
    // The test above is sufficient to check the happy path shape.
    // To avoid actual 2s wait, skip the rebase poll timing here — integration test territory.
    // Instead, test the conflict detection path which uses the same loop.
    const result = await client.rebaseBranch(`gitlab:${PROJECT_PATH}#1`)
    // rebase_in_progress: true on trigger, then false on poll → success
    expect(result.success).toBe(true)
  }, 10_000)

  test("returns failure when merge_error is set after rebase", async () => {
    const fetch = makeFetch([
      () => jsonResp({ rebase_in_progress: true }), // POST trigger
      () => jsonResp({ ...MR_1, rebase_in_progress: false, merge_error: "Conflict in file.ts" }),
    ])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const result = await client.rebaseBranch(`gitlab:${PROJECT_PATH}#1`)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("Conflict")
  }, 10_000)

  test("returns failure when trigger endpoint errors", async () => {
    const fetch = makeFetch([() => new Response("Forbidden", { status: 403 })])
    const client = new GitLabClient("tok", { _fetch: fetch })
    const result = await client.rebaseBranch(`gitlab:${PROJECT_PATH}#1`)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("403")
  })
})

// ─── GitLabClient.getCIStatus ─────────────────────────────────────────────────

describe("GitLabClient.getCIStatus", () => {
  test("returns success from pipelines", async () => {
    const fetch = makeFetch([() => jsonResp(PIPELINE_SUCCESS)])
    const client = new GitLabClient("tok", { _fetch: fetch })
    expect(await client.getCIStatus(`gitlab:${PROJECT_PATH}#1`)).toBe("success")
  })

  test("returns none when no pipelines", async () => {
    const fetch = makeFetch([() => jsonResp([])])
    const client = new GitLabClient("tok", { _fetch: fetch })
    expect(await client.getCIStatus(`gitlab:${PROJECT_PATH}#1`)).toBe("none")
  })
})

// ─── GitLabClient.getReviewStatus ─────────────────────────────────────────────

describe("GitLabClient.getReviewStatus", () => {
  test("returns approved when approvals.approved is true", async () => {
    const fetch = makeFetch([() => jsonResp(APPROVALS_APPROVED)])
    const client = new GitLabClient("tok", { _fetch: fetch })
    expect(await client.getReviewStatus(`gitlab:${PROJECT_PATH}#1`)).toBe("approved")
  })

  test("returns none when not approved", async () => {
    const fetch = makeFetch([() => jsonResp(APPROVALS_NONE)])
    const client = new GitLabClient("tok", { _fetch: fetch })
    expect(await client.getReviewStatus(`gitlab:${PROJECT_PATH}#1`)).toBe("none")
  })
})

// ─── Rate-limit retry ─────────────────────────────────────────────────────────

describe("GitLabClient rate-limit retry", () => {
  test("retries once on 429 and succeeds", async () => {
    let calls = 0
    const fetch = makeFetch([
      () => {
        calls++
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      },
      () => {
        calls++
        return jsonResp(PIPELINE_SUCCESS)
      },
    ])
    const client = new GitLabClient("tok", { _fetch: fetch, maxRetries: 1 })
    const status = await client.getCIStatus(`gitlab:${PROJECT_PATH}#1`)
    expect(status).toBe("success")
    expect(calls).toBe(2)
  })
})

// ─── forcePush throws ─────────────────────────────────────────────────────────

describe("GitLabClient.forcePush", () => {
  test("throws not-implemented error", async () => {
    const client = new GitLabClient("tok", { _fetch: makeFetch([]) })
    await expect(client.forcePush("branch", "sha")).rejects.toThrow(
      "forcePush is a local git operation",
    )
  })
})
