# Security

## Reporting a problem

Please report a security problem privately, using the host's private vulnerability reporting for this repository. On the repository page, open the Security tab and choose to report a vulnerability. Please do not open a public issue for it, and please do not post details in a pull request.

Include what you saw, the steps to repeat it, and the versions of Claude Code, Node and your operating system.

## What the kit does

- The two core scripts (the chat-length meter and the session-start hook) and the search server use only Node built-ins. They make no network calls, start no other programs and use no code loaded from a computed path.
- The hooks always exit cleanly and never block a prompt.
- The core writes only into its own state folder (and a hand-off folder you choose), and only through checked, link-safe writes. It refuses a folder that is a link, and writes nothing if its state folder is inside a git work tree.
- The search server reads files only from a project you have switched on, never follows links, and skips hidden files, ignored files and common secret files. It scans text for secrets before storing it, and it never writes inside your project.
- The search index lives in the plugin data folder or the kit folder, never inside a project.
- Search results come back as data, inside a marked envelope, with a notice that they are not instructions.

## What the kit does not do

- It does not encrypt the search index. Any program running as you can read it.
- It cannot check Windows file permissions with Node built-ins, so it discloses them instead.
- The secret scan is best effort and will miss things.
- It cannot stop a planted instruction from being read once Claude has read it. If Claude may run commands without asking, such a line has real reach.
- Its Node self-check catches a stray but genuine Node program only. It cannot stop a planted program, because a planted program never runs the kit's code.
- It cannot control how Claude Code finds the program a hook or server starts.

More detail is in `docs/search.md`, `docs/session-limits.md` and `docs/install.md`.
