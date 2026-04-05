import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

export interface ConflictState {
  /** Which pramid command was running when the conflict occurred */
  command: "restack" | "sync"
  remote: string
  repo: { owner: string; repo: string }
  /** Branch where `git rebase` is currently paused */
  conflictBranch: string
  conflictPr: {
    id: string
    number: number
    headBranch: string
    baseBranch: string
    /** Parent PR's headBranch; null for stack-root PRs */
    parentHeadBranch: string | null
  }
  /** Head branches of PRs still to be restacked, in topological order */
  remainingBranches: string[]
}

function statePath(cwd: string): string {
  return join(cwd, ".git", "pramid", "conflict-state.json")
}

export function saveConflictState(state: ConflictState, cwd: string): void {
  const dir = join(cwd, ".git", "pramid")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(statePath(cwd), JSON.stringify(state, null, 2), "utf-8")
}

export function loadConflictState(cwd: string): ConflictState | null {
  const path = statePath(cwd)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConflictState
  } catch {
    return null
  }
}

export function clearConflictState(cwd: string): void {
  const path = statePath(cwd)
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    // Ignore cleanup errors
  }
}
