# Contributing

Thanks for wanting to help. This page says how to run the checks, what every change must pass, and how changes are merged.

## Ground rules

- Build from `docs/design/ptt-spec.md`. It is the only design input. If it and the live Claude Code docs disagree, the docs win, and the difference goes in `docs/changelog.md`.
- `./src` holds only files that ship. Tests, scripts and docs sit at the top, outside `./src`.
- Node.js built-ins only. No dependencies. Windows, macOS and Linux are equal targets, so build every path with `path.join` or `path.resolve`.
- In a loop, one item failing must not stop the batch. Collect each failure and report how many succeeded, failed and were skipped.
- No plugin, marketplace, skill, MCP server or tool name may contain the vendor's company or product name, and none may say "official". The product names may appear in prose where the docs describe the platform.
- No savings claims anywhere: no numbers, percentages or money tied to tokens, cost or speed. Explaining a mechanism is fine.
- Temporary files go in `sandbox/`, which is not committed. Never use the system temp folder, and never touch your real Claude config folder.
- Change the spec first when a choice is open, then the code, then the changelog.

## Running the checks

From the repo top, in bash, zsh or Git Bash:

```
node scripts/run-tests.mjs
node scripts/scrub-scan.mjs
```

In PowerShell, the same two lines work unchanged:

```
node scripts/run-tests.mjs
node scripts/scrub-scan.mjs
```

`npm test` and `npm run scrub` run the same scripts. The test runner lists test files itself and passes them to `node --test` by name, so no shell globbing is involved.

**Both scan layers must pass before a commit.** The public layer is the second command above, and it also runs in CI. The private layer checks for terms that must never appear, and it reads them from a deny-list file that is kept under `sandbox/` and never committed. Maintainers run it by pointing `SCRUB_DENYLIST` at that file:

```
# bash, zsh, Git Bash
SCRUB_DENYLIST=/full/path/to/sandbox/scrub-denylist.txt node scripts/scrub-scan.mjs --private

# PowerShell
$env:SCRUB_DENYLIST = 'C:/full/path/to/sandbox/scrub-denylist.txt'; node scripts/scrub-scan.mjs --private
```

If you are an outside contributor, run the public layer. A maintainer runs the private layer before merging.

## The install checks

`node scripts/sandbox.mjs --check` and `node scripts/copy-by-hand.mjs --check` install the kit into a throwaway home folder, run the hooks, and uninstall. They need a Claude Code program, given with `--claude-code <file>` or `--find-in <npm prefix>`. With none given they report SKIPPED, and a skip never counts as a pass.

**Close every Claude Code session before you run them, and run them from a plain terminal.** A live session rewrites parts of the config folder, and the checks watch a few of those files to prove they were not touched. CI has no live session.

## Merging

- **Changes land as local commits that are then pushed.** Do not use the host's web merge or web edit buttons. A change made on the host's web pages is committed under the host's own identity, which the history scan rejects.
- The default branch is moved only by a fast-forward push to a commit whose checks already passed on its pull-request branch.
- **Every outside pull request gets a security review before merge.** The hooks and the search server read your files and your chat, so a change to either gets extra care.
- Commit messages say what changed, where and why. They name no team or tooling.
- Contributions are under the repo's licence, per the host's terms.

## Repo settings the owner keeps on

These are settings on the host, not files in the repo. They are recorded here so a new maintainer can check them.

- Branch protection on the default branch: required review, required checks, no force push.
- Approval required before workflows run for outside contributors.
- `.github/CODEOWNERS` covering `src/**/hooks/**`, `src/search/**`, `.github/**`, `scripts/**` and `package.json`.
- Private vulnerability reporting switched on.
- Signed release tags, with SHA-256 checksums in the release notes (recommended).
- Automated update pull requests for CI actions only (recommended).

**One maintainer.** A lone maintainer cannot approve their own pull request. So the branch rule lets an administrator skip the **review** requirement only. The required checks are never skipped: a merge by bypass happens only when every check is green, and a force push is never allowed. Where the host applies a bypass to a whole rule set, use two rules: one for checks and no force push, with no bypass, and one for review, with the administrator bypass. This bypass is removed once a second maintainer with review rights joins.

## CI

`.github/workflows/ci.yml` runs on Windows, macOS and Linux across the supported Node lines. It has no secrets, never uses `pull_request_target`, gives each job read-only access, and pins every action to a full commit hash. A step that needs a login shows SKIPPED with its reason, and the job summary counts skips.
