# Prompt cache

This page explains how Claude Code's prompt cache works, what disturbs it, and how the kit stays out of its way. It describes mechanisms only.

Each fact carries a tag for its source. The tags are:

- **[CC]** Claude Code's prompt caching page: https://code.claude.com/docs/en/prompt-caching.md
- **[API]** the platform's prompt caching page: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
- **[SL]** Claude Code's status line page: https://code.claude.com/docs/en/statusline.md

These pages change. If one disagrees with this page, the vendor's page is right.

## The picture

Every request re-sends the start of the conversation. The cache lets the provider recognise a start it has seen before, and reuse that work instead of redoing it. A cache hit needs an identical beginning. So the question for any habit is simple: does it change the beginning of the request?

## How a request is built

1. Claude Code handles prompt caching for you, unless you turn it off. [CC]
2. A request is assembled in this order: the system prompt (core instructions and tool definitions), then project context (`CLAUDE.md`, auto memory, unscoped rules), then the conversation. [CC]
3. The cache prefixes are made in the order tools, system, messages. A change at one level invalidates that level and every level after it. [API]
4. The cache belongs to one machine and one folder. Two sessions in different folders build different beginnings and cannot reuse each other's. [CC]
5. Prompts that are very short are not cached. The minimum depends on the model. [API]

## How long it lasts

Two lifetimes exist: 5 minutes, refreshed each time the cache is hit, and 1 hour. [API]

In Claude Code, the main conversation gets the 1-hour lifetime on a Claude subscription, within plan usage. It gets 5 minutes with an API key, with usage credits, or on a cloud provider. Helpers, workflows, forks, compaction and titles get 5 minutes. [CC]

You can choose the lifetime with `promptCacheTtl` or `CLAUDE_CODE_PROMPT_CACHE_TTL` for the main chat, and `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for everything else. The values are `5m` or `1h` on recent builds. `DISABLE_PROMPT_CACHING` turns caching off, and per-model variants exist. [CC]

## What rebuilds the cache

1. **Switching the model in the middle of a chat.** Each model has its own cache. Toggling plan mode with a model change, and an automatic fallback to another model, both count as a switch. [CC]
2. **A skill or command whose frontmatter names a different `model`.** For that turn it is a model switch. [CC]
3. **Changing effort,** on most models. Some of the newest models keep the cache across an effort change with an API key or a subscription, but not on some cloud providers or setups. [CC]
4. **Turning fast mode on or off.** Automatic speed changes count as toggles. [CC]
5. **Changing the thinking setting.** The API page says that this always invalidates message blocks. [API]
6. **Changing the system prompt itself.** Everything after it is invalidated. [CC]
7. **Adding or deliberately removing an MCP server that loads up front.** [CC]
8. **`/compact`.** It rebuilds the conversation layer by design, and re-sends the most when you resume an old, cold session. `/clear` starts a fresh context. [CC]
9. **Upgrading Claude Code.** The cache is rebuilt from the top. [CC]
10. **Many images in one chat.** [CC]
11. **Denying a whole tool by its bare name,** when tool search is off. [CC]
12. **Turning a plugin on or off on purpose,** when that plugin brings MCP servers and tools load up front. [CC]
13. **A permission-mode change under the `opusplan` setting.** It counts as a model switch. [CC]

## What does not rebuild it

1. **Editing `CLAUDE.md` in the middle of a chat.** It is read at session start and held. Reload it with `/clear`, `/compact` or a restart. Nested `CLAUDE.md` files and path rules load on demand. [CC]
2. **MCP servers, when tool search defers tools.** That is the default on supported models. The tool list is fixed from the first request, so connecting or disconnecting does not disturb the cache. [CC]
3. **A plugin's skills, commands, agents, hooks, monitors and themes.** None of these invalidate it. A plugin's MCP servers follow the MCP rules above. [CC]
4. **Switching the output style,** on recent builds. [CC]
5. **Editing repo files, changing permission mode (except under `opusplan`), invoking skills, and starting a helper.** [CC]
6. **Helpers.** They do not share the main chat's cache, and the main chat's cache is unaffected by them. A fork inherits and reads the parent's cache. [CC]
7. **Resuming.** The conversation is re-sent, and any unchanged beginning still inside its lifetime is reused. [CC]
8. **`/recap` and `/rewind`.** [CC]

## Habits that follow

- Set up your tools, plugins, MCP servers and rules before you start a session. Batch configuration changes between sessions.
- Pick the main chat's model and effort at the start. Send simpler work to helper calls instead of switching the main chat. See `docs/dynamic-modeling.md`.
- At a clean stop on a long chat, write a hand-off note and start fresh, rather than resume a cold and very long chat. See `docs/session-limits.md`.

## How this kit fits

- The core plugin's hooks and skills are plugin parts, which never invalidate the cache. [CC]
- The `model-routing` skill sets no model and no effort, so loading it is not a switch. This is tested.
- The block added at session start is fixed for the whole session.
- The search server is a plugin MCP server, so it follows the MCP rules above. Install and enable it before you start a session.
- The status line input carries a `prompt_cache` object. [SL] `docs/session-limits.md` says how to read it if you want it shown.
