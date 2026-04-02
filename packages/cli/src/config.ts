import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

export interface PramidConfig {
  githubToken?: string
  gitlabToken?: string
  /** Base URL of the GitLab instance (default: "https://gitlab.com"). Stored without trailing slash. */
  gitlabUrl?: string
  /** GitHub username whose token is stored in the credential helper. */
  githubUser?: string
  /** GitLab username whose token is stored in the credential helper. */
  gitlabUser?: string
}

// ─── Global config (JSON file) ───────────────────────────────────────────────

function configDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(process.env["USERPROFILE"] ?? "~", "AppData", "Roaming")
    return join(appData, "pramid")
  }
  const xdgBase = process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "~", ".config")
  return join(xdgBase, "pramid")
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

export function readConfig(): PramidConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PramidConfig
  } catch {
    return {}
  }
}

export function writeConfig(config: PramidConfig): void {
  const dir = configDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8")
}

// ─── Local config (git config --local) ───────────────────────────────────────

function gitConfigGet(key: string, cwd: string): string | null {
  const proc = Bun.spawnSync(["git", "config", "--local", "--get", key], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) return null
  const value = new TextDecoder().decode(proc.stdout).trim()
  return value || null
}

function gitConfigSet(key: string, value: string, cwd: string): void {
  const proc = Bun.spawnSync(["git", "config", "--local", key, value], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new Error(`Failed to set git config ${key}: ${stderr}`)
  }
}

/** Read all pramid.* keys from the local git config. */
export function readLocalConfig(cwd: string): PramidConfig {
  return {
    githubToken: gitConfigGet("pramid.githubToken", cwd) ?? undefined,
    gitlabToken: gitConfigGet("pramid.gitlabToken", cwd) ?? undefined,
    gitlabUrl: gitConfigGet("pramid.gitlabUrl", cwd) ?? undefined,
    githubUser: gitConfigGet("pramid.githubUser", cwd) ?? undefined,
    gitlabUser: gitConfigGet("pramid.gitlabUser", cwd) ?? undefined,
  }
}

/** Write pramid config values to the local git config. */
export function writeLocalConfig(config: Partial<PramidConfig>, cwd: string): void {
  if (config.githubToken) gitConfigSet("pramid.githubToken", config.githubToken, cwd)
  if (config.gitlabToken) gitConfigSet("pramid.gitlabToken", config.gitlabToken, cwd)
  if (config.gitlabUrl) gitConfigSet("pramid.gitlabUrl", config.gitlabUrl, cwd)
  if (config.githubUser) gitConfigSet("pramid.githubUser", config.githubUser, cwd)
  if (config.gitlabUser) gitConfigSet("pramid.gitlabUser", config.gitlabUser, cwd)
}

/** Check whether the current directory is inside a git repository. */
export function isInsideGitRepo(cwd: string): boolean {
  const proc = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  return proc.exitCode === 0
}

// ─── Credential helper (system keychain) ─────────────────────────────────────

/** Check whether a git credential helper is configured. */
export function hasCredentialHelper(): boolean {
  const proc = Bun.spawnSync(["git", "config", "--get", "credential.helper"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim().length > 0
}

/**
 * Retrieve a token from the system credential store via `git credential fill`.
 * The username is used to look up the correct credential when multiple accounts
 * exist for the same host.
 */
export function credentialRetrieve(host: string, username: string): string | null {
  const input = `protocol=https\nhost=${host}\nusername=${username}\n\n`
  const proc = Bun.spawnSync(["git", "credential", "fill"], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  if (proc.exitCode !== 0) return null
  const output = new TextDecoder().decode(proc.stdout)
  const match = output.match(/^password=(.+)$/m)
  return match?.[1]?.trim() || null
}

/** Store a token in the system credential store via `git credential approve`. */
export function credentialStore(host: string, username: string, token: string): void {
  const input = `protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`
  Bun.spawnSync(["git", "credential", "approve"], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  })
}

/** Remove a token from the system credential store via `git credential reject`. */
export function credentialErase(host: string, username: string, token: string): void {
  const input = `protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`
  Bun.spawnSync(["git", "credential", "reject"], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  })
}

// ─── Merged config & resolution helpers ──────────────────────────────────────

export type TokenSource = "env" | "credential" | "local" | "global" | "none"

/**
 * Read the effective config by merging local git config over the global file.
 * Local values take precedence over global ones.
 */
export function readMergedConfig(cwd?: string): PramidConfig {
  const global = readConfig()
  if (!cwd || !isInsideGitRepo(cwd)) return global
  const local = readLocalConfig(cwd)
  return {
    githubToken: local.githubToken ?? global.githubToken,
    gitlabToken: local.gitlabToken ?? global.gitlabToken,
    gitlabUrl: local.gitlabUrl ?? global.gitlabUrl,
    githubUser: local.githubUser ?? global.githubUser,
    gitlabUser: local.gitlabUser ?? global.gitlabUser,
  }
}

/** Resolve the effective GitHub username (local override → global default). */
export function resolveGitHubUser(cwd?: string): string | null {
  if (cwd && isInsideGitRepo(cwd)) {
    const local = readLocalConfig(cwd)
    if (local.githubUser) return local.githubUser
  }
  return readConfig().githubUser ?? null
}

/** Resolve the effective GitLab username (local override → global default). */
export function resolveGitLabUser(cwd?: string): string | null {
  if (cwd && isInsideGitRepo(cwd)) {
    const local = readLocalConfig(cwd)
    if (local.gitlabUser) return local.gitlabUser
  }
  return readConfig().gitlabUser ?? null
}

/** Resolve the effective GitLab host from config (for credential lookup). */
export function getGitLabHost(cwd?: string): string {
  const config = readMergedConfig(cwd)
  if (config.gitlabUrl) {
    try {
      return new URL(config.gitlabUrl).hostname
    } catch { /* fall through */ }
  }
  return "gitlab.com"
}
