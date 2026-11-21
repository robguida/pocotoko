# Project instructions

A Claude Code plugin with a copy-by-hand install path. This file is public. Keep it generic.

## Source of truth
- Build from `docs/design/ptt-spec.md`. It is the only design input.
- If the spec and the live Claude Code docs disagree, follow the docs and record the difference in `docs/changelog.md`.

## Layout
- `./src` holds ONLY files that ship. Two plugins: `src/core/` and `src/search/`.
- Everything else sits at the top, outside `./src`: `tests/`, `scripts/`, `docs/`, `.github/`, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `package.json`, and `.claude-plugin/marketplace.json`.
- `sandbox/` is gitignored. All temporary files go there. Never use the OS temp folder. Never touch the developer's real Claude config folder (a read-only before/after listing by the sandbox guard is allowed).

## Code
- Node.js built-ins only. No dependencies.
- Windows, macOS and Linux are equal targets. Build every path with `path.join` / `path.resolve`.
- Loops: one item failing MUST NOT abort the batch. Collect each failure and report succeeded / failed / skipped at the end.

## Hard lines
- No plugin, marketplace, skill, MCP server or tool name contains "claude" or "anthropic".
- No savings claims anywhere: no numbers, percentages or money tied to tokens, cost or speed, and no "uses fewer tokens" wording. Explaining a mechanism is fine.
- The copyright holder's name appears only in `LICENSE`. The GitHub account name appears only inside the install lines, the repository addresses (including the `repository` and `homepage` fields of the plugin manifests), the owner entries of `.github/CODEOWNERS` and the scrub scan's install-slug allow list.

## Before every commit
- Run the scrub scan, both layers: `node scripts/scrub-scan.mjs` and `node scripts/scrub-scan.mjs --private`. Both must pass.
- Run the tests: `npm test`.
