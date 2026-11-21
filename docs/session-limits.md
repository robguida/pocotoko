# Session limits

This page covers the chat-length meter, the status line and the hand-off note. All three are in the core plugin, `pocotoko`.

## Why long chats are a problem

Each prompt you send re-sends the whole chat so far. A long chat therefore makes every later turn carry more, and the model has to work through more. Past a point, Claude Code compacts the chat for you, which rewrites it into a shorter form. A clean stop and a fresh session, with a short note about where you were, is often a better reset than waiting for that.

The meter exists to tell you when you are getting there. It is a warning, not a gate. It never blocks a prompt.

## What "size" means

Size is the number of tokens in the context right now, including what is read back from the cache. It is not a running total of the session.

- **Status line:** it reads a field Claude Code supplies, the current context size.
- **Prompt hook:** Claude Code gives hooks no size field, so the hook reads the chat's transcript file from the end, takes the newest main-thread reply that has usage numbers, and adds three counts: plain input, cache writes and cache reads. Both give the same number.
- The transcript can lag a turn behind. The meter accepts that.
- After a compaction or `/clear`, the size drops and the meter re-arms.

## The tiers

| Size | Tier | What you see |
|---|---|---|
| Below the soft size | Quiet | Nothing from the hook. The status line is green. |
| From the soft size up | Soft | One plain warning line, once. The status line turns yellow and reads "getting long". |
| From the hard size up | Hard | A warning to finish the step and start a new session, plus a hand-off note request. The status line turns red and reads "NEW SESSION NOW". |

The comparison uses the exact count, never the rounded number on screen. "At or above" applies everywhere. Past the hard size the hook warns again every `repeat_every_tokens` more tokens, unless that is 0, which means once. The status line is a passive display: it redraws as needed, has no once-only rule, and never writes to disk. With `NO_COLOR` set it prints no colour codes.

The status line reads `chat 50k (warn 100k/150k)`: the size, then the two warning sizes. Before the first reply it has no size, and reads `chat -- (warn 100k/150k)`.

## Options

Plugin install: set these with `/plugin configure`. Copy-by-hand: edit `meter-config.json` in the kit folder's `config` folder. The keys and defaults are the same.

| Key | Default | What it does |
|---|---|---|
| `soft_tokens` | 100000 | First warning. A whole number of at least 10000. |
| `hard_tokens` | 150000 | New-session warning, and the hand-off note. A whole number of at least 20000, above the soft size. |
| `repeat_every_tokens` | 50000 | Past the hard size, warn again every this many tokens. 0 means once. |
| `handoff_note` | true | At the hard size, ask for a hand-off note. |
| `handoff_dir` | empty | A folder of your own for notes. Empty uses the kit's default. |
| `routing_rules_at_start` | true | Add the model and effort rules block to each new session. |

An option that is wrong (not a whole number, under its minimum, or a soft size at or above the hard size) is not used: the built-in defaults apply, and you are told once per session.

**If you change Claude Code's own compaction window.** You can set that window as low as 100,000 tokens, which is below the default hard size. If you do, lower both `soft_tokens` and `hard_tokens` to match. With no setting, the default models compact near the top of a very large window, and some setups compact at the 200,000 boundary. The defaults sit below both. If you have a large window and like long chats, you may raise both values.

## Hand-off notes

A hand-off note lets you start fresh without losing the thread. It is at most 25 lines: the work in flight, the exact next step, the key files, and the open decisions. It never holds secrets, keys, passwords or personal data.

**Where notes go.** The default folder is `handoff` inside the kit's state folder: the plugin data folder for a plugin install, the kit folder for copy-by-hand. Code creates it, owner-only on macOS and Linux. If you set `handoff_dir`, it must be an absolute path to a folder that already exists. It must not be inside your current project, inside any git work tree, or inside your Claude config folder (a note there could be read as a command or a setting). On Windows it must not be a network or device path (one that starts with `\\` or `//`), or go through a link that points to one: just checking such a path would connect to that computer. The kit reads each link on the way without following it, so that check itself connects to no other computer, except through a drive letter you mapped to a share. It cannot rule out a link that is changed in the moment between that check and the folder being opened. To keep notes on a network share, map it to a drive letter first. If any of these applies, the kit says so once and uses the default instead.

**File name.** `<date and time>-<folder>-<session>.md`, using local time. The folder part is the name of the folder the session started in, and the session part is the first 8 characters of the session id, both cut down to letters, digits, `_` and `-`.

**Two ways a note gets written, with different guarantees:**

1. **At the hard size (enforced by code).** The meter creates a new, empty note file first, and names its exact path to Claude. Claude writes into that file only. Because the file is new, no earlier note can be overwritten.
2. **When you run the `handoff` skill yourself.** Claude writes the file using its own file tool. A note written when you run the `handoff` skill yourself follows the skill's text; code does not enforce it. The skill says to pick a new name if one is taken and never to overwrite a note, but nothing stops a mistake. The folder is still owner-only on macOS and Linux.

Notes can hold work details. Keep them out of repos and out of synced folders.

If the session-start hook gave no folder (for example in one of the "saves nothing" cases below), the skill prints the note in the chat instead. Start a new session and paste it as your first message.

## The status line

A plugin cannot set the status line, so you add it yourself.

**Plugin install.** Run the `meter-statusline` skill. It shows the exact lines first, writes only your user-level settings file, only after you say yes, and backs that file up first. It never replaces a status line you already have. After the write, it prints how to undo it. The write follows the skill's steps; code does not enforce it. After you move or upgrade Node, run the skill again to see the new line, then swap the old entry by hand.

**Copy-by-hand.** The settings lines are in `docs/install.md`, in the section "The settings lines". They add the two hooks and the status line to your user-level settings file. You do this by hand in a text editor.

**Two forms, by shell.** The status line setting is one command string with no separate arguments, run through a shell. On Windows that is Git Bash, or PowerShell when Git Bash is not installed.

- Git Bash, macOS and Linux: `'<NODE>' '<path to meter.cjs>' --statusline`
- PowerShell on Windows without Git Bash: `& '<NODE>' '<path to meter.cjs>' --statusline`. In PowerShell a line that starts with a quoted path is read as text, so the call operator `&` is needed.

Write every path with forward slashes, and keep both paths in single quotes. A single quote inside a path is written `'\\''` in the settings file for the Git Bash form (that is the JSON text for the shell's `'\''`), and `''` for the PowerShell form. `<NODE>` is the full path of your Node program, never a bare `node`.

Some editor panels do not draw a custom status line. The terminal does.

**Showing the cache state too.** The status line input also carries a `prompt_cache` object. The kit's line does not show it. If you want it, write a small status line script of your own that reads that field. The vendor's status line page lists what it holds: https://code.claude.com/docs/en/statusline.md

## When the kit saves nothing

In some setups the core writes no files at all, and says why once per session, as a line at session start. The meter then gives no tier warnings (the status line still shows the size) and no note file is made.

- **Your Claude config folder is inside a git repo.** For example, a home folder kept as a repo. Move the config folder out of the repo to turn the meter and notes on.
- **A local-folder install.** The plugin runs from its source folder, a developer install. Install from a git source, or copy by hand.
- **The plugin data folder is not set** during a plugin install. Nothing is saved that session.

**Config folder inside the project you opened (copy-by-hand install).** If you start Claude in your own config folder, or in a dotfiles repo that holds it, the routing skill file sits inside the current project. The kit does not read a skill file from inside the project, so it adds no routing block and prints this line at the start of every session there: "Routing rules were not added at session start: the model-routing skill file is inside the current project, so it was not read." The reason: a repo that could point your config folder into itself would otherwise put its own text into the chat as if it were the kit's rules. Open a different folder, or accept the line. Whether a project's own settings can move your config folder this way has not been checked. The same holds when the skill file sits anywhere inside a git repo, even if you opened a different folder of that repo; then the line is: "Routing rules were not added at session start: the model-routing skill file is inside a git repo, so it was not read." A home folder kept as a git repo does not count for this check, except where the system has no account entry for you (some containers): then the kit cannot tell where your home folder is, so it does count and the line appears. **If you keep your config folder in git on purpose** (for example as its own dotfiles repo), the line means only that the kit would not take its rules from a file in a repo. To get the rules and stop the line, paste the routing block (`src/core/templates/rules-block.md` in the repo, the optional copy-by-hand step) into your own `CLAUDE.md` in the config folder, markers included: the kit then sees the block there and adds nothing itself. Or keep the repo at your home folder, which is not counted.

**Node inside the project.** If the Node program itself sits inside the project folder, the kit acts on nothing and says so. Run Node from outside the project. The self-check catches a stray but genuine Node only; it can never stop a planted program. See `docs/install.md`.

## When the meter cannot read the chat

The prompt hook reads a transcript file whose format belongs to Claude Code and can change between versions. If the file is at least 256 KiB, a reply already exists, and no usable usage record can be read, the hook says once per session: "chat-length meter cannot read this chat's format; it is off for this session". It never blocks. The status line keeps working, because it uses a documented field and not the transcript.

To check your own setup, run the meter with `--selftest` and a transcript path. It prints counts and the size found, never any text.

## Notes

- **Where hook options come from.** In plugin mode the hooks read their options from environment variables Claude Code sets, and the status line reads a copy of the options written at session start. In copy-by-hand mode all three read `meter-config.json`. The same values give the same tier everywhere.
- The meter and the session-start hook use only Node built-ins, make no network calls, start no other programs, and always exit cleanly.
