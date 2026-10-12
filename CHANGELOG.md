# Changelog

## 0.5.0 · 2026-10-12

**New**

- `resume [p]`: in a new session, before the first message, the pane lists this project's 5 latest sessions with their names and ages, and a number key resumes one (the same as `/resume`). The button goes away once the conversation starts.

- The pane is laid out in framed cards: the summary, what is in context, top context eaters and the actions, each with its title in the frame. The summary is larger: tokens and percent on a line of their own and a two-row bar. Docked, the actions card sits at the foot of the pane.

**Fixes**

- After a compaction, the handoff note's **Goal** is your first request again, not the compaction summary. The goal is kept per session, so a `/resume` still has it. `/side-context stats` no longer counts the summary as a turn.
- Guards track each call they send back on its own. Before, two guarded reads in one turn (or another guarded call in between) used up each other's retry, and the model could be refused again and again.
- A Bash guard now matches the command itself: `cd /repo && npm  test` and `npm test` are the same guard.
- A guarded read of a file that has since shrunk below ~1k tokens goes through, and the message gives the file's current size.
- A guard that has not sent anything back for 30 days is dropped. A project keeps 50 guards at most.
- `/compact` from the chat redraws the pane at once instead of waiting for the next reply.
- An unknown `/side-context` option now says so instead of toggling the pane. `/side-context help` lists them.
- The pane fills its full width as you drag the divider: numbers and the bar stay on the right edge when it is wide, and nothing spills over when it is narrow.

**Performance**

- The pane no longer holds up the engine after each turn: the breakdown is read in the background.
- In grid view, the exact `/context` recount (token-count API) runs at most once a minute, not after every turn.
- Top context eaters are computed incrementally: each turn reads only the new messages, not the whole transcript.
- Each reading lands as one state write, so the pane redraws once, not once per figure.

**Accuracy**

- Token estimates count accented and non-Latin text (Turkish, Cyrillic, Greek) at ~2 characters a token and CJK and emoji at ~1, instead of 4 for everything. After an exact count (`r`), eater sizes are calibrated against it.
- Labels with CJK characters or emoji keep their numbers right-aligned.

**Handoff**

- `.claude/side-context/` gets its own `.gitignore`, so handoff notes, which hold your prompts, are not committed by accident.
- The previous note is kept as `handoff.prev.md`.

**Internal**

- The pane's drawing moved to `hooks/pane.tsx`.

## 0.4.1 · 2026-10-08

- Every button shows its hotkey: compact [c], handoff [w], guard [x], more [e], grid [s], exact [r].
- `/side-context stats` counts turns from the transcript, so a resumed session reports all of them. Peak, compactions and cold caches are labelled as counted since launch.

## 0.4.0 · 2026-10-08

- `x` guards the biggest eater in this project. A whole read of that file, or that command run without trimming its output, is sent back once with advice on how to make it smaller. Asked again, it goes through.
- `/side-context guards` lists guards, and `/side-context guards clear` removes them.
- `/side-context stats`: current and peak context, turns, compactions, cold caches, and the top eaters' share of tool output, copied to share.
- Bash rows show what the command did (`grep hooks/register.tsx`), not the `cd` and env in front of it.

## 0.3.0 · 2026-10-07

- Top context eaters, compaction with a keep-list, handoff notes, prompt-cache countdown.
