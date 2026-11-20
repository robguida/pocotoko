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
