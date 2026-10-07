# Launch kit

Drafts for announcing cc-side-context. Nothing here is posted yet. Fill in the real numbers from your own session before posting: the posts work because the example is real.

## Before posting

- [ ] Record a 10–15 second GIF: a session where one big read shows up in **Top context eaters**, then `c` compacts and the trend line drops. (macOS: screen recording, then `gifski` to convert. Or [vhs](https://github.com/charmbracelet/vhs).) Put it at the top of the README as `docs/demo.gif`.
- [ ] Take one screenshot of the pane with the eaters list and the cache countdown visible, for X and HN.
- [ ] Note the real top eaters from one of your long sessions, for the posts.
- [ ] Check the function hooks API status. If it is still early access, say so in every post: people who cannot install it get annoyed.
- [ ] Tag a release (`v0.3.0`) so the marketplace install picks up the new version.

## r/ClaudeAI (and r/ClaudeCode)

r/ClaudeAI only lets a showcase post into the feed when your account has 50+ karma. Below that, post in the "Built with Claude" megathread. Post on a weekday morning US time, and answer every comment in the first two hours.

**Title:** I found out a lockfile was eating 60k of my Claude Code context, so I built a pane that shows what fills it

**Body:**

> `/context` kept telling me "Conversation: 320k" and nothing more. So I built a side pane for Claude Code that lists the tool results actually sitting in the window:
>
> ```
> Top context eaters
>   Read package-lock.json ×3      ~61.2k
>   github › get_issue             ~11.4k
>   Bash npm test                   ~9.0k
> ```
>
> Other things it does:
> - **Cache countdown:** `cache 4m`, and a warning when the prompt cache goes cold, before your next message pays for all of it again.
> - **Compaction that keeps your decisions:** `c` compacts with a keep-list (your rules word for word, files changed, rejected approaches, next step). The same list is added to auto-compact.
> - **Handoff:** `w` writes a handoff note from the transcript (no tokens spent) so you can `/clear` and pick up in a fresh session.
> - **Quality budget:** on 1M windows it warns at 250k, not at auto-compact.
>
> `[GIF]`
>
> Install: `/plugin marketplace add bcanozgur/cc-side-context`. It needs a Claude Code build with function hooks (early access).
>
> It's MIT and runs locally. What would you want it to flag?

## Show HN

**Title:** Show HN: See what is filling your Claude Code context window, live

**Body:**

> Claude Code re-sends the whole conversation on every message, so what sits in the context decides both cost and answer quality. `/context` gives you categories. I wanted to know *which* tool results were in there, and when to act.
>
> cc-side-context is a side pane (a Claude Code plugin) that lists the largest tool results still in the conversation, counts down the prompt cache, warns past a quality budget, and compacts with a keep-list so decisions and changed files survive. Everything is computed locally from the transcript. The exact recount uses the same token-count API as `/context`.
>
> Things I learned building it: [2–3 real findings from your sessions, e.g. "repeated reads of one file were 20% of my context"].
>
> https://github.com/bcanozgur/cc-side-context

## X / Bluesky thread

1. `/context` says "Conversation: 320k". It doesn't tell you 60k of that is one lockfile you read 3 times. So I built a live pane for Claude Code that does. `[GIF]`
2. It counts down your prompt cache and warns when it goes cold. That is the moment your next message gets expensive.
3. Press `c` to compact with a keep-list (your rules, changed files, decisions, next step), or `w` to write a handoff note and start fresh.
4. Open source, local, MIT: github.com/bcanozgur/cc-side-context. It pairs with claude-hud: the HUD shows the number, this shows why.

## Where else to list it

- awesome-claude-code style lists on GitHub (open a PR with a one-line entry)
- Claude Code plugin directories and marketplaces (claudelog, skills and plugin indexes)
- The claude-hud discussions, as a companion rather than a competitor
- dev.to / Medium: "What actually fills your Claude Code context" with your own numbers
