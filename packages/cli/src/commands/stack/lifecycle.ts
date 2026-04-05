import type { Command } from "commander"
import {
  createStack,
  closePR,
  mergeSinglePR,
  mergeStack,
  refreshStackNav,
  getCurrentBranch,
  setParent,
  getAllParents,
  pushBranch,
  branchExists,
  remoteBranchExists,
  pruneStaleParents,
  pruneStaleParentsRemote,
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
              try { setParent(pr.headBranch, pr.baseBranch, process.cwd()) } catch { /* ignore */ }
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
              try { setParent(pr.headBranch, pr.baseBranch, process.cwd()) } catch { /* ignore */ }
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

  cmd
    .command("submit [branch]")
    .description("Push all branches in the stack and create or update their PRs")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .option("--draft", "Create new PRs as drafts")
    .option("--dry-run", "Print what would be done without pushing or modifying PRs")
    .action(async (
      branch: string | undefined,
      opts: { repo?: string; remote: string; draft?: boolean; dryRun?: boolean },
    ) => {
      const cwd = process.cwd()
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const startBranch = branch ?? getCurrentBranch(cwd)

      // ── Discover the stack via recorded parent relationships ──────────────────
      const allParents = getAllParents(cwd)
      const TRUNK = new Set(["main", "master", "develop", "dev"])

      // Walk up from startBranch to find the root of the stack
      let root = startBranch
      const walked = new Set<string>()
      while (true) {
        const parent = allParents[root]
        if (!parent || TRUNK.has(parent) || TRUNK.has(root) || walked.has(root)) break
        walked.add(root)
        root = parent
      }

      // Build a child map so we can walk downward
      const childMap = new Map<string, string[]>()
      for (const [b, p] of Object.entries(allParents)) {
        if (!childMap.has(p)) childMap.set(p, [])
        childMap.get(p)!.push(b)
      }

      // BFS from root — collects branches in root-to-tip order, skipping ghost entries
      const stackBranches: string[] = []
      const bfsQueue = [root]
      const seen = new Set<string>()
      while (bfsQueue.length > 0) {
        const b = bfsQueue.shift()!
        if (seen.has(b)) continue
        seen.add(b)
        if (!branchExists(b, cwd)) {
          console.warn(`Warning: "${b}" is in stack config but does not exist locally — skipping.`)
          continue
        }
        stackBranches.push(b)
        for (const child of childMap.get(b) ?? []) {
          bfsQueue.push(child)
        }
      }

      const base = allParents[root] ?? "main"

      if (opts.dryRun) {
        console.log(`Would submit ${stackBranches.length} branch(es) onto "${base}":`)
        let prev = base
        for (const b of stackBranches) {
          console.log(`  push ${b}  →  PR: ${b} → ${prev}`)
          prev = b
        }
        return
      }

      // ── Push each branch ──────────────────────────────────────────────────────
      for (const b of stackBranches) {
        try {
          pushBranch(b, opts.remote, cwd)
          console.log(`Pushed ${b}`)
        } catch (err) {
          console.error(`Error pushing "${b}":`, (err as Error).message)
          process.exit(1)
        }
      }

      // ── Create / update PRs and refresh nav ──────────────────────────────────
      try {
        const { created, updated, unchanged } = await createStack(client, repo, {
          base,
          branches: stackBranches,
          draft: opts.draft,
          cwd,
        })

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
    .command("gc")
    .description("Remove stale stack config entries for branches that no longer exist locally or on the remote")
    .option("--remote", "Also prune entries with no open PR and no remote branch (requires API access)")
    .option("--repo <owner/repo>", "GitHub/GitLab repository (default: auto-detect from git remote)")
    .option("--remote-name <name>", "Git remote name used for auto-detection", "origin")
    .option("--dry-run", "Print what would be removed without making any changes")
    .action(async (opts: { remote?: boolean; repo?: string; remoteName: string; dryRun?: boolean }) => {
      const cwd = process.cwd()

      if (opts.remote) {
        // ── Remote-aware pruning ───────────────────────────────────────────────
        const repo = resolveRepo(opts.repo, opts.remoteName)
        const client = resolveClient(opts.remoteName)

        console.log("Fetching open PRs...")
        let openPrBranches: Set<string>
        try {
          const prs = await client.listOpenPRs(repo)
          openPrBranches = new Set(prs.map((pr) => pr.headBranch))
        } catch (err) {
          console.error("Error fetching open PRs:", (err as Error).message)
          process.exit(1)
          return
        }

        const allParents = getAllParents(cwd)
        const entries = Object.keys(allParents)
        console.log(`Checking ${entries.length} entr${entries.length === 1 ? "y" : "ies"} against remote...`)

        const stale: string[] = []
        for (const b of entries) {
          if (openPrBranches.has(b)) continue
          process.stdout.write(`  ${b}... `)
          if (remoteBranchExists(b, opts.remoteName, cwd)) {
            process.stdout.write("active\n")
          } else {
            process.stdout.write("stale\n")
            stale.push(b)
          }
        }

        if (opts.dryRun) {
          if (stale.length === 0) {
            console.log("Stack config is clean — no stale entries found.")
            return
          }
          console.log(`\nWould remove ${stale.length} stale entry(s):`)
          for (const b of stale) console.log(`  ${b}`)
          return
        }

        try {
          const { removed } = pruneStaleParentsRemote(cwd, opts.remoteName, openPrBranches)
          if (removed.length === 0) {
            console.log("\nStack config is clean — no stale entries found.")
            return
          }
          console.log(`\nRemoved ${removed.length} stale entry(s):`)
          for (const b of removed) console.log(`  ${b}`)
          console.log("Stack config is clean.")
        } catch (err) {
          console.error("Error:", (err as Error).message)
          process.exit(1)
        }
      } else {
        // ── Local-only pruning (original behaviour) ────────────────────────────
        if (opts.dryRun) {
          const allParents = getAllParents(cwd)
          const stale = Object.keys(allParents).filter((b) => !branchExists(b, cwd))
          if (stale.length === 0) {
            console.log("Stack config is clean — no stale entries found.")
            return
          }
          console.log(`Would remove ${stale.length} stale entry(s):`)
          for (const b of stale) console.log(`  ${b}  (branch not found locally)`)
          return
        }

        try {
          const { removed } = pruneStaleParents(cwd)
          if (removed.length === 0) {
            console.log("Stack config is clean — no stale entries found.")
            return
          }
          console.log(`Removed ${removed.length} stale entry(s):`)
          for (const b of removed) console.log(`  ${b}  (branch not found locally)`)
          console.log("Stack config is clean.")
        } catch (err) {
          console.error("Error:", (err as Error).message)
          process.exit(1)
        }
      }
    })
}
