# PocoToko
Poco (Spanish for "little") + Toko ("token").

See when a Claude Code chat is getting long, then carry the exact next step into a fresh session with a short hand-off note.

PocoToko is an independent community project, not made, endorsed or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Quick start

- Node.js 22 or newer, on your `PATH` (check with `node -v`).
- Claude Code 2.1.329 or later. That is the version this kit was tested on, and both plugin manifests declare it as their floor (the `engines` field).

Run this in your terminal to install the core plugin:

```sh
claude plugin install pocotoko --marketplace robguida/pocotoko
```

After installing, open Claude Code in your project. To show the optional chat-length meter at the bottom of the screen, run `/pocotoko:meter-statusline`.

Before leaving your current session, run `/pocotoko:handoff` to create a hand-off note. Then open a fresh session. If the note appeared in chat, paste it as your first message. If Claude saved the note to a file, ask Claude to read it using the path shown in the previous session.

Example status line and hand-off note:

```text
chat 112k getting long (warn 100k/150k)

Work in flight: Added validation to the import form.
Next step: Run the import tests and check the error for an empty file.
Key files: src/import.js, tests/import.test.js
Open decision: Confirm the empty-file message with the maintainer.
```

Both terminal methods for installing the core plugin from GitHub were verified with clean Claude Code 2.1.329 profiles on Windows. The automated tests and checks have run on Windows, macOS and Linux, each on Node 22, 24 and 26.

### Add the marketplace separately

To add the marketplace first and choose a plugin separately, run these commands in your terminal:

```sh
claude plugin marketplace add robguida/pocotoko
claude plugin install pocotoko@pocotoko
```

To pin a published tag, append `#` and the tag to the marketplace source. The one-command install form needs Claude Code 2.1.292 or later from the shell. PocoToko's version requirement is listed above.

### Clone the source or copy by hand

Clone the repo to inspect the code, contribute or follow the [copy-by-hand install steps](docs/install.md#copy-by-hand):

```sh
git clone https://github.com/robguida/pocotoko.git
```

**Installing from a local folder is for developers only.** It runs the plugin from the source folder, which means the kit saves nothing: no meter warnings, no hand-off files, and search is off. To test plugin mode as a developer, install from a git source.

## What comes with it

- **Core:** Chat-length warnings, the hand-off skill, rules for choosing a model and effort for helper calls, and prompt cache guidance. See [session limits](docs/session-limits.md), [model and effort rules](docs/dynamic-modeling.md) and [prompt cache guidance](docs/prompt-cache.md).
- **Optional search:** Local keyword search over project notes and docs, with exact and broader word matching. See [search options and limits](docs/search.md).

PocoToko has no dependencies beyond Node.js built-ins. It ships no agents or process guide.

### Add optional search

After adding the marketplace, install search from your terminal:

```sh
claude plugin install pocotoko-search@pocotoko
```

Read [Before you turn search on](#before-you-turn-search-on) before listing folders in the `projects` option. In Claude Code, `/plugin configure` opens the plugin settings for the meter or search. Start a new session after changing plugin settings.

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
