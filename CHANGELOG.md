# Changelog

## 0.10.1 · 2026-11-24

- **The handoff toast fits on one line.** Pressing `w` says `Handoff saved · /clear, then paste (copied)`; the path and the copied line were cut off. `/side-context handoff` still prints both.

## 0.10.0 · 2026-11-24

**New: a context strip above the prompt**

- One row over the prompt shows the verdict, the share of the window in use, the meter with the limit marked on it, and the room left, so the context can be watched without the pane taking a column. **Details** opens the pane; **Compact** joins it near the limit.
- Desktop app: the strip is where the context shows, and the pane no longer opens by itself; it opens from **Details**. Terminal: the strip draws the pane's own bar, and steps aside while the pane is docked.
- With the pane closed, the breakdown is still read on each response while the strip shows, so its parts never go stale.

**Desktop app: the meter**

- The limit is a pin through the bar, standing out above and below it, with 0 and the window on either side. Parts past the limit keep their colours; the room past it is fainter, window better not reached.
- The summary leads with the room left before the limit (`186.0k left before the 250.0k quality limit`), then this session's figures, then the plan's on a line of its own.
- The meter holds still while a turn runs, unless the context moves 2% of the window or 20 seconds pass, so the desktop does not reload its frame on every step.

**Desktop app: the pane's layout**

- The verdict leads with its share of the limit it is read from (`66% of 250k`), not of the window, so the figure and the advice under it agree. The meter still spans the whole window.
- The next step says what its button does (`Writes a note a fresh session starts from`).
- Only the summary is framed; the other groups are flat sections under a hairline.
- In context splits the conversation from the setup loaded at start, with the setup's parts under its sum.
- Biggest outputs shows the tool, then what it ran on; only the row Guard acts on and guarded rows carry a mark, so no colour there reads as a part of the meter. The guard's advice shows without the pointer, as does a flagged row's fix.
- One **Show all** (`e`) at the foot opens every group; collapsed groups say what they leave out (`+3 more · 11.2k`). The MCP and skill lists say when they hold only the largest few (`11.3k of 18.1k`).
- The plan's limits sit at the foot as short bars, apart from this session's figures. **Count exactly** is now **Exact count**.
- A narrow pane keeps every name and figure readable: a row's dim detail and a section's note give way before the name, the room line wraps rather than cutting off, and plan bars wrap with even gaps.
- Every row of a group keeps its mark's column, so names line up whether a row is marked or not. Setup's square is striped with its parts' colours, and its parts hang from a line drawn down from it, as do the rows of Memory files, Largest MCP tools and Largest skills.
- The actions at the foot sit side by side with a small even gap, wrapping on a narrow pane. The guard's target carries its mark alone, without a long note under it.
- The plan's 5h and 7d limits are the pane's footer, at its bottom edge once the first response reports them. Each bar is blue, orange from 50% and red from 80%, on a faint track of its own colour.
- The bar is drawn in the page's own boxes, which redraw in place: it no longer blinks with every response. The lens shows only under the pointer.
- Every part on the meter can be read under the lens, even a sliver thinner than a column.

**Terminal: the pane in the desktop pane's terms**

- Setup's parts hang from a tree line (`├─`, `└─`), each with its own colour, and every In context row shows its share beside its size.
- "Top context eaters" is "Biggest outputs": the tool, then what it ran on, dim. A guarded row is a green ✓ with "guarded"; the long "x guards ▸" note is gone, the ▸ alone marks the target.
- The next step reads as the desktop's ("Compact before answers slip", "Hand off before it gets tight"), with what the press does dim after it.
- The plan's 5h and 7d limits are bars at the foot, blue, orange from 50% and red from 80%, rather than figures on the cache line.
- The expanded lists hang from a tree line too, and "Loaded MCP tools" is "Largest MCP tools".

**Windows**

- Paths with backslashes or a drive letter are shown short, and a guard matches them whatever their case or slashes.
- The resume list finds past sessions from `USERPROFILE` when there is no `HOME`, and next to a backslashed transcript path.
- CI runs on Linux, macOS and Windows.

**Fixes**

- **A pane whose tab you shut opens again.** Closing the pane's tab without the engine hearing of it left **Details** and `/side-context` thinking it was open; they now go by what you see.
- **Scrolling up from the bottom of the pane lets go of the end.** A slow wheel up, a row at a time, was pulled back to the bottom.
- **The cache countdown follows Claude Code's own cache setting.** `cacheTtl: auto` now reads `promptCacheTtl` and `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` and `ENABLE_PROMPT_CACHING_1H` (from the shell or a settings file's `env`), in Claude Code's own order. Before, it guessed from the plan alone.
- **A subscription past its plan limit counts down five minutes.** Once a 5h or 7d window is used up the session draws on usage credits, where Claude Code gives the main conversation the five-minute cache; the countdown said an hour.
- **A guarded read is sized as the eaters are.** Whether a file has shrunk below the guard's floor was judged at four bytes a token, so accented, non-Latin and CJK text read smaller than it is, and a guarded file could slip through.

**Docs**

- The README names the requirement as Claude Code mods, on by default from 2.1.287 (desktop app 2.1.286), describes the strip, lists everything the mod hooks in your session, and compares it with other context mods.

## 0.8.3 · 2026-10-25

**Desktop app: a lens over the meter**

- The swell under the pointer now reaches the neighbours, as it was meant to: each column's clip sat between the columns, so only the one under the pointer ever grew. It rises on a bell curve over thinner columns, so it reads as one smooth bulge rather than steps, and settles back with a soft spring.
- A glass lens rides on the stretch under the pointer and glides with it; the bar beyond the swell dims, so the part in focus stands out.
- The reading shows at once in a dark tag beside the lens (`● Skills  2.5k`), on whichever side has room and never over the swell, instead of a system tooltip after a delay. A part past the limit says `· over the limit`; free room past it no longer does.
- The latest turn's stretch is an opaque, lighter tint of the conversation green, matching its dot; *Count exactly* sits quietly at the foot while sizes are estimates instead of taking the next-step slot.

## 0.8.2 · 2026-10-22

- Desktop app: the context bar is twice as thick (20px), its ends fully round; the swell under the pointer grows it less tall (1.6×, was 2.4×) so the meter takes little more room, and as much wider as before.

## 0.8.1 · 2026-10-22

**Desktop app: the meter magnifies under the pointer**

- Hovering the context bar swells it as the macOS Dock does: the stretch under the pointer grows wider and taller, its neighbours less so, the rest moves aside, so a part of a pixel or two (the system prompt, Skills, MCP) reads at a glance. No click; it settles back when the pointer leaves.
- Resting the pointer names what is under it and its size (`Conversation 280.9k`), and says when that stretch is past the limit.

## 0.8.0 · 2026-10-20

**Desktop app: the pane rebuilt for the page**

The desktop app (and every surface but the terminal) draws the pane as HTML in a proportional font. The terminal layout, sized in counted cells, ran past the pane's edge there and read as a wall of text. Those surfaces now get a layout of their own (`hooks/pane-web.tsx`); the terminal pane is unchanged.

- **One fact per row.** In context and Biggest outputs list a dot in the part's colour, the name, the size and its share (`Conversation  14.9k  23%`), the numbers flush right at any width. No advice lines under the rows: a row's fix shows under the pointer.
- **The meter is the whole window.** The summary is the verdict (`● Healthy`) and the share of the window in use; a slim rounded meter spans the window (1M on a 1M plan, as the host's own bar does), each part in its colour, the latest turn a lighter stretch of the conversation, and the quality limit (or auto-compact) a separator on it; past it the parts keep their colours under a faint red veil. Under it `64.0k of 1.0M window`, then `┃ Quality limit 250.0k · 186.0k left`, then the turn's growth, the cache and the plan limits on one quiet line.
- **A colour per part.** Built-in tools blue, MCP tools orange, the conversation green, the system prompt amber (the host's own hues), Skills violet, MCP instructions pink, Memory teal: the dot of each In context row matches its stretch of the meter.
- **One next step.** When there is something to do, a few words and one primary button (`Sizes are estimates` · **Count exactly**, `Compact keeps your goal and decisions` · **Compact**); otherwise nothing. The other actions sit at the foot as secondary buttons; Guard only when there is something to guard.
- **No alarms from estimates.** Only the exact count flags a row (its size in red); an estimate shows plain sizes, marked `~` on the total.
- **Show more where it applies.** Each card shows its biggest rows (six, three for outputs) and opens the rest with its own *Show N more*, which also brings in Memory files, MCP tools and Skills.
- Neutral frames: colour is kept for the data and the status dot.

**Fixes**

- Compacting from the pane in the desktop app, whose session is headless, runs `/compact` as if typed; the keep-list is still added.

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
