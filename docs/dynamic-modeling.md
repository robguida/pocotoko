# Dynamic modeling

This page is for readers. It explains the model and effort rules the core plugin ships, and shows how they work on real requests. The rules themselves are short and live in one place, the `model-routing` skill.

## The idea

Every helper call (a subagent call) can name a model and an effort level. If it names neither, the helper follows whatever the main chat uses. That is easy to forget, and it means a small lookup can run on the strongest model while a risky check runs on a weaker one by accident.

The rules ask for one habit: **size the task first, then name the model and effort on the call.** Size by risk, not by how short the request sounds.

## Three sizes

| Size | What it looks like | Tier | Effort |
|---|---|---|---|
| Trivial | Lookups, listings, renames, formatting, one mechanical edit in one file, reading tool or log output | Smallest | low |
| Standard | Features to an agreed design, bug fixes, writing tests, copy edits, routine operations steps | Middle | medium |
| Hard | Design, architecture, work across modules, anything that ends in a recommendation you will act on | Top | high |

A tier is a rung on a ladder, not a product name. The skill holds the one table that maps tiers to model aliases. If the lineup changes, that table is the only thing to edit.

## What is never made smaller

Some work always runs on the top tier at high effort, whatever its size:

- security, privacy and personal data;
- legal and licensing;
- compliance;
- money and pricing;
- steps that cannot be undone (deploy, delete, data migration);
- every check that gives a pass or fail verdict (a test gate, a code review, a scan before a push, a release check);
- the step that combines several results into what you read.

The short form: smaller tiers build, the top tier checks.

## The other rules, in plain words

- **Unsure of the size? Go one tier up.** Large jobs (many files, big diffs) stay off the smallest tier.
- **Raise, never lower.** If a request suggests a model or effort, you may raise it. You may not lower it.
- **Thin or doubtful output gets re-run on the top tier.** Do not patch it by hand. Hand-patching carries the weak parts forward.
- **Gather cheap, decide strong.** A step that only fetches may run on a smaller tier. The reasoning, and anything you read, comes from the top tier.
- **Lower the effort before you lower the tier,** for the mechanical parts of judgment work.
- **The two highest effort levels are by request only.** Use them when you ask, or when the caller says why.
- **Do not switch the main chat's model or effort mid-session.** A model switch rebuilds the prompt cache, and an effort change does too on most models. Send that work to a helper call instead. See `docs/prompt-cache.md`.
- **Give your own agent files a model line,** so they do not quietly follow the main chat.

## Built-in helpers are not smaller by default

The built-in helpers follow the main chat's model unless a call says otherwise. The Explore helper uses the main chat's model, and when the main chat runs on the highest alias it uses the next one down. Plan and general-purpose inherit the main chat's model. So name the model on these calls as well.

Which model a call really uses is settled in this order: the call's own setting, then the agent file's `model` line, then the `CLAUDE_CODE_SUBAGENT_MODEL` variable, then the main chat. That variable on its own does not move Explore or Plan. A second variable, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, forces one model on every helper and makes per-call models ignored. To see what ran, use `/tasks` while helpers work: each row shows the model and effort. The version floors for these are in the skill text. The source is the vendor's subagent docs: https://code.claude.com/docs/en/sub-agents.md

## Worked examples

| You ask for | Size | Call it with | Why |
|---|---|---|---|
| A list of the files that mention one setting | Trivial | smallest, low | Retrieval; easy to check |
| A rename of one function inside one file | Trivial | smallest, low | Mechanical |
| A new field on a form, design already agreed | Standard | middle, medium | Feature work, design settled |
| Tests for a finished module | Standard | middle, medium | Routine; the tests get checked afterwards |
| A review of a diff before it merges | Hard | top, high | It gives a pass or fail verdict |
| A choice between two storage designs | Hard | top, high | Ends in a recommendation you act on |
| A scan for leaked keys before a push | Hard | top, high | Security, and a verdict |
| Reading a long log to find the failing line | Unsure | one tier above trivial | Large input stays off the smallest tier |

Two small cases in prose:

- *"Change the wording on a button."* A copy edit: Standard.
- *"Change the rounding on a price."* It looks smaller, but it touches money: Hard, whatever the line count.

## How the rules reach Claude

The same text arrives three ways:

1. **The skill.** Claude loads it before a helper call or a model choice.
2. **A block at session start.** The session-start hook adds the short block to each new chat. It is prefixed with one line saying that if your own rules file already sets model and effort rules, yours win. Turn this off with the `routing_rules_at_start` option.
3. **A block you paste.** `src/core/templates/rules-block.md` holds the same block, between two marker lines, for your own `CLAUDE.md`. If your user-level `CLAUDE.md` already holds the start marker, the hook does not add the block a second time.

The skill sets no model and no effort of its own. A skill that did would switch the model for that turn, and a switch rebuilds the cache.

## Common slips

- Sizing by how short the request sounds.
- Leaving the model off a built-in helper call.
- Switching the main chat to a smaller model for one step.
- Lowering a suggested model or effort.
- Patching thin output instead of re-running it.
- Using the highest effort levels by habit.
