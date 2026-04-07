#!/usr/bin/env bun
import { formatStatus } from "@pramid/core"
import { startServer } from "@pramid/server"
import { Command } from "commander"
import { buildBranchCommand, registerPushCommand } from "./commands/branch.ts"
import { buildStackCommand } from "./commands/stack.ts"
import {
  configPath,
  credentialErase,
  credentialRetrieve,
  credentialStore,
  getGitLabHost,
  hasCredentialHelper,
  isInsideGitRepo,
  readConfig,
  readLocalConfig,
  readMergedConfig,
  resolveGitHubUser,
  resolveGitLabUser,
  writeConfig,
  writeLocalConfig,
} from "./config.ts"
import {
  getGitHubTokenSource,
  getGitLabToken,
  getGitLabTokenSource,
  getToken,
  openBrowser,
  prompt,
  resolveClient,
  resolveRepo,
  validateGitLabToken,
  validateToken,
} from "./utils.ts"

const program = new Command()

import pkg from "../package.json"

program.name("pramid").description("PR stack management tool").version(pkg.version)

program
  .command("status")
  .description("Show all open PR stacks for a repository")
  .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
  .option("--remote <name>", "Git remote name used for auto-detection", "origin")
  .action(async (opts: { repo?: string; remote: string }) => {
    const repo = resolveRepo(opts.repo, opts.remote)
    const client = resolveClient(opts.remote)

    try {
      const prs = await client.listOpenPRs(repo)
      console.log(formatStatus(prs))
    } catch (err) {
      console.error("Error:", (err as Error).message)
      process.exit(1)
    }
  })

program.addCommand(buildStackCommand())
program.addCommand(buildBranchCommand())
registerPushCommand(program)

const authCmd = program
  .command("auth")
  .description("Set up or replace the stored GitHub or GitLab token")
  .option("--gitlab", "Set up a GitLab token instead of GitHub")
  .option("--global", "Set this user as the default for all repositories")
  .action(async (opts: { gitlab?: boolean; global?: boolean }) => {
    const cwd = process.cwd()
    const useGlobal = opts.global === true
    const inRepo = isInsideGitRepo(cwd)

    if (!useGlobal && !inRepo) {
      console.error("Error: Not inside a git repository.")
      console.error(
        "Use --global to set a default user for all repos, or run from inside a git repo.",
      )
      process.exit(1)
    }

    // Check for credential helper — fall back to plaintext if unavailable
    const hasCred = hasCredentialHelper()
    if (!hasCred) {
      console.log("Note: No git credential helper configured — tokens will be stored as plaintext.")
      console.log("For secure (encrypted) storage, configure a credential helper:")
      console.log("  https://git-scm.com/docs/gitcredentials\n")
    }

    if (opts.gitlab) {
      // ── GitLab flow ─────────────────────────────────────────────────────────
      const envToken = process.env.GITLAB_TOKEN
      if (envToken) {
        console.log(
          "Note: GITLAB_TOKEN is set in the environment and will always take priority over a stored token.",
        )
        console.log("Unset it first if you want the stored token to be used.\n")
      }

      // Check for an existing token at the target level
      const host = getGitLabHost(cwd)
      const existingUser = useGlobal ? readConfig().gitlabUser : resolveGitLabUser(cwd)
      const existingToken =
        existingUser && hasCred
          ? credentialRetrieve(host, existingUser)
          : useGlobal
            ? readConfig().gitlabToken
            : readMergedConfig(cwd).gitlabToken
      const existingUrl = readMergedConfig(cwd).gitlabUrl

      if (existingToken) {
        const storageLabel =
          existingUser && hasCred
            ? `credential helper (${existingUser})`
            : useGlobal
              ? "global config"
              : "local config"
        console.log(`Validating existing ${storageLabel} GitLab token...`)
        const baseUrl = existingUrl ? `${existingUrl}/api/v4` : "https://gitlab.com/api/v4"
        const existing = await validateGitLabToken(existingToken, baseUrl)
        if (existing.ok) {
          console.log(`Currently authenticated as: ${existing.login}`)
        } else {
          console.log(`Stored token is invalid: ${existing.error}`)
        }
        const replace = await prompt("Replace it? [y/N] ")
        if (replace.toLowerCase() !== "y") {
          console.log("No changes made.")
          return
        }
        console.log()
      }

      console.log("Create a Personal Access Token with 'api' scope:")
      console.log()
      console.log(
        "  https://gitlab.com/-/user_settings/personal_access_tokens?name=PRamid&scopes=api",
      )
      console.log()

      const token = await prompt("Paste your GitLab token: ")
      if (!token) {
        console.error("No token entered.")
        process.exit(1)
      }

      const customUrlInput = await prompt("GitLab instance URL (press Enter for gitlab.com): ")
      const gitlabUrl = customUrlInput ? customUrlInput.replace(/\/$/, "") : undefined
      const baseUrl = gitlabUrl ? `${gitlabUrl}/api/v4` : "https://gitlab.com/api/v4"

      console.log("\nValidating token...")
      const result = await validateGitLabToken(token, baseUrl)
      if (!result.ok) {
        console.error(`Token validation failed: ${result.error}`)
        process.exit(1)
      }

      const login = result.login
      console.log(`Authenticated as: ${login}`)

      const credHost = gitlabUrl ? new URL(gitlabUrl).hostname : "gitlab.com"

      if (hasCred) {
        // Erase old credential if user changed
        if (existingUser && existingToken) credentialErase(host, existingUser, existingToken)
        credentialStore(credHost, login, token)

        if (useGlobal) {
          writeConfig({ ...readConfig(), gitlabUser: login, ...(gitlabUrl ? { gitlabUrl } : {}) })
          console.log(`\nToken saved to credential store. Default GitLab user set to: ${login}`)
        } else {
          writeLocalConfig({ gitlabUser: login, ...(gitlabUrl ? { gitlabUrl } : {}) }, cwd)
          console.log(
            `\nToken saved to credential store. GitLab user for this repo set to: ${login}`,
          )
        }
      } else {
        // No credential helper — fall back to plaintext
        if (useGlobal) {
          writeConfig({
            ...readConfig(),
            gitlabToken: token,
            gitlabUser: login,
            ...(gitlabUrl ? { gitlabUrl } : {}),
          })
          console.log(`\nToken saved to ${configPath()} (plaintext)`)
        } else {
          writeLocalConfig(
            { gitlabToken: token, gitlabUser: login, ...(gitlabUrl ? { gitlabUrl } : {}) },
            cwd,
          )
          console.log("\nToken saved to local git config (.git/config, plaintext)")
        }
      }
      return
    }

    // ── GitHub flow ───────────────────────────────────────────────────────────
    const envToken = process.env.GITHUB_TOKEN
    if (envToken) {
      console.log(
        "Note: GITHUB_TOKEN is set in the environment and will always take priority over a stored token.",
      )
      console.log("Unset it first if you want the stored token to be used.\n")
    }

    const existingUser = useGlobal ? readConfig().githubUser : resolveGitHubUser(cwd)
    const existingToken =
      existingUser && hasCred
        ? credentialRetrieve("github.com", existingUser)
        : useGlobal
          ? readConfig().githubToken
          : readMergedConfig(cwd).githubToken

    if (existingToken) {
      const storageLabel =
        existingUser && hasCred
          ? `credential helper (${existingUser})`
          : useGlobal
            ? "global config"
            : "local config"
      console.log(`Validating existing ${storageLabel} token...`)
      const existing = await validateToken(existingToken)
      if (existing.ok) {
        console.log(`Currently authenticated as: ${existing.login}`)
      } else {
        console.log(`Stored token is invalid: ${existing.error}`)
      }
      const replace = await prompt("Replace it? [y/N] ")
      if (replace.toLowerCase() !== "y") {
        console.log("No changes made.")
        return
      }
      console.log()
    }

    console.log("Create a Personal Access Token with the required permissions:")
    console.log()
    console.log("  Fine-grained PAT (recommended):")
    console.log("  https://github.com/settings/tokens?type=beta")
    console.log("  Required: Pull requests (read/write), Checks (read), Metadata (read)")
    console.log()
    console.log("  Classic PAT (permissions pre-selected via URL):")
    console.log("  https://github.com/settings/tokens/new?scopes=repo,read:org&description=PRamid")
    console.log("  Note: 'repo' scope grants full repository access")
    console.log()

    const token = await prompt("Paste your GitHub token: ")
    if (!token) {
      console.error("No token entered.")
      process.exit(1)
    }

    console.log("\nValidating token...")
    const result = await validateToken(token)
    if (!result.ok) {
      console.error(`Token validation failed: ${result.error}`)
      process.exit(1)
    }

    const login = result.login
    console.log(`Authenticated as: ${login}`)
    if (result.scopes) {
      console.log(`Scopes: ${result.scopes}`)
    } else {
      console.log("Fine-grained PAT detected (no scope header).")
    }

    if (hasCred) {
      // Erase old credential if user changed
      if (existingUser && existingToken) credentialErase("github.com", existingUser, existingToken)
      credentialStore("github.com", login, token)

      if (useGlobal) {
        writeConfig({ ...readConfig(), githubUser: login })
        console.log(`\nToken saved to credential store. Default GitHub user set to: ${login}`)
      } else {
        writeLocalConfig({ githubUser: login }, cwd)
        console.log(`\nToken saved to credential store. GitHub user for this repo set to: ${login}`)
      }
    } else {
      // No credential helper — fall back to plaintext
      if (useGlobal) {
        writeConfig({ ...readConfig(), githubToken: token, githubUser: login })
        console.log(`\nToken saved to ${configPath()} (plaintext)`)
      } else {
        writeLocalConfig({ githubToken: token, githubUser: login }, cwd)
        console.log("\nToken saved to local git config (.git/config, plaintext)")
      }
    }
  })

authCmd
  .command("status")
  .description("Show stored authentication state for GitHub and GitLab")
  .action(async () => {
    const cwd = process.cwd()
    const gh = getGitHubTokenSource()
    const gl = getGitLabTokenSource()

    const sourceLabel = (s: string, user?: string) => {
      const base = (() => {
        switch (s) {
          case "env":
            return "env var"
          case "credential":
            return "credential helper"
          case "local":
            return "local git config"
          case "global":
            return "global config"
          default:
            return ""
        }
      })()
      return user ? `${base}, user: ${user}` : base
    }

    // ── GitHub ────────────────────────────────────────────────────────────────
    if (gh.source !== "none") {
      let token: string | undefined
      if (gh.source === "env") token = process.env.GITHUB_TOKEN
      else if (gh.source === "credential" && gh.user)
        token = credentialRetrieve("github.com", gh.user) ?? undefined
      else token = readMergedConfig(cwd).githubToken

      if (token) {
        const result = await validateToken(token)
        const label = sourceLabel(gh.source, gh.user)
        console.log(
          `GitHub:  ${result.ok ? `authenticated as ${result.login}` : `token invalid — ${result.error}`}  (${label})`,
        )
      }
    } else {
      console.log("GitHub:  no token  →  run `pramid auth --global` to set one up")
    }

    // ── GitLab ────────────────────────────────────────────────────────────────
    const config = readMergedConfig(cwd)
    const host = getGitLabHost(cwd)
    const baseUrl = config.gitlabUrl ? `${config.gitlabUrl}/api/v4` : "https://gitlab.com/api/v4"
    const instanceLabel = config.gitlabUrl ? ` (${config.gitlabUrl})` : ""
    if (gl.source !== "none") {
      let token: string | undefined
      if (gl.source === "env") token = process.env.GITLAB_TOKEN
      else if (gl.source === "credential" && gl.user)
        token = credentialRetrieve(host, gl.user) ?? undefined
      else token = config.gitlabToken

      if (token) {
        const result = await validateGitLabToken(token, baseUrl)
        const label = sourceLabel(gl.source, gl.user)
        console.log(
          `GitLab:  ${result.ok ? `authenticated as ${result.login}` : `token invalid — ${result.error}`}  (${label})${instanceLabel}`,
        )
      }
    } else {
      console.log("GitLab:  no token  →  run `pramid auth --global --gitlab` to set one up")
    }
  })

program
  .command("gui")
  .description("Start the graphical UI and open it in your browser")
  .option("--repo <owner/repo>", "GitHub repository (default: auto-detect from git remote)")
  .option("--remote <name>", "Git remote name used for auto-detection", "origin")
  .option("--port <number>", "Port to listen on", "7420")
  .action(async (opts: { repo?: string; remote: string; port: string }) => {
    const repo = resolveRepo(opts.repo, opts.remote)
    const client = resolveClient(opts.remote)
    const port = Number(opts.port)

    // Load web assets — Bun.file + import.meta.url causes bun build --compile to embed them
    let html: string
    let js: string
    let css: string
    try {
      ;[html, js, css] = await Promise.all([
        Bun.file(new URL("../../web/dist/index.html", import.meta.url)).text(),
        Bun.file(new URL("../../web/dist/assets/index.js", import.meta.url)).text(),
        Bun.file(new URL("../../web/dist/assets/index.css", import.meta.url)).text(),
      ])
    } catch {
      console.error("Error: Web assets not found. Run `bun run build` in packages/web first.")
      process.exit(1)
    }

    const url = `http://localhost:${port}`
    console.log(`PRamid UI → ${url}`)
    console.log("Press Ctrl+C to stop.\n")

    openBrowser(url)

    try {
      await startServer({
        repo,
        client,
        port,
        remote: opts.remote,
        cwd: process.cwd(),
        assets: { html, js, css },
      })
    } catch (err) {
      console.error("Error:", (err as Error).message)
      process.exit(1)
    }
  })

program.parse()
