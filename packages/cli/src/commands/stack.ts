import { Command } from "commander"
import { registerNavCommands } from "./stack/nav.ts"
import { registerRebaseCommands } from "./stack/rebase.ts"
import { registerLifecycleCommands } from "./stack/lifecycle.ts"

export function buildStackCommand(): Command {
  const cmd = new Command("stack").description("Stack management commands")
  registerNavCommands(cmd)
  registerRebaseCommands(cmd)
  registerLifecycleCommands(cmd)
  return cmd
}
