# Install

This page is a frame. Its full text arrives with the docs stage. The blocks between the markers are written by `node scripts/copy-by-hand.mjs --render` from `docs/install-steps.json`; do not edit them by hand.

## Copy by hand

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

## Uninstall a copy-by-hand install

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
