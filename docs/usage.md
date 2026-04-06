# PRamid — Command Reference

## Authentication

Run the guided setup once after installing:

```bash
pramid auth --global   # set your default GitHub user (one-time setup)
pramid auth            # override with a different user for this repo
```

### How it works

PRamid stores tokens in your system's credential manager (Windows Credential Manager, macOS Keychain, GNOME Keyring) via `git credential`. Only the **username** (not the token) is written to config — the token itself stays encrypted in the keychain.

| Scope | Flag | Username stored in | Token stored in |
|---|---|---|---|
| **Global default** | `--global` | `config.json` (`githubUser`) | System keychain |
| **Per-repo override** | *(none)* | `.git/config` (`pramid.githubUser`) | System keychain |

**First-time setup:** run `pramid auth --global` once to set your default user for all repos.

**Multi-account:** run `pramid auth` (without `--global`) inside a repo that uses a different account. That repo gets a local override while all other repos keep using the global default.

If no credential helper is configured, PRamid falls back to plaintext storage with a warning. To configure a credential helper:

```bash
# Windows (usually pre-configured with Git for Windows)
git config --global credential.helper manager

# macOS
git config --global credential.helper osxkeychain

# Linux (GNOME Keyring)
git config --global credential.helper libsecret
```

### Token resolution priority

When a command needs a token, PRamid checks these sources in order:

1. **Environment variable** (`GITHUB_TOKEN` / `GITLAB_TOKEN`) — always wins
2. **Resolve user** (local `pramid.githubUser` in `.git/config` → global `githubUser` in `config.json`)
3. **Credential helper** — look up token by user + host
4. **Plaintext fallback** — local `pramid.githubToken` → global `githubToken`

CI and scripted use still work via environment variables without any config.

### Required token permissions

| Scope | Why |
|---|---|
| Pull requests: read/write | Create, update, and merge PRs |
| Checks: read | Read CI status |
| Metadata: read | List repository metadata |

### Token types

| Type | Notes |
|---|---|
| Fine-grained PAT | Recommended — scoped to specific repos |
| Classic PAT | Use `repo` + `read:org` scopes |

## Repository detection

All commands are run from inside your local git repository. The `owner/repo` is auto-detected from the git remote (default: `origin`). To override:

```bash
pramid status --repo owner/repo
pramid stack restack feat/step-1 --repo owner/repo
```

Use `--remote <name>` to change which remote is used for auto-detection.

---

## Choosing a workflow

PRamid supports two workflows. Pick the one that fits your situation.

### Incremental (recommended for new stacks)

Build a stack branch-by-branch as you write code. PRamid records the parent relationship for you so every `pramid push` knows the correct base.

```bash
git checkout main
pramid branch new feat/auth          # creates branch + records parent
# ... commit changes ...
pramid push                          # pushes + creates PR: feat/auth → main

pramid branch new feat/auth-tests    # stacks on feat/auth automatically
# ... commit changes ...
pramid push                          # pushes + creates PR: feat/auth-tests → feat/auth
```

**When to use:** starting a stack from scratch; you want PRs created one at a time as you go.

---

### Batch (for existing branch chains)

You already have several local branches pushed to the remote and want to declare the whole stack at once.

```bash
git checkout -b feat/step-1   # ... commit, push ...
git checkout -b feat/step-2   # ... commit, push ...
git checkout -b feat/step-3   # ... commit, push ...

pramid stack create main feat/step-1 feat/step-2 feat/step-3
```

`stack create` creates or corrects all PRs and their base branches in one pass. It is idempotent — safe to re-run.

**When to use:** importing a chain of branches that already exists; onboarding a feature branch series that was created without PRamid; re-syncing base branches after a force-push cascade.

---

### All-at-once (recommended for tracked stacks)

You built the stack with `pramid branch new`, made commits on each branch, and now want to push and open all PRs in one go.

```bash
git checkout main
pramid branch new feat/auth       # records parent: main
# ... commit changes ...
pramid branch new feat/auth-tests # records parent: feat/auth
# ... commit changes ...

pramid stack submit               # pushes both + creates both PRs + refreshes nav
```

`stack submit` discovers the full stack automatically from the recorded parent relationships and submits everything in root-to-tip order. It is idempotent — re-running after adding commits or more branches is safe.

**When to use:** you built the stack with `pramid branch new` and want to publish all branches at once instead of calling `pramid push` on each one.

---

### Quick comparison

| | Incremental | All-at-once | Batch |
|---|---|---|---|
| Start | `pramid branch new` | `pramid branch new` | `git checkout -b` |
| Publish | `pramid push` (one PR at a time) | `pramid stack submit` (all at once) | `pramid stack create` (all at once) |
| Parent tracking | Stored automatically | Stored automatically | Inferred from branch order you supply |
| Best for | PRs opened as you go | Publish entire stack in one shot | Existing branch chains without parent records |

All three produce the same end state and are fully compatible with the rest of the `pramid stack` commands (`restack`, `reorder`, `sync`, etc.).

---

## `pramid auth`

Guided setup for GitHub or GitLab authentication.

```
pramid auth --global           # set default GitHub user for all repos
pramid auth                    # override GitHub user for this repo only
pramid auth --global --gitlab  # set default GitLab user for all repos
pramid auth --gitlab           # override GitLab user for this repo only
```

**Options:**

| Flag | Description |
|---|---|
| `--gitlab` | Set up a GitLab token instead of GitHub |
| `--global` | Set this user as the default for all repositories |

### GitHub (`pramid auth`)

1. If a stored token already exists for this level (global or per-repo), validates and shows the authenticated user; asks before replacing.
2. Prints token creation links (fine-grained and classic PAT).
3. Prompts for the token.
4. Calls `GET /user` to confirm the token is valid.
5. Stores the token in the credential helper (or plaintext if no helper is available).
6. Saves the authenticated username as a pointer (`githubUser` globally or `pramid.githubUser` locally).

The `GITHUB_TOKEN` environment variable always takes priority over any stored token.

### GitLab (`pramid auth --gitlab`)

1. Same validation-and-replace flow for any existing stored token.
2. Prints the GitLab PAT creation URL with `api` scope pre-selected.
3. Prompts for the token.
4. Optionally prompts for a custom GitLab instance URL (press Enter to use `gitlab.com`).
5. Calls `GET /api/v4/user` to validate and shows the authenticated username.
6. Stores the token and saves the username pointer (`gitlabUser`).

The `GITLAB_TOKEN` environment variable always takes priority over any stored token.

### Multi-account example

```bash
# One-time: set your work account as the global default
pramid auth --global
# → Authenticated as: work-user
# → Token saved to credential store. Default GitHub user set to: work-user

# Personal repo uses a different account — override locally
cd ~/personal-project
pramid auth
# → Authenticated as: personal-user
# → Token saved to credential store. GitHub user for this repo set to: personal-user

# All other repos still use work-user automatically
cd ~/work-project
pramid status   # ← just works, uses work-user from global default
```

### Platform auto-detection

PRamid reads the git remote URL to decide which client to use:
- Remote contains `github.com` → GitHub
- Remote contains `gitlab.com` → GitLab
- Remote matches the host in `gitlabUrl` config → GitLab
- Otherwise → GitHub (safe default)

No extra flags are needed on any command — authentication is resolved transparently.

Re-running `pramid auth` (or `pramid auth --gitlab`) at any time allows replacing a stored token.

### `pramid auth status`

Shows the effective token for each platform, its source, and which user is active:

```
$ pramid auth status
GitHub:  authenticated as octocat  (credential helper, user: octocat)
GitLab:  authenticated as tanuki   (global config)
```

Sources shown: `env var`, `credential helper`, `local git config`, or `global config`.

---

## `pramid gui`

Start a local web server that serves the graphical stack visualisation UI and opens it in your default browser.

```
pramid gui
pramid gui --port 8080
pramid gui --repo owner/repo
```

The server listens on port `7420` by default. Once started, the UI is available at `http://localhost:<port>`. Press `Ctrl+C` to stop the server.

The browser is opened automatically. If it does not open, navigate to the URL printed in the terminal.

**Options:**

| Flag | Description |
|---|---|
| `--port <number>` | Port to listen on (default: `7420`) |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--remote <name>` | Git remote name used for auto-detection (default: `origin`) |

---

## `pramid status`

Fetch all open pull requests and display them grouped by stack.

```
pramid status
```

Output shows each stack as a tree with CI status and review state:

```
   #1  feat: base layer        stack/base → main          [CI:✓ review:approved]
   └─ #2  feat: child layer    stack/child → stack/base   [CI:… review:none]

── Standalone ──
  #3  fix: typo               fix/typo → main             [CI:· review:none]
```

CI icons: `✓` success · `✗` failure · `…` pending · `·` none

---

## `pramid branch new <name>`

Create a new git branch stacked on the current one and record the parent relationship so `pramid push` can infer the PR base automatically.

```
pramid branch new feat/step-2
```

Equivalent to `git checkout -b feat/step-2` followed by storing the parent branch in git config. Switches to the new branch immediately.

Output: `Created branch feat/step-2 (stacked on feat/step-1)`

---

## `pramid push`

Push the current branch to the remote and create or update its PR — all in one command. Infers the base branch automatically from the existing PR graph or the parent relationship recorded in `.git/pramid/stack.json` by `pramid branch new`.

```
pramid push
pramid push --draft
pramid push --base main       # explicit base when auto-detection can't resolve
```

**Base branch resolution order:**
1. Existing open PR for this branch — idempotent re-runs
2. Parent relationship in `.git/pramid/stack.json` — set by `pramid branch new`
3. `--base <branch>` flag — explicit fallback

After creating or updating the PR, the stack navigation table is refreshed in all PR descriptions.

**Options:**

| Flag | Description |
|---|---|
| `--base <branch>` | Explicit base branch (overrides auto-detection) |
| `--draft` | Create the PR as a draft |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--remote <name>` | Git remote name (default: `origin`) |

**Typical workflow:**

```bash
git checkout main
pramid branch new feat/auth
# ... commit changes ...
pramid push                    # pushes + creates PR feat/auth → main

pramid branch new feat/auth-tests
# ... commit changes ...
pramid push                    # pushes + creates PR feat/auth-tests → feat/auth
```

---

## `pramid stack log [branch]`

Display the PR stack as a colored ASCII tree. Without a branch argument, all stacks in the repository are shown. Pass a branch name to scope the view to that branch's stack.

```
pramid stack log
pramid stack log feat/step-2
```

Example output:

```
main
└── feat/auth (#12) ✓ approved
    ├── feat/auth-tests (#13) ● review
    │   └── feat/auth-docs (#14) ·
    └── feat/auth-ui (#15) ✗ changes  ← restack needed
```

CI icons: `✓` success · `✗` failure · `●` pending · `·` none

Review labels: `approved` · `changes` · `review` · *(blank)* none

`← restack needed` is shown on branches whose parent has moved (stale).

**Options:**

| Flag | Description |
|---|---|
| `--no-color` | Disable ANSI color output (useful when piping) |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--remote <name>` | Git remote name (default: `origin`) |

Color is automatically disabled when stdout is not a TTY (e.g., when piping to a file or another command).

---

## `pramid stack next`

Checkout the child branch of the current branch in the stack. Errors if there are no children (already at the top) or if there are multiple children (ambiguous — use `pramid stack checkout` instead).

```
pramid stack next
```

---

## `pramid stack prev`

Checkout the parent branch of the current branch in the stack. At the stack root, checks out the base branch (e.g. `main`).

```
pramid stack prev
```

---

## `pramid stack checkout <query>`

Checkout a branch in the stack by branch name, PR number, or partial branch name.

```
pramid stack checkout feat/step-2   # exact branch name
pramid stack checkout 3             # PR number
pramid stack checkout "#3"          # PR number with # prefix
pramid stack checkout auth          # partial name — matches if unique
```

If the query matches multiple branches, all matches are listed and no checkout is performed.

**Options:**

| Flag | Description |
|---|---|
| `--repo <owner/repo>` | Override auto-detected repository |
| `--remote <name>` | Git remote name (default: `origin`) |

---

## `pramid stack create <base> [branches...]`

Create or update a stack of PRs from a list of local branches. Branches must already be pushed to the remote.

```
pramid stack create main feat/step-1 feat/step-2 feat/step-3
```

- Creates a PR for each branch that doesn't have one yet.
- For branches that already have an open PR, updates the base branch if it's wrong.
- Idempotent — safe to re-run.

PR titles are auto-generated from branch names (`feat/add-auth` → `feat: add auth`).

---

## `pramid stack submit [branch]`

Push every branch in the current stack and create or update their PRs — in a single command. This is the fastest way to submit an entire stack that was built with `pramid branch new` / `pramid push`.

```
pramid stack submit
pramid stack submit feat/step-2
pramid stack submit --draft
pramid stack submit --dry-run
```

- Discovers the stack automatically from the parent relationships recorded in `.git/pramid/stack.json`.
- Pushes branches in root-to-tip order.
- Creates a PR for each branch that doesn't have one yet; updates the base branch on PRs where it changed.
- Refreshes the navigation table in every PR description after all PRs are created/updated.
- Idempotent — safe to re-run after adding more commits or branches.

If `[branch]` is omitted, the current git branch is used as the starting point. The command walks up to the stack root and then submits all branches in the connected stack.

**Options:**

| Flag | Description |
|---|---|
| `--draft` | Create new PRs as drafts |
| `--dry-run` | Print what would be pushed and which PRs would be created/updated, without making any changes |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--remote <name>` | Git remote name (default: `origin`) |

**Typical workflow:**

```bash
git checkout main
pramid branch new feat/auth
# ... commit changes ...
pramid branch new feat/auth-tests
# ... commit changes ...
pramid branch new feat/auth-docs
# ... commit changes ...

pramid stack submit   # pushes all three branches + creates/updates all PRs
```

---

## `pramid stack restack <branch>`

Rebase `<branch>` and all PRs stacked above it onto their parents, then force-push.

```
pramid stack restack feat/step-1
```

**Options:**

| Flag | Description |
|---|---|
| `--dry-run` | Show what would happen without touching git or the API |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--continue` | Resume after manually resolving a conflict (`git add` done) |
| `--abort` | Abort an in-progress restack and roll back the rebase |

Must be run from inside the local git repository with a clean working tree. If there are uncommitted changes, stash them first:

```bash
git stash
pramid stack restack feat/step-1
git stash pop
```

**Squash-merge awareness:** when restacking a child whose parent was already rebased in the same run, pramid uses `git rebase --onto <parent> <old-parent-tip>` instead of a plain rebase. This ensures only the child's own commits are replayed, dropping any commits from the parent that were squash-merged into the trunk. Note: if all parent PRs were already merged before running restack (i.e., the branch is no longer connected to a parent in the graph), the squash-merge detection is not applied and a plain rebase is performed.

**On conflict:** the restack stops, saves its progress to `.git/pramid/conflict-state.json`, and prints the conflicting files:

```
Conflict in feat/step-2:
  src/auth.ts

Resolve the conflict, then:
  git add . && pramid stack restack --continue
```

Resolve the conflict in your editor, stage the changes, then run `--continue`. To discard the restack entirely, run `--abort`.

---

## `pramid stack reorder <branch>`

Promote `<branch>` above its parent in the stack, swapping their positions.

```
pramid stack reorder feat/step-2
```

Before: `main → feat/step-1 → feat/step-2 → feat/step-3`
After:  `main → feat/step-2 → feat/step-1 → feat/step-3`

`feat/step-1`, `feat/step-3`, and any deeper descendants are rebased automatically.

**Options:**

| Flag | Description |
|---|---|
| `--dry-run` | Show what would happen without touching git or the API |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |

Must be run from inside the local git repository with a clean working tree.

---

## `pramid stack split <branch>`

Detach `<branch>` from its parent, making it (and its descendants) an independent stack.

```
pramid stack split feat/step-2
```

Before: `main → feat/step-1 → feat/step-2 → feat/step-3`
After:  `main → feat/step-1`;  `main → feat/step-2 → feat/step-3`

`feat/step-2`'s commits are rebased onto `main` (removing `feat/step-1`'s changes). This can conflict if `feat/step-2` depends on changes from `feat/step-1`.

**Options:**

| Flag | Description |
|---|---|
| `--dry-run` | Show what would happen without touching git or the API |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |

Must be run from inside the local git repository with a clean working tree.

---

## `pramid stack close <branch>`

Close a PR and re-target its direct children onto its base branch, keeping the rest of the stack intact.

```
pramid stack close feat/step-2
```

Before: `main → feat/step-1 → feat/step-2 → feat/step-3`
After:  `main → feat/step-1 → feat/step-3`  (feat/step-3 re-targeted to feat/step-1)

This is a pure API operation — no local git changes are made.

**Options:**

| Flag | Description |
|---|---|
| `--dry-run` | Show what would happen without making any changes |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |

---

## `pramid stack merge <branch>`

Merge an entire stack bottom-up, starting from `<branch>`. After each merge, direct children are re-targeted onto the integration branch before being merged themselves.

```
pramid stack merge feat/step-1
```

Before: `main → feat/step-1 → feat/step-2 → feat/step-3`
Execution order: merge feat/step-1 → re-target feat/step-2 → main → merge feat/step-2 → re-target feat/step-3 → main → merge feat/step-3

If any PR has failing CI or missing approval, a warning is printed but the merge proceeds unless it is actually blocked by branch protection rules.

**Options:**

| Flag | Description |
|---|---|
| `--strategy <merge\|squash\|rebase>` | Merge strategy (default: `merge`) |
| `--single` | Merge only this one PR and re-target its children (does not merge the full stack) |
| `--dry-run` | Show the merge plan without making any changes |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |

**`--single` example:**

```
pramid stack merge feat/step-2 --single
```

Merges only `feat/step-2` and re-targets its children onto `feat/step-1` (feat/step-2's base).

---

## `pramid stack sync [branch]`

Fetch the latest state of the integration branch from the remote, then rebase the entire stack onto it. Unlike `restack` (which only fixes parent-child relationships within the stack), `sync` also pulls in remote commits on the trunk branch.

```
pramid stack sync
pramid stack sync feat/step-1
```

If `[branch]` is omitted, the current git branch is used. The command finds the stack root from any member branch.

**Execution order:**
1. `git fetch <remote> <baseBranch>` — pulls remote trunk commits locally
2. For each PR in topological order: rebase onto `origin/<baseBranch>` (root) or parent head branch (children), then force-push

**Options:**

| Flag | Description |
|---|---|
| `--dry-run` | Show what would happen without touching git or the API |
| `--remote <name>` | Git remote name (default: `origin`) |
| `--repo <owner/repo>` | Override auto-detected repository |
| `--continue` | Resume after manually resolving a conflict (`git add` done) |
| `--abort` | Abort an in-progress sync and roll back the rebase |

Must be run from inside the local git repository with a clean working tree.

**On conflict:** the sync stops, saves its progress to `.git/pramid/conflict-state.json`, and prints the conflicting files:

```
Conflict in feat/step-2:
  src/auth.ts

Resolve the conflict, then:
  git add . && pramid stack sync --continue
```

Resolve the conflict in your editor, stage the changes, then run `--continue`. To discard the sync entirely, run `--abort`.

---

## `pramid stack gc`

Remove stale entries from `.git/pramid/stack.json` for branches that are no longer active. Two modes:

**Local (default)** — removes entries where the branch doesn't exist locally:

```
pramid stack gc
pramid stack gc --dry-run
```

**Remote-aware** — removes entries where the branch has no open PR _and_ no remote ref. This is the right command to run after merging a full stack, when the remote branches have been deleted but local branches may still exist:

```
pramid stack gc --remote
pramid stack gc --remote --dry-run
```

The local check also runs automatically at the end of a successful `pramid stack sync`.

**Options:**

| Flag | Description |
|---|---|
| `--remote` | Prune entries with no open PR and no remote branch (requires API access) |
| `--dry-run` | Print what would be removed without making any changes |
| `--repo <owner/repo>` | Override auto-detected repository (used with `--remote`) |
| `--remote-name <name>` | Git remote name (default: `origin`) |

Example output (`--remote`):

```
Removed 4 stale entry(s):
  feat/auth              (no open PR, not on remote)
  feat/auth-tests        (no open PR, not on remote)
  feat/auth-docs         (no open PR, not on remote)
  fix/typo               (no open PR, not on remote)
Stack config is clean.
```

---

## `pramid stack update-nav [branch]`

Rebuild and re-inject the navigation table into the description of every PR in the stack. This is done automatically by `stack create`, but you can run it manually after external edits or after merging/closing a PR.

```
pramid stack update-nav
pramid stack update-nav feat/step-2
```

If `[branch]` is omitted, the current git branch is used. The command finds the whole stack and updates all members.

The navigation table looks like this in each PR description:

```
<!-- pramid-nav:start -->
| # | PR | Base |
|---|---|---|
| → | #1 feat: step 1 | main |
| | #2 feat: step 2 | feat/step-1 |
| | #3 feat: step 3 | feat/step-2 |
<!-- pramid-nav:end -->
```

Content outside the `pramid-nav` markers is preserved.

**Options:**

| Flag | Description |
|---|---|
| `--repo <owner/repo>` | Override auto-detected repository |

