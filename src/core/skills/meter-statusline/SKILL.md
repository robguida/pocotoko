---
name: meter-statusline
description: Set up the chat-length meter as the status line. Run it yourself when you want the meter shown at the bottom of the screen; it shows the exact settings lines first and changes nothing without your yes.
disable-model-invocation: true
---

# Status line setup for the chat-length meter

A plugin cannot set the status line by itself, so you add it to your own settings. This skill shows the exact lines, and adds them for you only if you say yes.

Follow these steps in order. This write is done by following these steps; code does not enforce them.

## 1. Find the Node program

Look in this session's start context for the line:

`Node program for the status line command: <absolute path>`

**If that line is missing, do not write anything.** Tell the user to fill in their own absolute Node path (the output of `node -p process.execPath` in a terminal) in the lines below, and to add them to their user-level settings file by hand. Then stop.

Never use a bare `node` as the command: the status line must start with the absolute path from that line.

## 2. Show the lines

The status line copy of the meter is at:

`${CLAUDE_PLUGIN_DATA}/statusline/meter.cjs`

The status line command runs through a shell: on Windows through Git Bash, or PowerShell when Git Bash is not installed; on macOS and Linux through the normal shell.

**Write every path with forward slashes.** Turn each backslash in the Node path and in the meter path into `/` (for example `C:/Program Files/nodejs/node.exe`, or `//server/share/...` for a network path). Node accepts forward slashes on Windows. Never double the backslashes. Keep both paths in double quotes, as shown.

**Pick the form:**

- **Git Bash, macOS and Linux** (the usual case): replace `<NODE>` with the path from step 1.

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"<NODE>\" \"${CLAUDE_PLUGIN_DATA}/statusline/meter.cjs\" --statusline"
  }
}
```

- **PowerShell, only on Windows without Git Bash.** In PowerShell a line that starts with a quoted path is read as text, not run, so the command starts with `&`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "& \"<NODE>\" \"${CLAUDE_PLUGIN_DATA}/statusline/meter.cjs\" --statusline"
  }
}
```

On Windows, check whether Git Bash is installed (for example, the `CLAUDE_CODE_GIT_BASH_PATH` variable is set, or Git for Windows' `bash.exe` is found). **If you cannot tell, show both forms and ask the user which applies.** Show the user the form you picked before anything else.

## 3. Ask, then write only the user-level settings file

- The only file this skill may change is the **user-level settings file**: `settings.json` in the user's Claude config folder (the folder named by `CLAUDE_CONFIG_DIR` when it is set, otherwise `.claude` in the home folder).
- Never write a project's `.claude/settings.json` (it gets committed) or `.claude/settings.local.json`, and never write managed settings.
- **Ask the user for a yes first.** Without a clear yes, change nothing.
- **If the user-level settings file already has a `statusLine` entry, never replace it.** Show the existing entry, say the user can swap it by hand, and change nothing.
- **Back up first.** Before changing the file, copy it to `${CLAUDE_PLUGIN_DATA}/backup/settings-<YYYY-MM-DD-HHmm>.json` (local time). If that backup name exists, add `-2`, then `-3`, and so on before `.json`; **never overwrite a backup.** **If the backup cannot be made, change nothing.** If the settings file does not exist yet, there is nothing to back up.
- Then add the `statusLine` entry and keep every other setting as it was. The result must still be valid JSON.

## 4. Print the undo lines

After the write, print how to undo it:

- Remove the `statusLine` entry from the user-level settings file, or
- copy the backup file back over the settings file: `${CLAUDE_PLUGIN_DATA}/backup/settings-<YYYY-MM-DD-HHmm>.json` (the name you used), or
- if there was no settings file before, delete the settings file.

## Notes

- The status line shows the chat size and the two warning sizes. It reads only its own config copy and never writes to disk.
- Some editor panels do not draw a custom status line. The terminal does.
- After a Node upgrade or move, run this skill again to see the new line, then swap the old `statusLine` entry by hand (the skill never replaces one).
