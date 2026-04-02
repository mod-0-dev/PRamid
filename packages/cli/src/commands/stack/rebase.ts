import type { Command } from "commander"
import {
  restack,
  reorderStack,
  splitStack,
  syncStack,
  getCurrentBranch,
  forcePush,
  rebaseContinue,
  rebaseAbort,
  loadConflictState,
  clearConflictState,
} from "@pramid/core"
import { resolveRepo, resolveClient, printRebaseFailure } from "../../utils.ts"

// ─── Shared continue/abort helpers ────────────────────────────────────────────

async function handleContinue(remote: string, expectedCommand: "restack" | "sync"): Promise<void> {
  const cwd = process.cwd()
  const state = loadConflictState(cwd)

  if (!state) {
    console.error("No in-progress restack/sync to continue. No conflict state found.")
    process.exit(1)
  }
  if (state.command !== expectedCommand) {
    console.error(
      `Expected an in-progress "${expectedCommand}" but found "${state.command}". ` +
        `Run: pramid stack ${state.command} --continue`,
    )
    process.exit(1)
  }

  const client = resolveClient(state.remote)

  // Finish the paused rebase
  const continueResult = rebaseContinue(cwd)
  if (!continueResult.success) {
    if (continueResult.conflictedFiles && continueResult.conflictedFiles.length > 0) {
      console.log(`\nConflict still present in ${state.conflictBranch}:`)
      for (const f of continueResult.conflictedFiles) console.log(`  ${f}`)
      console.log("\nResolve remaining conflicts, then:")
      console.log(`  git add . && pramid stack ${state.command} --continue`)
    } else {
      console.error(`\nFailed to continue rebase on ${state.conflictBranch}:`)
      if (continueResult.errorMessage) {
        for (const line of continueResult.errorMessage.split("\n")) console.error(`  ${line}`)
      }
    }
    process.exit(1)
  }

  // Force-push the resolved branch
  forcePush(state.conflictBranch, cwd, state.remote)

  // Update PR base branch if the parent changed
  if (state.conflictPr.parentHeadBranch && state.conflictPr.baseBranch !== state.conflictPr.parentHeadBranch) {
    await client.updateBaseBranch(state.conflictPr.id, state.conflictPr.parentHeadBranch)
  }

  console.log(`  ✓ #${state.conflictPr.number}  ${state.conflictBranch}`)

  // Restack any remaining branches
  if (state.remainingBranches.length > 0) {
    const { restacked, conflict, skipped } = await restack(client, {
      repo: state.repo,
      startBranch: state.remainingBranches[0]!,
      remote: state.remote,
    })

    if (restacked.length > 0) {
      for (const pr of restacked) console.log(`  ✓ #${pr.number}  ${pr.headBranch}`)
    }

    if (conflict) {
      // New conflict — restack service has already written updated state
      printRebaseFailure(conflict, skipped, state.remote, state.command)
      process.exit(1)
    }
  }

  clearConflictState(cwd)
}

function handleAbort(expectedCommand: "restack" | "sync"): void {
  const cwd = process.cwd()
  const state = loadConflictState(cwd)

  if (!state) {
    console.error("No in-progress restack/sync to abort.")
    process.exit(1)
  }
  if (state.command !== expectedCommand) {
    console.error(
      `Expected an in-progress "${expectedCommand}" but found "${state.command}". ` +
        `Run: pramid stack ${state.command} --abort`,
    )
    process.exit(1)
  }

  rebaseAbort(cwd)
  clearConflictState(cwd)
  console.log(`Aborted ${state.command}. Rebase on ${state.conflictBranch} has been rolled back.`)
}

// ─── Command registrations ────────────────────────────────────────────────────

export function registerRebaseCommands(cmd: Command): void {
  cmd
    .command("restack [branch]")
    .description("Rebase a branch and all PRs above it onto their parents")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--remote <name>", "Git remote name", "origin")
    .option("--continue", "Resume after resolving a conflict")
    .option("--abort", "Abort an in-progress restack")
    .action(
      async (
        branch: string | undefined,
        opts: { repo?: string; dryRun?: boolean; remote: string; continue?: boolean; abort?: boolean },
      ) => {
        if (opts.abort) {
          handleAbort("restack")
          return
        }

        if (opts.continue) {
          await handleContinue(opts.remote, "restack")
          return
        }

        if (!branch) {
          console.error("Error: Branch name required. Usage: pramid stack restack <branch>")
          process.exit(1)
        }

        const repo = resolveRepo(opts.repo, opts.remote)
        const client = resolveClient(opts.remote)

        try {
          const { restacked, conflict, skipped } = await restack(client, {
            repo,
            startBranch: branch,
            remote: opts.remote,
            dryRun: opts.dryRun,
          })

          if (opts.dryRun) return

          if (restacked.length > 0) {
            console.log(`Restacked ${restacked.length} PR(s):`)
            for (const pr of restacked) console.log(`  ✓ #${pr.number}  ${pr.headBranch}`)
          }

          if (conflict) {
            printRebaseFailure(conflict, skipped, opts.remote, "restack")
            process.exit(1)
          }
        } catch (err) {
          const msg = (err as Error).message
          if (msg.includes("No open PR found") && msg.includes(branch)) {
            console.error(`Error: No open PR found for branch "${branch}" -- it may have already been merged.`)
          } else {
            console.error("Error:", msg)
          }
          process.exit(1)
        }
      },
    )

  cmd
    .command("reorder <branch>")
    .description("Promote a branch above its parent in the stack")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--remote <name>", "Git remote name", "origin")
    .action(async (branch: string, opts: { repo?: string; dryRun?: boolean; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)

      try {
        const { promotedPr, demotedPr, restacked, conflict, skipped } = await reorderStack(client, {
          repo,
          branch,
          remote: opts.remote,
          dryRun: opts.dryRun,
        })

        if (opts.dryRun) return

        console.log(`Promoted #${promotedPr.number} above #${demotedPr.number}`)
        if (restacked.length > 0) {
          console.log(`Restacked ${restacked.length} PR(s):`)
          for (const pr of restacked) console.log(`  ✓ #${pr.number}  ${pr.headBranch}`)
        }

        if (conflict) {
          printRebaseFailure(conflict, skipped, opts.remote)
          process.exit(1)
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("split <branch>")
    .description("Detach a branch from its parent, making it a new independent stack")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--remote <name>", "Git remote name", "origin")
    .action(async (branch: string, opts: { repo?: string; dryRun?: boolean; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)

      try {
        const { splitPr, restacked, conflict, skipped } = await splitStack(client, {
          repo,
          branch,
          remote: opts.remote,
          dryRun: opts.dryRun,
        })

        if (opts.dryRun) return

        console.log(`Split #${splitPr.number} off as a new independent stack`)
        if (restacked.length > 0) {
          console.log(`Restacked ${restacked.length} PR(s):`)
          for (const pr of restacked) console.log(`  ✓ #${pr.number}  ${pr.headBranch}`)
        }

        if (conflict) {
          printRebaseFailure(conflict, skipped, opts.remote)
          process.exit(1)
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("sync [branch]")
    .description("Fetch latest trunk and rebase the entire stack onto it")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--continue", "Resume after resolving a conflict")
    .option("--abort", "Abort an in-progress sync")
    .action(
      async (
        branch: string | undefined,
        opts: { repo?: string; remote: string; dryRun?: boolean; continue?: boolean; abort?: boolean },
      ) => {
        if (opts.abort) {
          handleAbort("sync")
          return
        }

        if (opts.continue) {
          await handleContinue(opts.remote, "sync")
          return
        }

        const repo = resolveRepo(opts.repo, opts.remote)
        const client = resolveClient(opts.remote)
        const targetBranch = branch ?? getCurrentBranch(process.cwd())

        try {
          const { root, baseBranch, synced, conflict, skipped } = await syncStack(client, {
            repo,
            branch: targetBranch,
            remote: opts.remote,
            dryRun: opts.dryRun,
          })

          if (opts.dryRun) return

          console.log(`Synced stack rooted at #${root.number} (${root.headBranch}) onto ${opts.remote}/${baseBranch}`)
          if (synced.length > 0) {
            console.log(`Rebased ${synced.length} PR(s):`)
            for (const pr of synced) console.log(`  ✓ #${pr.number}  ${pr.headBranch}`)
          }

          if (conflict) {
            printRebaseFailure(conflict, skipped, opts.remote, "sync")
            process.exit(1)
          }
        } catch (err) {
          console.error("Error:", (err as Error).message)
          process.exit(1)
        }
      },
    )
}
