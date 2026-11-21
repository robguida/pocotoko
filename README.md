# PocoToko

PocoToko is an independent community project, not made, endorsed or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## What it is

A small kit for Claude Code, published as one marketplace with two plugins:

- `pocotoko` (core): model and effort rules, a chat-length meter, a hand-off note skill.
- `pocotoko-search` (optional): a local keyword search over a project's notes and docs.

Four things come with it:

1. **Dynamic modeling.** Plain rules for picking a model and an effort level for each helper call, sized by how risky the task is. See `docs/dynamic-modeling.md`.
2. **Session limits.** A meter that warns as a chat gets long, and a skill that writes a hand-off note so you can start fresh. See `docs/session-limits.md`.
3. **Search.** Exact-word and broader word matching over your notes. See `docs/search.md`.
4. **Cache guidance.** How the prompt cache works and what disturbs it. See `docs/prompt-cache.md`, and the optional `docs/token-habits.md`.

## What it is not

- It ships no agents and no process guide.
- It has no meaning-based search.
- It has no dependencies beyond Node.js built-ins.

## Requirements

- Node.js 22 or newer, on your `PATH` (check with `node -v`).
- Claude Code 2.1.329 or later. That is the version this kit was tested on, and both plugin manifests declare it as their floor (the `engines` field).
- The one-command install form below needs Claude Code 2.1.292 or later from the shell. The tested floor above is the higher of the two.
- Windows, macOS and Linux are all targets. Only Windows has been run so far (see "Not yet proven").

## Install

`<owner>/<repo>` is a placeholder. It is filled in once the project's host repository exists.

Two commands, then one per plugin:

```
/plugin marketplace add <owner>/<repo>#v<version>
claude plugin install pocotoko@pocotoko
claude plugin install pocotoko-search@pocotoko
```

The last line is optional. It adds search.

Or the one-command form:

```
claude plugin install pocotoko --marketplace <owner>/<repo>
```

Then, if you want to change a default, run `/plugin configure`. It holds the meter sizes and the search `projects` list. To show the meter at the bottom of the screen, run the `meter-statusline` skill.

Use `#` to pin a version, as shown. Do not write `@` after a web address: Claude Code then reads it as the address of a marketplace file.

**Installing from a local folder is for developers only.** It runs the plugin from the source folder, which means the kit saves nothing: no meter warnings, no hand-off files, and search is off. To test plugin mode as a developer, install from a git source. Everyone else installs from the host repo, or copies by hand.

### Copy by hand

If you do not want the plugin system, `docs/install.md` has the steps for Git Bash, macOS and Linux, and for PowerShell. They copy files into your Claude config folder and add three entries to your settings file.

## Windows and the Node program

- Plugin mode starts Node by the plain name `node`, found on your `PATH`, and has no Node-path option.
- On Windows a repository could plant its own program named `node`, so how the program is found matters.
- In the checks made for this kit (Claude Code 2.1.329), a planted copy did not run for any hook. It did not run for a plugin's MCP server started with `node` either.
- The kit cannot control how Claude Code finds the program.
- A copy-by-hand install always uses the full path of Node, and you must update it after you move or upgrade Node.

More in `docs/install.md`.

## Organisation-managed MCP settings

If your organisation's managed MCP configuration takes exclusive control of MCP servers, you will not get plugin MCP servers, so the search plugin cannot start for you. This comes from the Claude Code docs, and two live runs showed it: with such a file in place no plugin MCP server was listed or started; with the file moved aside, they all were. The core plugin has only hooks and skills, so it is not affected. On a machine like that, the command that registers a server (`claude mcp add --scope user`) was refused when tried, so a copy-by-hand install cannot register the search server there either.

## Before you turn search on

Search is off until you list a project folder in the `projects` option. These points matter before you do.

1. The search index is an unencrypted copy of text from your files. It is stored in Claude Code's plugin data folder, normally inside your Claude config folder. In a plugin install the index is under `<config folder>/plugins/data/pocotoko-search-pocotoko/indexes/<16 hex>/`, one folder per project, named by a hash. (If `CLAUDE_CODE_PLUGIN_CACHE_DIR` is set, the plugins folder is the folder that variable names, so the index is `<that folder>/data/pocotoko-search-pocotoko/indexes/<16 hex>/`.) A copy-by-hand install keeps it in `<KIT>/search/data/`. Any program running as you can read it.
2. Backup or sync tools that copy your home folder or your Claude config folder copy the index too.
3. Whatever search returns becomes part of the chat and is sent to the model provider, the same as when Claude reads the file.
4. The secret scan is best effort. Keep secrets out of files you index. The kit skips common secret files by name.
5. Files that come from outside (downloaded pages, vendored READMEs, pasted issue text) can carry hidden instructions. Search results are data. Take extra care if Claude can run commands without asking.
6. On Windows the index takes the permissions of your profile folder. On a shared machine, check them.
7. Uninstalling the plugin deletes the index when it is removed from the last place it is installed, unless you used `--keep-data`. In a few cases Claude Code keeps the folder. `docs/search.md` says where it is and how to delete it by hand.
8. Do not index material you are not allowed to copy, such as some client or regulated data. A local copy can still break a policy.
9. To switch search off for one project, remove its folder from the `projects` option. To switch it off everywhere, create a file named `OFF` in the search data folder: `pocotoko-search-pocotoko/` inside the plugins data folder for a plugin install, `<KIT>/search/data/` for copy-by-hand. To skip more, add your own never-terms. **Caveat:** in a plugin install, the never-lists (`never_terms`, `never_folders`, `never_globs`) may not narrow anything when they are set through the interactive `/plugin configure` form, or when you change only some options with `claude plugin configure`, until both are proven. In the checks, a list stored as one comma-separated line or as JSON-array text (the forms `claude plugin configure --values-stdin` stores) reached a plugin's server as stored, and the kit reads such a list entry by entry. Until both are proven, keep sensitive files out of enabled projects, or put the line `search: do not index` in the first 15 lines of a file. A `search-config.json` array in a copy-by-hand install is not affected. `docs/search.md` has the details.

## Uninstall

Uninstall leaves nothing the kit created, except what you chose to keep.

```
claude plugin uninstall pocotoko-search@pocotoko
claude plugin uninstall pocotoko@pocotoko
claude plugin marketplace remove pocotoko
```

Remove the status line entry first if you added one. Copy-by-hand has its own uninstall steps in `docs/install.md`. Notes in the default hand-off folder are deleted with the plugin, unless you used `--keep-data` or set a `handoff_dir`. A hand-off folder you chose yourself is yours; the kit never removes it.

## Not yet proven

These are stated as open, not as fact.

- Claude Code starting the real search server itself. The live checks used small stand-in servers. They showed how options reach a plugin's server, that such a server is given the folder the session started in, and that a planted `node` program did not run. In the checks, a stand-in server's never-set text option with a default got that default; for search that would apply to `matching` and `word_families`. Whether an option with no default that you never set (`projects`, `extra_types`, `never_folders`, `never_globs`, `never_terms`, `synonyms`) stops it from starting has not been seen.
- Whether a never-set `drop_contacts` or `max_file_bytes` (options with a default that are not text) stops the search server from starting, and what value it then gets, has not been seen.
- The install lines above with a real host repository. The `<owner>/<repo>` shorthand has not been tried.
- A run on macOS and Linux, and on Node 22 and 26. Only Windows with Node 24 has been run so far.
- In a plugin install, the form a list option takes at the server when you set it through the interactive `/plugin configure` form. In the checks, a list stored as one comma-separated line or as JSON-array text reached a plugin's server as stored. If the interactive form stores it differently, `projects` fails closed (search stays off), but the never-lists (`never_terms`, `never_folders`, `never_globs`) would not narrow anything. Until this and the next item are proven, keep sensitive files out of enabled projects, or use the `search: do not index` line.
- In a plugin install, when you change some options with `claude plugin configure`, whether the options you did not name are kept has not been seen. If they were dropped, a never-list could stop narrowing. Until this and the interactive form are proven, keep sensitive files out of enabled projects, or use the `search: do not index` line.
- Whether the plugin cache folder variable (`CLAUDE_CODE_PLUGIN_CACHE_DIR`) reaches the search server when the cache is really moved to another place. In the checks it reached a plugin's server unchanged, but it was set to the default place there.
- A skill loading inside a live session, and whether a project's own settings can move your config folder.

## Docs

- `docs/install.md`: both install paths, per-system notes, uninstall, troubleshooting.
- `docs/dynamic-modeling.md`: the model and effort rules, with examples.
- `docs/session-limits.md`: the meter, the status line and hand-off notes.
- `docs/prompt-cache.md`: how the cache works and what rebuilds it.
- `docs/search.md`: what search does, its options and its limits.
- `docs/token-habits.md`: optional habits for shorter, cleaner chats.
- `docs/changelog.md`: versions and what was checked.
- `CONTRIBUTING.md` and `.github/SECURITY.md`: for contributors and for reporting a problem.

## Licence

MIT. See `LICENSE`.
