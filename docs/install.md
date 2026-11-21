# Install

This page covers both ways to install the kit, the notes for each system, uninstall and troubleshooting.

## Before you start

- Node.js 22 or newer, on your `PATH`. Check with `node -v`.
- Claude Code 2.1.329 or later. That is the tested version. The one-command install form needs 2.1.292 or later from the shell.
- Plugins, settings and MCP servers are read when a session starts, so start a new session after you change any of them.
- Developers: close every Claude Code session before you run `node scripts/sandbox.mjs --check` or `node scripts/copy-by-hand.mjs --check`, and run them from a plain terminal. See "The install checks" in `CONTRIBUTING.md`.

## Plugin install

```
/plugin marketplace add robguida/pocotoko#v<version>
claude plugin install pocotoko@pocotoko
claude plugin install pocotoko-search@pocotoko
```

The last line is optional and adds search. The one-command form is `claude plugin install pocotoko --marketplace robguida/pocotoko`.

- Pin a version with `#`, as shown: replace `<version>` with a release number. A tag after `@` on a full web address is read as the address of a marketplace file, and fails.
- Then, if you want to change a default, run `/plugin configure`. See `session-limits.md` for the meter options and `search.md` for the search options.
- To show the meter on the status line, run the `meter-statusline` skill.
- Install and enable the search plugin before you start a session. Adding an MCP server in the middle of a chat can rebuild the cache (see `prompt-cache.md`).

**Installing from a local folder is a developer path only.** It runs the plugin from its source folder, and in that mode the kit saves nothing: no meter warnings, no hand-off files, and search is off with a message that says so. It is not offered as a user install. To test plugin mode as a developer, install from a git source.

**Organisations with managed MCP settings.** If your organisation's managed MCP configuration takes exclusive control of MCP servers, you will not get plugin MCP servers, so the search plugin cannot start for you. This comes from the Claude Code docs, and two live runs showed it: with such a file in place no plugin MCP server was listed or started; with the file moved aside, they all were. The core plugin has only hooks and skills, so it is not affected. On a machine like that, `claude mcp add --scope user` was refused ("enterprise MCP configuration is active and has exclusive control over MCP servers"), so the copy-by-hand step that registers the search server cannot work there either. A copy-by-hand install of the core alone is fine.

### Search options and the folder you start in

- Search is off until you list a folder in `projects`. The list takes full paths, one per entry. A comma-separated list works when each listed folder exists. If a folder name holds a comma and the value could be read two ways, search stays off with a fixed message, and you give the list as JSON-array text on one line.
- **List the folder you start sessions in.** For a session started in a subfolder of a git project, hooks are given that start folder as `CLAUDE_PROJECT_DIR`, not the top of the repo. In the checks, a plugin's server was given the same start folder, and the search server binds the folder it is given. So `projects` must name the folder you open Claude in.
- The plugin's options are stored at user level only. A repo cannot set them.
- Claude Code blocks a hook launch that names an option you never set, and only that launch. The core hooks name no options. They read their options from environment variables, so an option you never set simply takes its default, and no hook launch can be blocked this way.
- In the checks, a plugin's server got its options only through its launch settings, as the text stored, and a stand-in server's never-set text option with a default got that default; for search that would apply to `matching` and `word_families`.
- Whether a never-set option with no default (`projects`, `extra_types`, `never_folders`, `never_globs`, `never_terms`, `synonyms`) blocks the search server has not been seen. See "Not yet proven" below.
- Whether a never-set `drop_contacts` or `max_file_bytes` (options with a default that are not text) blocks the search server, and what value it then gets, has not been seen either.

## Node and your `PATH`

Plugin mode starts Node by the plain name `node`, found on your `PATH`, and has no Node-path option. The common installers give a real `node.exe` on Windows. If exec form fails on your machine, switch the hook to shell form with the full path to Node in single quotes.

**Why the lookup matters on Windows.** Some launchers look in the current folder before they look on `PATH`. A repository could plant its own program named `node` at its top, and a bare `node` could then run that instead of yours. A plugin cannot control how Claude Code finds its launch program, so the kit's defence is in layers, and it is honest about the limit.

- In the checks made for this kit (Claude Code 2.1.329), a planted copy did not run for any hook. Programs named `node.exe`, `node.com`, `node.cmd` and `node.bat` were all planted together, and every hook form ran the Node on `PATH`. The same was seen for a plugin's MCP server started with `node`.
- The kit cannot control how Claude Code finds the program.
- The self-check catches a stray but genuine Node only; it can never stop a planted program. If a Node that sits inside your project folder runs a kit script, the script does nothing and says so. A planted program never runs the kit's code at all, so the self-check cannot see it. Keep Node outside your projects: a normal install on `PATH`, or the full path in a copy-by-hand install.
- A copy-by-hand install always uses the full path of Node, so nothing planted is ever looked up. You must update that path after you move or upgrade Node.

## Per-system notes

- **Windows.** Use forward slashes in paths you write into settings. Git Bash is the shell for the status line if it is installed; otherwise PowerShell is used, which needs a different status line form (see below).
- **macOS and Linux.** Use the bash blocks. `zsh` is fine.
- **A home folder kept as a git repo.** The kit writes nothing in a git work tree. If your Claude config folder is inside a git repo, the core says so at session start and saves nothing, and search switches itself off and says why. Move the config folder out of the repo to turn them on.
- **A config folder inside the project you opened (copy-by-hand install)** (for example you started Claude in your config folder, or in a dotfiles repo that holds it). Each session prints that the routing rules were not added, because the skill file sits inside the current project. The same happens, with its own line, when the config folder sits anywhere inside a git repo other than a home folder kept as one. If you keep the config folder in git on purpose, paste the routing block into your own `CLAUDE.md` (the optional step) and the line stops. See `session-limits.md`.
- **Moved plugin cache.** If `CLAUDE_CODE_PLUGIN_CACHE_DIR` is set, the plugins folder is the folder that variable names, so the data folders move with it. The search server must receive that variable for the kit to tell an installed copy from a source folder. In the checks, the variable reached a plugin's server unchanged, but it was set to the default location there. A cache truly moved elsewhere has not been seen at a server.

## Copy by hand

This path copies files into your Claude config folder and adds three entries to your settings file, with no plugin system involved. It never overwrites a skill folder of the same name: if one exists, the steps stop and tell you.

Fill in the four lines at the top of the block for your shell: `<REPO>` (the kit download), `<CONFIG>` (your Claude config folder), `<KIT>` (a new kit folder named `pocotoko`, which must not exist yet) and `<NODE>` (the full path of the Node program). Use full paths with forward slashes; a `~` or a relative path stops the block. Keep the single quotes. If a path holds a single quote, write it as `'\''` in the bash block and as `''` in the PowerShell block. In the settings lines (JSON text), write a single quote in a path as `'\\''` in the Git Bash form and as `''` in the PowerShell form.

### Git Bash, macOS and Linux (bash, zsh)

<!-- install-steps:install-bash:start -->
```bash
(
set -e
REPO='<REPO>'
CONFIG='<CONFIG>'
KIT='<KIT>'
NODE='<NODE>'
for v in "$REPO" "$CONFIG" "$KIT" "$NODE"; do case "$v" in /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;; *) echo "Stopped: every path must be a full path (no ~ and no relative path): $v"; exit 1;; esac; done
# kit-folder (core): Make the new kit folder and its marker file. If the folder already exists, or is not named pocotoko, stop. Nothing is changed.
if [ -e "$KIT" ]; then echo "Stopped: $KIT already exists. It was not changed. Uninstall first, or name a new kit folder."; exit 1; fi
case "${KIT%/}" in */pocotoko|pocotoko) ;; *) echo "Stopped: the kit folder must be named pocotoko."; exit 1;; esac
mkdir -p "$KIT"
printf '%s\n' 'pocotoko kit folder' > "$KIT/.pocotoko-kit"
# kit-hooks-folder (core): Make the hooks folder.
mkdir -p "$KIT/hooks"
# copy-meter (core): Copy the chat-length meter.
cp "$REPO/src/core/hooks/meter.cjs" "$KIT/hooks/meter.cjs"
# copy-session-start (core): Copy the session-start hook.
cp "$REPO/src/core/hooks/session-start.cjs" "$KIT/hooks/session-start.cjs"
# skills-folder (core): Make the skills folder if it is not there yet, and note in the marker file that the steps made it.
if [ ! -e "$CONFIG/skills" ]; then mkdir -p "$CONFIG/skills"; printf '%s\n' 'created skills' >> "$KIT/.pocotoko-kit"; fi
# copy-skill-model-routing (core): Copy the model-routing skill. If a folder of that name exists, stop. It is never overwritten.
if [ -e "$CONFIG/skills/model-routing" ]; then echo "Stopped: $CONFIG/skills/model-routing already exists. It was not changed."; exit 1; fi
cp -R "$REPO/src/core/skills/model-routing" "$CONFIG/skills/model-routing"
# copy-skill-handoff (core): Copy the handoff skill. If a folder of that name exists, stop. It is never overwritten.
if [ -e "$CONFIG/skills/handoff" ]; then echo "Stopped: $CONFIG/skills/handoff already exists. It was not changed."; exit 1; fi
cp -R "$REPO/src/core/skills/handoff" "$CONFIG/skills/handoff"
# merge-settings (core): Add the two hooks from the snippet and one status line form, by shell, always under the key statusLine. Never replace an existing entry. A merge is done by hand in a text editor, in every shell.
# By hand: open $CONFIG/settings.json in a text editor and add the settings lines for this shell (below). Never replace an existing entry.
# meter-config-folder (core, optional): The folder for the meter options.
mkdir -p "$KIT/config"
# meter-config (core, optional): The meter options with their defaults. Never overwrites an existing file.
[ -e "$KIT/config/meter-config.json" ] || printf '%s\n' '{"soft_tokens":100000,"hard_tokens":150000,"repeat_every_tokens":50000,"handoff_note":true,"handoff_dir":"","routing_rules_at_start":true}' > "$KIT/config/meter-config.json"
# search-data-folder (search, optional): The folder for its options and index.
mkdir -p "$KIT/search/data"
# copy-search-server (search, optional): Copy the search server. If the folder exists, stop.
if [ -e "$KIT/search/server" ]; then echo "Stopped: $KIT/search/server already exists. It was not changed."; exit 1; fi
cp -R "$REPO/src/search/server" "$KIT/search/server"
# search-config (search, optional): Its options. Add the full path of each project folder to index to the projects list. Never overwrites an existing file.
[ -e "$KIT/search/data/search-config.json" ] || printf '%s\n' '{"projects":[]}' > "$KIT/search/data/search-config.json"
# search-register (search, optional): Register the server at user scope, exec form.
claude mcp add --scope user pocotoko-search -- "$NODE" "$KIT/search/server/server.cjs"
)
```
<!-- install-steps:install-bash:end -->

### PowerShell (Windows without Git Bash)

<!-- install-steps:install-powershell:start -->
```powershell
& {
$ErrorActionPreference = 'Stop'
$REPO = '<REPO>'
$CONFIG = '<CONFIG>'
$KIT = '<KIT>'
$NODE = '<NODE>'
foreach ($v in @($REPO, $CONFIG, $KIT, $NODE)) { if ($v -notmatch '^(?:[A-Za-z]:[\\/]|[\\/])') { Write-Output "Stopped: every path must be a full path (no ~ and no relative path): $v"; return } }
# kit-folder (core): Make the new kit folder and its marker file. If the folder already exists, or is not named pocotoko, stop. Nothing is changed.
if (Test-Path -LiteralPath "$KIT") { Write-Output "Stopped: $KIT already exists. It was not changed. Uninstall first, or name a new kit folder."; return }
if ((Split-Path -Leaf $KIT.TrimEnd('/', '\')) -cne 'pocotoko') { Write-Output "Stopped: the kit folder must be named pocotoko."; return }
[System.IO.Directory]::CreateDirectory("$KIT") | Out-Null
[System.IO.File]::WriteAllText("$KIT/.pocotoko-kit", 'pocotoko kit folder' + [char]10)
# kit-hooks-folder (core): Make the hooks folder.
[System.IO.Directory]::CreateDirectory("$KIT/hooks") | Out-Null
# copy-meter (core): Copy the chat-length meter.
[System.IO.File]::Copy("$REPO/src/core/hooks/meter.cjs", "$KIT/hooks/meter.cjs", $true)
# copy-session-start (core): Copy the session-start hook.
[System.IO.File]::Copy("$REPO/src/core/hooks/session-start.cjs", "$KIT/hooks/session-start.cjs", $true)
# skills-folder (core): Make the skills folder if it is not there yet, and note in the marker file that the steps made it.
if (-not (Test-Path -LiteralPath "$CONFIG/skills")) { [System.IO.Directory]::CreateDirectory("$CONFIG/skills") | Out-Null; [System.IO.File]::AppendAllText("$KIT/.pocotoko-kit", 'created skills' + [char]10) }
# copy-skill-model-routing (core): Copy the model-routing skill. If a folder of that name exists, stop. It is never overwritten.
if (Test-Path -LiteralPath "$CONFIG/skills/model-routing") { Write-Output "Stopped: $CONFIG/skills/model-routing already exists. It was not changed."; return }
Copy-Item -LiteralPath "$REPO/src/core/skills/model-routing" -Destination "$CONFIG/skills/model-routing" -Recurse
# copy-skill-handoff (core): Copy the handoff skill. If a folder of that name exists, stop. It is never overwritten.
if (Test-Path -LiteralPath "$CONFIG/skills/handoff") { Write-Output "Stopped: $CONFIG/skills/handoff already exists. It was not changed."; return }
Copy-Item -LiteralPath "$REPO/src/core/skills/handoff" -Destination "$CONFIG/skills/handoff" -Recurse
# merge-settings (core): Add the two hooks from the snippet and one status line form, by shell, always under the key statusLine. Never replace an existing entry. A merge is done by hand in a text editor, in every shell.
# By hand: open $CONFIG/settings.json in a text editor and add the settings lines for this shell (below). Never replace an existing entry.
# meter-config-folder (core, optional): The folder for the meter options.
[System.IO.Directory]::CreateDirectory("$KIT/config") | Out-Null
# meter-config (core, optional): The meter options with their defaults. Never overwrites an existing file.
if (-not (Test-Path -LiteralPath "$KIT/config/meter-config.json")) { [System.IO.File]::WriteAllText("$KIT/config/meter-config.json", '{"soft_tokens":100000,"hard_tokens":150000,"repeat_every_tokens":50000,"handoff_note":true,"handoff_dir":"","routing_rules_at_start":true}' + [char]10) }
# search-data-folder (search, optional): The folder for its options and index.
[System.IO.Directory]::CreateDirectory("$KIT/search/data") | Out-Null
# copy-search-server (search, optional): Copy the search server. If the folder exists, stop.
if (Test-Path -LiteralPath "$KIT/search/server") { Write-Output "Stopped: $KIT/search/server already exists. It was not changed."; return }
Copy-Item -LiteralPath "$REPO/src/search/server" -Destination "$KIT/search/server" -Recurse
# search-config (search, optional): Its options. Add the full path of each project folder to index to the projects list. Never overwrites an existing file.
if (-not (Test-Path -LiteralPath "$KIT/search/data/search-config.json")) { [System.IO.File]::WriteAllText("$KIT/search/data/search-config.json", '{"projects":[]}' + [char]10) }
# search-register (search, optional): Register the server at user scope, exec form.
claude mcp add --scope user pocotoko-search -- "$NODE" "$KIT/search/server/server.cjs"
}
```
<!-- install-steps:install-powershell:end -->

### The settings lines (every shell, by hand in a text editor)

A merge into your settings file is done by hand in a text editor, in every shell. Open `<CONFIG>/settings.json` and add the entries for your shell. Never replace an entry that is already there. The settings file is JSON, so a single quote in a path is written as `'\\''` in the Git Bash form and as `''` in the PowerShell form.

The two forms differ only in the status line. It is one command string, run through a shell, with no separate arguments. Use the Git Bash form on macOS, Linux and Git Bash. Use the PowerShell form only on Windows without Git Bash: there, a line that starts with a quoted path is read as text, so the command starts with `&`. Use forward slashes in every path.

<!-- install-steps:settings:start -->
Git Bash, macOS and Linux (bash, zsh): add these entries to <CONFIG>/settings.json.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<NODE>",
            "args": [
              "<KIT>/hooks/session-start.cjs"
            ],
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<NODE>",
            "args": [
              "<KIT>/hooks/meter.cjs"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "'<NODE>' '<KIT>/hooks/meter.cjs' --statusline"
  }
}
```

PowerShell (Windows without Git Bash): add these entries to <CONFIG>/settings.json.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<NODE>",
            "args": [
              "<KIT>/hooks/session-start.cjs"
            ],
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<NODE>",
            "args": [
              "<KIT>/hooks/meter.cjs"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "& '<NODE>' '<KIT>/hooks/meter.cjs' --statusline"
  }
}
```
<!-- install-steps:settings:end -->

## Uninstall a plugin install

Uninstall leaves nothing the kit created, except what you chose to keep.

1. Remove the status line entry the setup skill added, if you used it. The skill printed the undo lines.
2. `claude plugin uninstall pocotoko-search@pocotoko`
3. `claude plugin uninstall pocotoko@pocotoko`
4. `claude plugin marketplace remove pocotoko`

A plugin's data folder (state, notes, the status line copy, the search index) is deleted when the plugin is uninstalled from the last place it is installed, unless you used `--keep-data`. Claude Code keeps it in a few cases, for example when another plugin shares the folder or its install records cannot be read. The whole plugins folder, data folders included, moves if `CLAUDE_CODE_PLUGIN_CACHE_DIR` is set. A `handoff_dir` you chose belongs to you and is never removed. Claude Code may keep old plugin versions in its own cache for a while. That is its housekeeping, not kit data.

## Uninstall a copy-by-hand install

The blocks below remove the kit folder (state, notes, options and the search index go with it), the two skills, the search registration, and the `skills` folder itself when the steps made it and it is now empty. The settings entries and the pasted rules blocks are removed by hand, as the comment lines say. A skill folder is removed only if it is still the kit's copy. The kit folder is removed only if it is named `pocotoko` and holds the marker file the install made, and is not your config folder, your home folder or a folder above either. Otherwise the step says "Left:" and removes nothing.

### Git Bash, macOS and Linux (bash, zsh)

<!-- install-steps:uninstall-bash:start -->
```bash
(
REPO='<REPO>'
CONFIG='<CONFIG>'
KIT='<KIT>'
NODE='<NODE>'
for v in "$REPO" "$CONFIG" "$KIT" "$NODE"; do case "$v" in /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;; *) echo "Stopped: every path must be a full path (no ~ and no relative path): $v"; exit 1;; esac; done
# search-unregister (search, optional): Remove the search server registration.
claude mcp remove --scope user pocotoko-search
# remove-settings (core): Remove the two hooks and the kit's statusLine (either form). Nothing else is changed. A file left holding nothing is deleted only if the marker file says the steps made it. Done by hand in a text editor, in every shell.
# By hand: open $CONFIG/settings.json in a text editor and delete the two kit hooks and the kit statusLine. Change nothing else.
# remove-routing-block (core, optional): If you pasted the routing block, delete it, markers included. Done by hand in a text editor.
# By hand: if $CONFIG/CLAUDE.md holds the block from $REPO/src/core/templates/rules-block.md, delete it, markers included.
# remove-search-block (search, optional): If you pasted the search block, delete it, markers included. Done by hand in a text editor.
# By hand: if $CONFIG/CLAUDE.md holds the block from $REPO/src/search/templates/rules-block.md, delete it, markers included.
# remove-skill-model-routing (core): Delete the model-routing skill, only if it is still the kit's copy.
if [ -d "$CONFIG/skills/model-routing" ]; then if [ "$(ls -A "$CONFIG/skills/model-routing" | wc -l | tr -d ' ')" = "1" ] && cmp -s "$REPO/src/core/skills/model-routing/SKILL.md" "$CONFIG/skills/model-routing/SKILL.md"; then rm -rf "$CONFIG/skills/model-routing"; else echo "Left: $CONFIG/skills/model-routing (not removed: the steps did not make it, it is not the kit copy, or it is not empty)."; fi; fi
# remove-skill-handoff (core): Delete the handoff skill, only if it is still the kit's copy.
if [ -d "$CONFIG/skills/handoff" ]; then if [ "$(ls -A "$CONFIG/skills/handoff" | wc -l | tr -d ' ')" = "1" ] && cmp -s "$REPO/src/core/skills/handoff/SKILL.md" "$CONFIG/skills/handoff/SKILL.md"; then rm -rf "$CONFIG/skills/handoff"; else echo "Left: $CONFIG/skills/handoff (not removed: the steps did not make it, it is not the kit copy, or it is not empty)."; fi; fi
# remove-skills-folder (core): Delete the skills folder, only if the steps made it and it is now empty.
if [ -d "$CONFIG/skills" ]; then if [ -f "$KIT/.pocotoko-kit" ] && grep -qx 'created skills' "$KIT/.pocotoko-kit" && [ -z "$(ls -A "$CONFIG/skills")" ]; then rmdir "$CONFIG/skills"; else echo "Left: $CONFIG/skills (not removed: the steps did not make it, it is not the kit copy, or it is not empty)."; fi; fi
# remove-kit (core): Delete the kit folder (state, notes, options and the search index go with it), only if it is named pocotoko, holds the marker file, and is not the config folder, the home folder or a folder above either.
if [ -d "$KIT" ]; then
  k=$(cd "$KIT" 2>/dev/null && pwd -P | tr '[:upper:]' '[:lower:]'); c=$(cd "$CONFIG" 2>/dev/null && pwd -P | tr '[:upper:]' '[:lower:]'); h=$(cd "$HOME" 2>/dev/null && pwd -P | tr '[:upper:]' '[:lower:]')
  if [ "${k##*/}" = "pocotoko" ] && [ -f "$KIT/.pocotoko-kit" ] && [ "$(head -n 1 "$KIT/.pocotoko-kit")" = "pocotoko kit folder" ] && case "$c/" in "$k"/*) false;; *) true;; esac && case "$h/" in "$k"/*) false;; *) true;; esac; then rm -rf "$KIT"; else echo "Left: $KIT (not removed: it is not a kit folder these steps made)."; fi
fi
)
```
<!-- install-steps:uninstall-bash:end -->

### PowerShell (Windows without Git Bash)

<!-- install-steps:uninstall-powershell:start -->
```powershell
& {
$REPO = '<REPO>'
$CONFIG = '<CONFIG>'
$KIT = '<KIT>'
$NODE = '<NODE>'
foreach ($v in @($REPO, $CONFIG, $KIT, $NODE)) { if ($v -notmatch '^(?:[A-Za-z]:[\\/]|[\\/])') { Write-Output "Stopped: every path must be a full path (no ~ and no relative path): $v"; return } }
# search-unregister (search, optional): Remove the search server registration.
claude mcp remove --scope user pocotoko-search
# remove-settings (core): Remove the two hooks and the kit's statusLine (either form). Nothing else is changed. A file left holding nothing is deleted only if the marker file says the steps made it. Done by hand in a text editor, in every shell.
# By hand: open $CONFIG/settings.json in a text editor and delete the two kit hooks and the kit statusLine. Change nothing else.
# remove-routing-block (core, optional): If you pasted the routing block, delete it, markers included. Done by hand in a text editor.
# By hand: if $CONFIG/CLAUDE.md holds the block from $REPO/src/core/templates/rules-block.md, delete it, markers included.
# remove-search-block (search, optional): If you pasted the search block, delete it, markers included. Done by hand in a text editor.
# By hand: if $CONFIG/CLAUDE.md holds the block from $REPO/src/search/templates/rules-block.md, delete it, markers included.
# remove-skill-model-routing (core): Delete the model-routing skill, only if it is still the kit's copy.
if (Test-Path -LiteralPath "$CONFIG/skills/model-routing" -PathType Container) { if ((@(Get-ChildItem -LiteralPath "$CONFIG/skills/model-routing" -Force).Count -eq 1) -and (Test-Path -LiteralPath "$CONFIG/skills/model-routing/SKILL.md" -PathType Leaf) -and ((Get-FileHash -LiteralPath "$REPO/src/core/skills/model-routing/SKILL.md").Hash -eq (Get-FileHash -LiteralPath "$CONFIG/skills/model-routing/SKILL.md").Hash)) { Remove-Item -LiteralPath "$CONFIG/skills/model-routing" -Recurse -Force } else { Write-Output "Left: $CONFIG/skills/model-routing (not removed: the steps did not make it, it is not the kit copy, or it is not empty)." } }
# remove-skill-handoff (core): Delete the handoff skill, only if it is still the kit's copy.
if (Test-Path -LiteralPath "$CONFIG/skills/handoff" -PathType Container) { if ((@(Get-ChildItem -LiteralPath "$CONFIG/skills/handoff" -Force).Count -eq 1) -and (Test-Path -LiteralPath "$CONFIG/skills/handoff/SKILL.md" -PathType Leaf) -and ((Get-FileHash -LiteralPath "$REPO/src/core/skills/handoff/SKILL.md").Hash -eq (Get-FileHash -LiteralPath "$CONFIG/skills/handoff/SKILL.md").Hash)) { Remove-Item -LiteralPath "$CONFIG/skills/handoff" -Recurse -Force } else { Write-Output "Left: $CONFIG/skills/handoff (not removed: the steps did not make it, it is not the kit copy, or it is not empty)." } }
# remove-skills-folder (core): Delete the skills folder, only if the steps made it and it is now empty.
if (Test-Path -LiteralPath "$CONFIG/skills" -PathType Container) { if ((Test-Path -LiteralPath "$KIT/.pocotoko-kit" -PathType Leaf) -and (@(Get-Content -LiteralPath "$KIT/.pocotoko-kit") -contains 'created skills') -and (-not (Get-ChildItem -LiteralPath "$CONFIG/skills" -Force))) { Remove-Item -LiteralPath "$CONFIG/skills" -Force } else { Write-Output "Left: $CONFIG/skills (not removed: the steps did not make it, it is not the kit copy, or it is not empty)." } }
# remove-kit (core): Delete the kit folder (state, notes, options and the search index go with it), only if it is named pocotoko, holds the marker file, and is not the config folder, the home folder or a folder above either.
if (Test-Path -LiteralPath "$KIT" -PathType Container) {
  $k = (Resolve-Path -LiteralPath "$KIT").ProviderPath.TrimEnd('/', '\') + '\'
  $held = @("$CONFIG", $env:USERPROFILE, $env:HOME) | Where-Object { $_ } | ForEach-Object { Resolve-Path -LiteralPath $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.ProviderPath.TrimEnd('/', '\') + '\' }
  $m = Join-Path $k '.pocotoko-kit'
  if (((Split-Path -Leaf $k.TrimEnd('\')) -eq 'pocotoko') -and (Test-Path -LiteralPath $m -PathType Leaf) -and ((Get-Content -LiteralPath $m -TotalCount 1) -eq 'pocotoko kit folder') -and -not ($held | Where-Object { $_.StartsWith($k, [System.StringComparison]::OrdinalIgnoreCase) })) { Remove-Item -LiteralPath "$KIT" -Recurse -Force } else { Write-Output "Left: $KIT (not removed: it is not a kit folder these steps made)." }
}
}
```
<!-- install-steps:uninstall-powershell:end -->

## Troubleshooting

- **See whether the hooks are loaded:** run `/hooks` in a session.
- **See why something did not start:** start Claude Code with `claude --debug` and read what it logs about the hook or the server.
- **No meter warnings:** check the sizes (`session-limits.md`), and look for a one-line "saves nothing" message at session start. It names the cause: a config folder inside a git repo, a local-folder install, or an unset plugin data folder.
- **"Node is running from inside this project folder":** run Node from outside the project.
- **A copy-by-hand step says "Stopped":** read the line. It says what exists already, and nothing was changed. Fix the cause, then run the block again from a clean state.
- **After you move or upgrade Node:** a copy-by-hand install keeps the old full path. Edit the path in your settings file, and in the search registration if you use it.
- **The search tool is missing or search says it is off:** call `status`; its reason line says why. See `search.md`.
- **Plugins, hooks and MCP servers load at session start.** Start a new session after you change any of them.

## Not yet proven

These are open. Nothing here is stated as fact.

- **PENDING:** Claude Code itself starting the real search server. The live checks used small stand-in servers. They showed how options reach a plugin's server, that such a server is given the folder the session started in, and that a planted `node` program did not run for a launch by `node`. Whether a never-set option with no default blocks the launch has not been seen. The server fails safe: with no `projects` value, search stays off.
- **PENDING:** a list option set through the interactive `/plugin configure` form. In the checks, a list stored as one comma-separated line or as JSON-array text reached a plugin's server as stored; a list set through the interactive form has not been seen there. See `search.md`. Until this and the next item are proven, keep sensitive files out of enabled projects, or use the `search: do not index` line.
- **PENDING:** when you change some options with `claude plugin configure`, whether the options you did not name are kept has not been seen. If they were dropped, a never-list could stop narrowing. Until this and the interactive form are proven, keep sensitive files out of enabled projects, or use the `search: do not index` line.
- **PENDING:** whether a never-set boolean or number option that has a default (`drop_contacts`, `max_file_bytes`) blocks the search server, and what text arrives. The checks applied only a text default.
- **PENDING:** whether the plugin cache folder variable (`CLAUDE_CODE_PLUGIN_CACHE_DIR`) reaches the search server when the cache is really moved to another place. In the checks it reached a plugin's server unchanged, but it was set to the default place there.
- **PENDING:** the copy-by-hand step that registers the search server, on a machine with an organisation-managed MCP file. It was refused there. The step's arguments are proven; a run on a machine without that file is still needed.
- **PENDING:** both install forms, and the pinned-version form, run against the host repository.
- **PENDING:** whether a project's own settings can move your config folder into the project. The kit's check for that is in place and tested, but the live behaviour has not been verified.
- **PENDING:** a skill loading inside a live session. Its presence in the plugin's parts list has been checked.
