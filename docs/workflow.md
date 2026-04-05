# PRamid — Developer Workflow Guide

This guide walks through a complete stacking workflow from first setup to merging, using concrete commands at every step.

---

## 1. First-time setup

Install PRamid and authenticate once per account.

```bash
git clone https://github.com/mod-0-dev/PRamid
cd PRamid
bun install && bun link        # makes `pramid` available globally
```

```bash
pramid auth --global           # GitHub (prompted for a PAT)
pramid auth --global --gitlab  # GitLab (if using GitLab instead)
pramid auth status             # verify the stored token and active user
```

You only need to do this once per machine. For repos that use a different account, run `pramid auth` (without `--global`) inside that repo.

---

## 2. Build a stack

Start from a clean trunk branch. Use `pramid branch new` instead of `git checkout -b` — it creates the branch and records the parent relationship so every subsequent command knows the stack topology.

```bash
git checkout main
git pull

pramid branch new feat/auth           # creates branch + records parent: main
# ... write code, commit ...

pramid branch new feat/auth-tests     # creates branch + records parent: feat/auth
# ... write code, commit ...

pramid branch new feat/auth-docs      # creates branch + records parent: feat/auth-tests
# ... write code, commit ...
```

At this point you have three local branches stacked on top of each other, but nothing is pushed or on GitHub/GitLab yet.

---

## 3. Submit the whole stack at once

```bash
pramid stack submit
```

This single command:
1. Pushes all three branches to the remote (in root-to-tip order)
2. Creates a PR for each branch with the correct base branch
3. Injects a navigation table into every PR description

Use `--dry-run` to preview before pushing:

```bash
pramid stack submit --dry-run
```

To open all PRs as drafts:

```bash
pramid stack submit --draft
```

---

## 4. Inspect the stack

```bash
pramid stack log
```

Shows the full stack as an ASCII tree with CI status and review state:

```
main
└── feat/auth (#12) ✓ approved
    └── feat/auth-tests (#13) ● review
        └── feat/auth-docs (#14) ·
```

To check the status of all open PRs across the repo:

```bash
pramid status
```

---

## 5. Navigate between branches

Move up and down the stack without remembering branch names:

```bash
pramid stack next      # checkout child branch
pramid stack prev      # checkout parent branch (or trunk at the root)
```

Jump directly to any branch by name, PR number, or partial match:

```bash
pramid stack checkout feat/auth-tests
pramid stack checkout 13         # by PR number
pramid stack checkout auth-doc   # partial match (if unambiguous)
```

---

## 6. Iterate: amend a branch and re-push

After code review you need to update a branch. Checkout it, amend, then push:

```bash
pramid stack checkout 12         # jump to feat/auth
# ... make changes, commit or amend ...
pramid push                      # push this branch + refresh nav in all PR descriptions
```

Or re-submit the entire stack after several branches are updated:

```bash
pramid stack submit              # idempotent — only pushes what changed
```

---

## 7. Keep in sync with trunk

While your stack is in review, `main` moves forward. Sync your entire stack onto the latest trunk in one command:

```bash
pramid stack sync
```

This runs `git fetch`, rebases the stack root onto `origin/main`, cascades children in order, force-pushes every branch, and updates PR bases if needed. It also prunes any stale entries from the local stack config.

If there is a conflict:

```bash
# resolve conflicts in your editor, then:
git add .
pramid stack sync --continue

# to discard the sync entirely:
pramid stack sync --abort
```

---

## 8. Restack after a parent changes

If you amend `feat/auth` (e.g. squash a commit), the branches above it become stale. Restack from the changed branch downward:

```bash
pramid stack restack feat/auth
```

PRamid rebases `feat/auth-tests` onto the new `feat/auth` tip, then `feat/auth-docs` onto `feat/auth-tests`, and force-pushes each.

`← restack needed` markers in `pramid stack log` tell you which branches are stale before you run this.

---

## 9. Restructure the stack

**Reorder** — swap two adjacent branches:

```bash
# before: main → feat/auth → feat/auth-tests → feat/auth-docs
pramid stack reorder feat/auth-tests
# after:  main → feat/auth-tests → feat/auth → feat/auth-docs
```

**Split** — detach a branch into its own independent stack:

```bash
pramid stack split feat/auth-docs
# before: main → feat/auth → feat/auth-tests → feat/auth-docs
# after:  main → feat/auth → feat/auth-tests
#         main → feat/auth-docs  (independent)
```

**Close** — close a PR and re-target its children onto its base:

```bash
pramid stack close feat/auth-tests
# before: main → feat/auth → feat/auth-tests → feat/auth-docs
# after:  main → feat/auth → feat/auth-docs
```

All restructuring commands accept `--dry-run` to preview the result first.

---

## 10. Merge the stack

Once all PRs are approved, merge bottom-up with one command:

```bash
pramid stack merge feat/auth
```

PRamid merges `feat/auth` into `main`, re-targets `feat/auth-tests` onto `main`, merges it, and so on up the stack. Children are never merged into a stale base.

To merge just one PR without touching the rest:

```bash
pramid stack merge feat/auth --single
```

Choose a merge strategy:

```bash
pramid stack merge feat/auth --strategy squash
pramid stack merge feat/auth --strategy rebase
```

---

## 11. Clean up

After branches are merged or deleted, remove stale entries from the local stack config:

```bash
pramid stack gc --remote           # removes entries with no open PR and no remote branch
pramid stack gc --remote --dry-run # preview first
```

`--remote` is the right command after a full stack merge — it cleans up entries even if local branches still exist. The plain `pramid stack gc` (no flag) only prunes branches that are gone locally, and also runs automatically after every successful `pramid stack sync`.

---

## Quick reference

| Goal | Command |
|---|---|
| Create a stacked branch | `pramid branch new <name>` |
| Push + open PRs for entire stack | `pramid stack submit` |
| Push + open/update PR for current branch | `pramid push` |
| View the stack tree | `pramid stack log` |
| Move to child / parent branch | `pramid stack next` / `pramid stack prev` |
| Jump to any branch | `pramid stack checkout <name\|#n\|partial>` |
| Pull trunk changes into the stack | `pramid stack sync` |
| Fix stale children after amending a parent | `pramid stack restack <branch>` |
| Swap two adjacent branches | `pramid stack reorder <branch>` |
| Detach a branch into its own stack | `pramid stack split <branch>` |
| Close a PR and bridge its children | `pramid stack close <branch>` |
| Merge the full stack | `pramid stack merge <branch>` |
| Remove stale config entries (post-merge) | `pramid stack gc --remote` |
| Preview any destructive command | `--dry-run` |

For full option details see [`docs/usage.md`](usage.md).
