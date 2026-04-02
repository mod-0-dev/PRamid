import type { Command } from "commander"
import {
  createStack,
  closePR,
  mergeSinglePR,
  mergeStack,
  refreshStackNav,
  getCurrentBranch,
  setBranchConfig,
} from "@pramid/core"
import { resolveRepo, resolveClient } from "../../utils.ts"

export function registerLifecycleCommands(cmd: Command): void {
  cmd
    .command("create <base> [branches...]")
    .description("Create or update a stack of PRs from a list of branches")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (base: string, branches: string[], opts: { repo?: string; remote: string }) => {
      if (branches.length === 0) {
        console.error("Error: Provide at least one branch to stack.")
        process.exit(1)
      }

      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)

      try {
        const { created, updated, unchanged } = await createStack(client, repo, { base, branches, cwd: process.cwd() })

        if (created.length > 0) {
          console.log(`Created ${created.length} PR(s):`)
          for (const pr of created) console.log(`  #${pr.number}  ${pr.title}  (${pr.headBranch} → ${pr.baseBranch})`)
        }
        if (updated.length > 0) {
          console.log(`Updated base for ${updated.length} PR(s):`)
          for (const pr of updated) console.log(`  #${pr.number}  ${pr.title}  (${pr.headBranch} → ${pr.baseBranch})`)
        }
        if (unchanged.length > 0) {
          console.log(`${unchanged.length} PR(s) already correct — no changes needed.`)
        }
        if (created.length === 0 && updated.length === 0) {
          console.log("Stack is already up to date.")
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("close <branch>")
    .description("Close a PR and re-target its children onto its base branch")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (branch: string, opts: { repo?: string; dryRun?: boolean; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)

      try {
        const { closedPr, retargeted } = await closePR(client, { repo, branch, dryRun: opts.dryRun })

        if (opts.dryRun) {
          console.log(`Would close #${closedPr.number}  ${closedPr.title}`)
          if (retargeted.length > 0) {
            console.log(`Would re-target ${retargeted.length} child PR(s) to base "${closedPr.baseBranch}":`)
            for (const pr of retargeted) console.log(`  #${pr.number}  ${pr.headBranch}`)
          }
          return
        }

        console.log(`Closed #${closedPr.number}  ${closedPr.title}`)
        if (retargeted.length > 0) {
          console.log(`Re-targeted ${retargeted.length} child PR(s) to base "${closedPr.baseBranch}":`)
          for (const pr of retargeted) console.log(`  #${pr.number}  ${pr.headBranch}`)
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("merge <branch>")
    .description("Merge a PR (--single) or the entire stack bottom-up")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .option("--strategy <merge|squash|rebase>", "Merge strategy", "merge")
    .option("--single", "Merge only this PR and re-target its children (default: merge whole stack)")
    .option("--dry-run", "Show what would happen without making any changes")
    .action(async (branch: string, opts: { repo?: string; remote: string; strategy: string; single?: boolean; dryRun?: boolean }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const strategy = (opts.strategy ?? "merge") as "merge" | "squash" | "rebase"

      try {
        if (opts.single) {
          const { mergedPr, retargeted, warnings } = await mergeSinglePR(client, {
            repo, branch, strategy, dryRun: opts.dryRun,
          })

          for (const w of warnings) console.warn(`  ⚠  ${w}`)

          if (opts.dryRun) {
            console.log(`Would merge #${mergedPr.number}  ${mergedPr.title}`)
            if (retargeted.length > 0) {
              console.log(`Would re-target ${retargeted.length} child PR(s) to "${mergedPr.baseBranch}":`)
              for (const pr of retargeted) console.log(`  #${pr.number}  ${pr.headBranch}`)
            }
            return
          }

          console.log(`Merged #${mergedPr.number}  ${mergedPr.title}`)
          if (retargeted.length > 0) {
            console.log(`Re-targeted ${retargeted.length} child PR(s) to "${mergedPr.baseBranch}":`)
            for (const pr of retargeted) {
              console.log(`  #${pr.number}  ${pr.headBranch}`)
              try { setBranchConfig(pr.headBranch, "pramidParent", pr.baseBranch, process.cwd()) } catch { /* ignore */ }
            }
          }
        } else {
          const { merged, retargeted, warnings, failedAt } = await mergeStack(client, {
            repo, branch, strategy, dryRun: opts.dryRun,
          })

          for (const w of warnings) console.warn(`  ⚠  ${w}`)

          if (opts.dryRun) {
            console.log(`Would merge ${merged.length} PR(s) in order:`)
            for (const pr of merged) console.log(`  #${pr.number}  ${pr.title}`)
            return
          }

          if (merged.length > 0) {
            console.log(`Merged ${merged.length} PR(s):`)
            for (const pr of merged) console.log(`  ✓ #${pr.number}  ${pr.title}`)
          }
          if (retargeted.length > 0) {
            console.log(`Re-targeted ${retargeted.length} PR(s)`)
            for (const { pr } of retargeted) {
              try { setBranchConfig(pr.headBranch, "pramidParent", pr.baseBranch, process.cwd()) } catch { /* ignore */ }
            }
          }
          if (failedAt) {
            console.error(`\nFailed at #${failedAt.pr.number}: ${failedAt.error}`)
            console.error(`To resume: pramid stack merge ${failedAt.pr.headBranch}`)
            process.exit(1)
          }
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("update-nav [branch]")
    .description("Refresh the stack navigation table in all PR descriptions for the current stack")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (branch: string | undefined, opts: { repo?: string; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const targetBranch = branch ?? getCurrentBranch(process.cwd())

      try {
        const prs = await client.listOpenPRs(repo)
        const pr = prs.find((p) => p.headBranch === targetBranch)
        if (!pr) {
          console.error(`Error: No open PR found for branch "${targetBranch}"`)
          process.exit(1)
        }
        await refreshStackNav(client, repo, prs, pr)
        console.log(`Updated stack navigation in PR descriptions.`)
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })
}
