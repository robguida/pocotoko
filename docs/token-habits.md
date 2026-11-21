# Token habits

An optional page. It collects everyday habits that keep a chat lean and a session easy to steer. It describes mechanisms only, with no figures.

The habits here are drawn from the vendor's own guide to managing usage and cost: https://code.claude.com/docs/en/costs.md. This page is written in the kit's own words and order. Read the vendor's page for the full detail and for anything that changed after this page was written.

The one idea behind all of it: every prompt re-sends what the chat already holds, plus whatever is loaded alongside it. Habits that keep that pile small and tidy help every later turn.

## 1. Keep the chat lean

- **Start a new chat for a new task.** `/clear` drops the old conversation. Leftover talk about an earlier task is carried on every turn, and it can also pull the model's attention the wrong way.
- **Steer compaction.** When a chat has to be compacted, you can say what matters in the compaction instructions, so the summary keeps the parts you still need.
- **Look at what is loaded.** `/context` shows what is taking up room. It is often a surprise.
- **Hand off at a clean stop.** On a long chat, write a note and start fresh, rather than resume a cold and very long chat. The chat-length meter and the hand-off skill in this kit are built for that. See `session-limits.md`.

## 2. Keep standing instructions short

- **Keep `CLAUDE.md` short.** It is read into every session. Long files are carried on every turn, and long instructions are followed less well than short ones.
- **Move rarely needed instructions into skills.** A skill's body loads only when it is used, so an occasional procedure does not need to sit in the standing text.

## 3. Keep tool overhead down

- **Prefer deferred tools.** When tool search defers tool definitions, only names load at the start and the full definitions arrive on demand.
- **Use command-line tools where they exist.** A tool you already run from a shell needs no extra tool definition loaded beside the chat.
- **Turn off servers you are not using.** Each MCP server that loads up front adds its tool definitions to every request. Remember that changing this in the middle of a chat can rebuild the cache. See `prompt-cache.md`.
- **Code intelligence plugins can help** when you do a lot of navigating through code, because the answer comes back as a precise reference instead of a long file read.

## 4. Match the worker to the work

- **Choose the model for the task, not once for the session.** Small, mechanical jobs do not need the strongest model. Risky or judgment-heavy work does. The rules in `dynamic-modeling.md` turn this into a habit.
- **Mind the thinking and effort settings.** A higher setting is for hard problems. Leave it lower for plain ones.
- **Send verbose work to a helper.** A helper does its reading in its own chat and returns a short result, so the main chat does not carry the whole trail.

## 5. Work in small, checked steps

- **Be specific.** A precise request needs less back-and-forth than a vague one.
- **Plan first when the job is big.** Plan mode lets you agree on the approach before anything is changed.
- **Correct early.** If the direction is wrong, say so at once. A long run on the wrong path is carried in the chat afterwards.
- **Give the work a way to be checked.** A test to run, an output to compare, an expected result. Then both of you can tell when it is done.
- **Test in small steps,** so a failure points at a small change.

## 6. Long test or log output

Long output from a test run or a log fills the chat with lines nobody needs. You can shorten it yourself before Claude reads it, for example by running the command so that it prints only failures, or by writing the full output to a file and reading only the part that matters. The kit does not shorten output for you. A tool that trims output can hide the one line that mattered, so choose what to trim yourself.
