# PRamid

Open-source CLI for PR/MR stacking on GitHub and GitLab. Create, visualize, and rebase stacked pull requests with one command.

## Install

```bash
git clone https://github.com/mod-0-dev/PRamid
cd PRamid
bun install
bun link   # makes `pramid` available globally
```

Requires [Bun](https://bun.sh).

## Setup

```bash
pramid auth --global           # one-time: set your default GitHub user
pramid auth --global --gitlab  # one-time: set your default GitLab user
pramid auth                    # per-repo: override with a different account
pramid auth status             # show active tokens and their source
```

Tokens are stored in your system's credential manager (Windows Credential Manager, macOS Keychain, etc.) — encrypted, never as plaintext. Only the username is written to config as a pointer. Use `--global` once for your default account, then `pramid auth` (without `--global`) in any repo that needs a different account. Environment variables (`GITHUB_TOKEN` / `GITLAB_TOKEN`) always take priority.

The platform is auto-detected from the git remote URL — no extra flags needed when running commands.

## Usage

Run these commands from inside your git repository — the owner/repo is auto-detected from the git remote. Use `--repo owner/repo` to override.

```bash
# Create a new branch stacked on the current one
pramid branch new feat/step-2   # git checkout -b + records parent

# Push current branch and create/update its PR in one command
pramid push
pramid push --draft             # create as draft PR

# Show all open stacks in a repo
pramid status

# Display the stack as a colored ASCII tree
pramid stack log
pramid stack log feat/step-2   # scope to one stack

# Push all branches in the stack and create/update their PRs in one command
pramid stack submit                  # auto-discovers stack from current branch
pramid stack submit feat/step-2      # start from a specific branch
pramid stack submit --draft          # create new PRs as drafts
pramid stack submit --dry-run        # preview without pushing

# Create a stack from local branches (branches must be pushed)
pramid stack create main feat/step-1 feat/step-2 feat/step-3

# Navigate between branches in a stack
pramid stack next           # go to child branch
pramid stack prev           # go to parent branch (or base at root)
pramid stack checkout auth  # jump to branch by name, PR number, or partial match

# Rebase a branch and everything above it
pramid stack restack feat/step-1

# Preview without making changes
pramid stack restack feat/step-1 --dry-run

# Resume after resolving a rebase conflict (git add done)
pramid stack restack --continue

# Abort an in-progress restack
pramid stack restack --abort

# Promote a branch above its parent (swap order)
pramid stack reorder feat/step-2

# Split a branch off into its own independent stack
pramid stack split feat/step-2

# Close a PR and re-target its children onto its base
pramid stack close feat/step-2

# Merge the full stack bottom-up (feat/step-1 → feat/step-2 → feat/step-3)
pramid stack merge feat/step-1

# Merge one PR only, re-target children
pramid stack merge feat/step-2 --single

# Choose merge strategy (merge / squash / rebase)
pramid stack merge feat/step-1 --strategy squash

# Fetch trunk and rebase the whole stack onto the latest remote state
pramid stack sync feat/step-1

# Resume after resolving a sync conflict (git add done)
pramid stack sync --continue

# Abort an in-progress sync
pramid stack sync --abort

# Rebuild the navigation table in every PR description
pramid stack update-nav feat/step-1

# Remove stale stack config entries for deleted/renamed branches
pramid stack gc
pramid stack gc --dry-run   # preview without changes

# Start the web UI (opens browser automatically at http://localhost:7420)
pramid gui
pramid gui --port 8080   # use a different port
```

See [`docs/workflow.md`](docs/workflow.md) for a start-to-finish walkthrough and [`docs/usage.md`](docs/usage.md) for the full command reference.

## Dev setup

```bash
bun install
bun test
```

## License

MIT
