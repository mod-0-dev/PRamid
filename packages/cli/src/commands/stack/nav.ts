import type { Command } from "commander"
import { formatLog, stackNext, stackPrev, stackGoto, getCurrentBranch, checkoutBranch } from "@pramid/core"
import { resolveRepo, resolveClient } from "../../utils.ts"

export function registerNavCommands(cmd: Command): void {
  cmd
    .command("log [branch]")
    .description("Display the PR stack as a tree (defaults to all stacks; pass a branch to show only that branch and its descendants)")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .option("--no-color", "Disable ANSI color output")
    .action(async (branch: string | undefined, opts: { repo?: string; remote: string; color: boolean }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const useColor = opts.color && process.stdout.isTTY

      try {
        const prs = await client.listOpenPRs(repo)
        console.log(formatLog(prs, { branch, color: useColor }))
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("next")
    .description("Checkout the child branch of the current branch in the stack")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (opts: { repo?: string; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const current = getCurrentBranch(process.cwd())

      try {
        const prs = await client.listOpenPRs(repo)
        const result = stackNext(prs, current)
        if (!result.ok) {
          console.error(result.error)
          if (result.choices) result.choices.forEach((c) => console.error(c))
          process.exit(1)
        }
        checkoutBranch(result.branch, process.cwd())
        console.log(`Switched to ${result.branch}`)
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("prev")
    .description("Checkout the parent branch of the current branch in the stack (or the base branch at the root)")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (opts: { repo?: string; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)
      const current = getCurrentBranch(process.cwd())

      try {
        const prs = await client.listOpenPRs(repo)
        const result = stackPrev(prs, current)
        if (!result.ok) {
          console.error(result.error)
          process.exit(1)
        }
        checkoutBranch(result.branch, process.cwd())
        if (result.atRoot) {
          console.log(`At stack root — checked out ${result.branch} (trunk)`)
        } else {
          console.log(`Switched to ${result.branch}`)
        }
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })

  cmd
    .command("checkout <query>")
    .description("Checkout a branch in the stack by branch name, PR number, or partial name")
    .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
    .option("--remote <name>", "Git remote name used for auto-detection", "origin")
    .action(async (query: string, opts: { repo?: string; remote: string }) => {
      const repo = resolveRepo(opts.repo, opts.remote)
      const client = resolveClient(opts.remote)

      try {
        const prs = await client.listOpenPRs(repo)
        const result = stackGoto(prs, query)
        if (!result.ok) {
          console.error(result.error)
          if (result.choices) result.choices.forEach((c) => console.error(c))
          process.exit(1)
        }
        checkoutBranch(result.branch, process.cwd())
        console.log(`Switched to ${result.branch}`)
      } catch (err) {
        console.error("Error:", (err as Error).message)
        process.exit(1)
      }
    })
}
