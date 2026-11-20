---
name: model-routing
description: Load this before making any subagent call or choosing a model or effort. It sizes the task (trivial, standard or hard) and says which tier and effort to pass on the call.
---

# Model routing

The block below is the short rule set. The rest of this page explains it.

<!-- routing-block:start -->
## Model and effort rules for subagent calls
1. Before every subagent call, size the task, then pass a model and an effort on that call.
   - Trivial (lookups, listings, renames, formatting, a one-file mechanical edit, reading tool or log output): smallest tier, effort low.
   - Standard (features to an agreed design, bug fixes, writing tests, copy edits, routine ops steps): middle tier, effort medium.
   - Hard (design, architecture, cross-module work, anything that ends in a recommendation the user will act on): top tier, effort high.
2. Never downgrade, whatever the size: security, privacy and personal data, legal and licensing, compliance, money and pricing, irreversible steps (deploy, delete, data migration), every check that gives a pass or fail verdict, and the step that combines results into what the user reads. These run on the top tier at effort high. Smaller tiers build; the top tier checks.
3. Unsure of the size: go one tier up, model and effort. Large-context work (many files, big diffs) stays off the smallest tier. Size by risk, not by how short the request is.
4. A suggested model or effort may be raised, never lowered.
5. If a smaller tier returns thin, unsure, contradictory or incomplete output, re-run the same task on the top tier. Do not patch it by hand.
6. Gather on a smaller tier, decide on the top tier. Reasoning, and anything the user reads, comes from the top tier.
7. For the mechanical parts of judgment work, lower the effort on the same model before dropping a tier.
8. Use the two highest effort levels (xhigh, max) only when the user asks, or the caller says why in the request.
9. Built-in helpers do not default to a smaller tier. Explore runs on the main chat's model (or the top tier when the main chat runs above it). Plan and general-purpose inherit the main chat's model. Name the model on these calls too.
10. Do not switch the main chat's model or effort mid-session. A model switch rebuilds the prompt cache; an effort change does too on most models. Send the work to a subagent call instead.
11. Give each of your own agent files a model line, so it does not follow the main chat's model. Order of precedence: the call's parameter, the agent file, CLAUDE_CODE_SUBAGENT_MODEL, then the main chat. That variable alone does not move Explore or Plan.
12. Check what ran with /tasks while helpers work: each row shows model and effort. If CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 is set, one model is forced on every subagent and per-call models are ignored.
<!-- routing-block:end -->

## Tier names

Rules above speak of tiers. This table and the notes under it are the only places model names appear; the block names none. So a change in the lineup is a one-table edit.

| Tier | Model alias | Notes |
|---|---|---|
| Smallest | `haiku` | Trivial work |
| Middle | `sonnet` | Standard work |
| Top | `opus` | Hard work, and every check that gives a verdict |

Other aliases exist. `fable` is described in the docs as the model for the hardest and longest tasks; use it as a higher choice only if you opt in. `best` is the same model as `opus` (from v2.1.321). The top tier stays `opus` here.

## Helper models and version floors

- Explore runs on the main chat's model. The one exception: when the main chat runs on the `fable` model, Explore runs on the `opus` model instead. That holds on a subscription, a Console account or a gateway.
- `/tasks` shows each helper's model and effort; it needs version 2.1.242 or later of the CLI.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` needs v2.1.257 or later.

## Why the rules look like this

- A subagent's model is fixed for its whole run. It cannot change mid-task, so the choice is made when the call is made.
- The model on a call is picked in this order: the call's own parameter, then the agent file's `model` line, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main chat's model. Passing it on the call is the only choice that beats every other setting except the force switch.
- A skill that sets its own model switches the model for that turn, and a model switch rebuilds the prompt cache. That is why this skill sets neither a model nor an effort, and why the rules say not to switch the main chat's model or effort.
- Work from a smaller tier that comes back thin is re-run on the top tier, because a patched answer carries the weak parts forward.

## Worked examples

| Request | Size | Tier and effort | Why |
|---|---|---|---|
| List the files that mention a setting | Trivial | smallest, low | Retrieval; the result is easy to check |
| Rename a function across one file | Trivial | smallest, low | Mechanical, one file |
| Add a field to a form, per an agreed design | Standard | middle, medium | Feature work with the design settled |
| Write tests for a finished module | Standard | middle, medium | Routine, and the tests are then checked |
| Review a diff before it merges | Hard | top, high | A pass or fail verdict |
| Choose between two storage designs | Hard | top, high | Ends in a recommendation the user acts on |
| Scan a change for leaked keys before a push | Hard | top, high | Security, and a verdict |
| Read a long log for the failing line | Unsure | one tier up from trivial | Large context stays off the smallest tier |

## Pitfalls

- Sizing by how short the request sounds. A one-line change to a payment rule is Hard.
- Leaving the model off a built-in helper call. It then follows the main chat's model.
- Changing the main chat's model mid-session to a smaller one for a single step. Send that step to a subagent call instead.
- Lowering a model or effort that the caller suggested. Raise only.
- Hand-patching thin output from a smaller tier instead of re-running it.
- Using the two highest effort levels by habit. They are for when the user asks or the request says why.

## Notes

- If your own rules file already sets model and effort rules, yours win.
- The helper-model facts above come from the vendor's subagent docs (https://code.claude.com/docs/en/sub-agents.md). The cache facts come from the vendor's prompt-caching docs (https://code.claude.com/docs/en/prompt-caching.md). Run `/tasks` to see what actually ran.
