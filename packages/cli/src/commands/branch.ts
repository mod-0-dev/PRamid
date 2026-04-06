import {
  createBranch,
  getCurrentBranch,
  getParentBranch,
  pushBranch,
  refreshStackNav,
  setParent,
} from "@pramid/core"
import { Command } from "commander"
import { resolveClient, resolveRepo } from "../utils.ts"

export function buildBranchCommand(): Command {
  const cmd = new Command("branch").description("Branch management commands")

  cmd
    .command("new <name>")
    .description(
      "Create a new branch stacked on the current one and record the parent relationship",
    )
    .action((name: string) => {
      const cwd = process.cwd()
      const parent = getCurrentBranch(cwd)

      try {
        createBranch(name, cwd)
        setParent(name, parent, cwd)
        console.log(`Created branch ${name} (stacked on ${parent})`)
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  return cmd
}

// ─── pramid push ──────────────────────────────────────────────────────────────

export function registerPushCommand(program: Command): void {
  program
    .command("push")
    .description("Push the current branch and create or update its PR")
    .option("--base <branch>", "Base branch for the PR (overrides auto-detection)")
    .option("--draft", "Create the PR as a draft")
    .option("--title <title>", "Title for the PR (default: derived from branch name)")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name (default: origin)", "origin")
    .action(
      async (opts: {
        base?: string
        draft?: boolean
        title?: string
        repo?: string
        remote: string
      }) => {
        const cwd = process.cwd()
        const repo = resolveRepo(opts.repo, opts.remote)
        const client = resolveClient(opts.remote)
        const branch = getCurrentBranch(cwd)

        // 1. Push the branch
        try {
          pushBranch(branch, opts.remote, cwd)
        } catch (err) {
          console.error("Error pushing branch:", (err as Error).message)
          process.exit(1)
        }

        // 2. Resolve base branch
        let base: string | undefined = opts.base

        if (!base) {
          try {
            const allPrs = await client.listOpenPRs(repo)

            // Does this branch already have an open PR? Use its current base (idempotent).
            const existingPr = allPrs.find((pr) => pr.headBranch === branch)
            if (existingPr) {
              base = existingPr.baseBranch
            }

            if (!base) {
              base = getParentBranch(branch, cwd) ?? undefined
            }

            // Validate that the resolved base has an open PR or is a known trunk
            if (base) {
              const baseHasPr = allPrs.some((pr) => pr.headBranch === base)
              const isTrunk = ["main", "master", "develop"].includes(base)
              if (!baseHasPr && !isTrunk) {
                console.warn(
                  `Warning: base branch "${base}" has no open PR and is not a known trunk branch.`,
                )
              }
            }
          } catch (err) {
            console.error("Error fetching PRs:", (err as Error).message)
            process.exit(1)
          }
        }

        if (!base) {
          console.error(`Error: Could not determine the base branch for "${branch}".`)
          console.error(
            "Use --base <branch> to specify it explicitly, or create this branch with `pramid branch new`.",
          )
          process.exit(1)
        }

        // 3. Create or update the PR
        try {
          const allPrs = await client.listOpenPRs(repo)
          const existingPr = allPrs.find((pr) => pr.headBranch === branch)

          let pr = existingPr ?? null

          if (pr) {
            if (pr.baseBranch !== base) {
              await client.updateBaseBranch(pr.id, base)
              pr = { ...pr, baseBranch: base }
              console.log(`Updated PR #${pr.number} base → ${base}`)
            } else {
              console.log(`PR #${pr.number} already up to date`)
            }
          } else {
            const title = opts.title ?? branch.replace(/\//g, ": ").replace(/-/g, " ")
            pr = await client.createPR(repo, { head: branch, base, title, draft: opts.draft })
            console.log(`Created PR #${pr.number} ${pr.title}  (${branch} → ${base})`)
          }

          // Persist parent for future restack --onto awareness
          setParent(branch, base, cwd)

          // 4. Refresh nav table in all PR descriptions for this stack
          const freshPrs = await client.listOpenPRs(repo)
          const thisPr = freshPrs.find((p) => p.headBranch === branch)
          if (thisPr) await refreshStackNav(client, repo, freshPrs, thisPr)
        } catch (err) {
          console.error("Error:", (err as Error).message)
          process.exit(1)
        }
      },
    )
}
