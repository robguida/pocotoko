---
name: handoff
description: Write a short hand-off note so a fresh session can pick up the work where this one stops. Use it when the user asks for a hand-off note, or when the chat-length meter names a note file to fill in.
---

# Hand-off note

A hand-off note lets the user start a fresh session without losing the thread. It is short, plain and safe to keep.

## Which case applies

1. **The chat-length meter named a file.** At its new-session warning, the meter creates a new, empty note file itself and names its exact path. Write the note into that exact file and into no other file. Write only if that file exists and is empty. If it holds any text or is missing, write nothing to it and follow "Writing a note on request" below. Do not pick another name for this case and do not create another file. The file is new, so nothing is overwritten.
2. **The user asked for a note.** Follow "Writing a note on request" below.

## Writing a note on request

1. Look in this session's start context for two lines:
    - `Hand-off folder for this session: <folder>`
    - `Hand-off note name for this session: <YYYY-MM-DD-HHmm>-<folder part>-<session part>.md`
2. **If the folder line is missing, print the note in the chat instead of writing a file.** That happens when the kit saves nothing in this setup. Then tell the user: start a new session and paste this note as the first message.
3. Build the file name from the name line: replace `<YYYY-MM-DD-HHmm>` with the local date and time, zero-padded (for example the 5th of January at 03:05 gives `-01-05-0305` after the year). Keep the rest of the name exactly as the line gives it.
4. The name rules, in case the name line is missing but the folder line is there: `<YYYY-MM-DD-HHmm>-<folder>-<sid>.md`. The folder part is the name of the folder this session started in, and the session part is the first 8 characters of the session id (or `session` if you do not know it). Cut each part down to the letters A to Z and a to z, the digits 0 to 9, `_` and `-`; turn every other run of characters into one `-`; trim `-` from both ends. The folder part is at most 40 characters and the session part at most 8. A part that is empty after cleaning becomes `session`. The whole name is at most 80 characters before `.md`.
5. **If a file with that name already exists, pick a new name:** add `-2`, then `-3`, and so on up to `-9`, before `.md`. **Never overwrite a note.** If all of those are taken, print the note in the chat instead.
6. Write the note into that new file in the hand-off folder, and nowhere else.
7. Then give the user one line: start fresh and read `<full path of the note>`.

This on-request path follows these instructions; code does not enforce the name or the no-overwrite rule. The note written at the meter's warning goes into a file the meter created new.

## What goes in the note

- At most 25 lines.
- The work in flight: what was being done, and how far it got.
- The exact next step.
- The key files, by path.
- The open decisions, and who makes them.
- **Never secrets, keys, passwords, tokens or personal data.** Name the file a secret lives in instead, if it matters.

Notes can hold work details. Keep them out of repos and out of synced folders.
