import { Command } from "commander"
import { registerLifecycleCommands } from "./stack/lifecycle.ts"
import { registerNavCommands } from "./stack/nav.ts"
import { registerRebaseCommands } from "./stack/rebase.ts"

export function buildStackCommand(): Command {
  const cmd = new Command("stack").description("Stack management commands")
  registerNavCommands(cmd)
  registerRebaseCommands(cmd)
  registerLifecycleCommands(cmd)
  return cmd
}
