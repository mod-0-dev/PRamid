import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

interface PramidState {
  parents: Record<string, string>
}

function statePath(cwd: string): string {
  return join(cwd, ".git", "pramid", "stack.json")
}

function readState(cwd: string): PramidState {
  const path = statePath(cwd)
  if (!existsSync(path)) return { parents: {} }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PramidState
  } catch {
    return { parents: {} }
  }
}

function writeState(cwd: string, state: PramidState): void {
  mkdirSync(join(cwd, ".git", "pramid"), { recursive: true })
  writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + "\n", "utf8")
}

/** Record that `branch` is stacked on `parent`. */
export function setParent(branch: string, parent: string, cwd: string): void {
  const state = readState(cwd)
  state.parents[branch] = parent
  writeState(cwd, state)
}

/** Return the recorded parent branch, or null if not set. */
export function getParentBranch(branch: string, cwd: string): string | null {
  return readState(cwd).parents[branch] ?? null
}

/** Remove the parent record for `branch`. */
export function unsetParent(branch: string, cwd: string): void {
  const state = readState(cwd)
  delete state.parents[branch]
  writeState(cwd, state)
}

/** Return all recorded parent relationships as a plain object. */
export function getAllParents(cwd: string): Record<string, string> {
  return { ...readState(cwd).parents }
}
