# Changelog

## 0.6.1 · 2026-10-14

**Fixes**

- **`/resume` shows the resumed conversation.** After a `/resume` the pane read the context before the resumed conversation was in place: it showed only the setup (`39.8k`, conversation `0.1k`) and offered to pick up a past session. Its next turn then counted the whole resumed conversation as that turn's growth (`+513.7k`), so the bar was all setup and turn, with no conversation part to match the In context card. The pane now starts over once the resumed conversation is in, takes its fill from the transcript (as the status line does) until the first response reports one, and counts the first turn from there. The cache countdown starts from the transcript's last response, and a cache that has gone cold is not warned about again.
- A reading still in flight when `/clear` or `/resume` replaced the conversation is dropped, not written over the new one.

## 0.6.0 · 2026-10-13

**New**

- **Next step.** A line above the buttons says what to do now, read from the state: pick up a past session in a new one, time to compact, `?` rows to count exactly, or, while the context fills, a guard or a handoff. Its button is drawn at full strength and the rest dim.
- **Guard target on its row.** `▸` marks the eater `x` would guard, and the line under the list says what the press does (`next time Claude is asked to read a range`). Once it is guarded, the mark moves to the next row. With nothing to guard, the button stays in place, dim, and a press says why.
- **One bar for the window, the limit marked on it.** The window bar and the room-left track are one bar now, as long as the window, so its end reads as the window's end. `┃` marks the quality limit (or auto-compact) on it: the track up to the mark is the room you have, the pale `░` past it is window you should not need, and the line under the bar says how much is left before the mark, or how far past it the context is (`50.0k over`). The bar is split by what can be done about each part: setup (trimmed in settings), the conversation (`c` and `w`) and what the latest turn added, at its growing end, in the colour of the `+` figure; a key under it names them, and each part of 1k or more has a cell, small as it is on a 1M window. The cells are solid, the parts told apart by colour, so the bar no longer reads as stripes; the cache, plan-limit and cost figures sit a row below it, apart from the bar's key. Ten categories in `/context`'s colours were a cell or less each on a large window, and the compact reserve read as part of the fill.
- **Share of the conversation.** Each top context eater shows how much of the conversation it is (`~3.7k  35%`).

**Changes**

- **In context** leads with the conversation, the part that grows and the one `c` and `w` act on. What was loaded at the start follows under its sum, each part beneath it, biggest first. The two marks are the bar's colours, so the card is the bar's key in full. The card's title carries the total, and every size is in thousands (`407` is `0.4k`), so the column lines up.
- **Top context eaters** lists only calls over a hundredth of the budget (1k at least): 2.5k on a 250k budget. With none that big, the card says so and gives the biggest. `x` guards from the same list, so it never guards a row you cannot see.
- **Actions** are a toolbar at the pane's foot, under a rule rather than in a frame, so the room above reads as the pane's own. The buttons read `c: compact`, without brackets in brackets. The footer is just `Estimate · 12:04` or `Exact count · 12:04`.
- Cards keep their title as a row of their own, so a renderer that draws a frame edge thinner than a text row does not lay it over the card above.

**Fixes**

- The pane moves with every response of a turn, not only once the turn ends. Claude Code reports usage to plugins at a turn's end, so a turn of twenty tool calls held the figures, the breakdown and the eaters where they stood when it began. The `+` figure is how far the running turn has grown the context, counted from where it began, and starts from nothing with each turn.
- A turn that runs past the cache lifetime no longer warns that the cache went cold while it runs: every request of the turn keeps the cache warm, and the countdown starts again from each.
- A Bash eater names every command of a chain: `cd … && ls && git diff` is `ls && git diff`, not `ls`, which made the cheap command look like the one that printed most. A pipe's later stages (`| tail`) stay unnamed.
- Redirects are read as such: `npm test 2>&1` was `npm test && 1`, and `> out.log` or `&> out.log` no longer shows the log file as the command's input. A guard set on a command with `2>&1` before this version will not match it again; guard it once more.

**Desktop app**

- The pane fits the desktop app's proportional font: the bar and the numbers no longer wrap onto a row of their own, numbers stay flush right, and the cards stand apart. The bar is one row there.

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
