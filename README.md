# cc-side-context

A live context-window breakdown in a side pane for [Claude Code](https://claude.com/claude-code). It shows what fills your context while you work, without having to run `/context` again and again.

![cc-side-context pane beside a Claude Code session](docs/screenshot.png)

## What it shows

- **Usage at a glance:** tokens used out of the window, a coloured bar per category, and how far you are from auto-compact.
- **Health badge:** `Healthy`, `Filling` (half way to auto-compact) or `Near compact` (80%).
- **Per-category rows:** system prompt, built-in tools, MCP tools, memory files (CLAUDE.md, rules), skills, conversation, compact reserve and free space. Tool schemas that load on demand are listed separately, because they are not in the window.
- **Change per turn:** how many tokens the last turn added.
- **Warnings for oversized rows:**
  - `? May be larger than usual`: the row is over its usual size in the quick local estimate. Press `r` to check it.
  - `* Larger than usual`: the exact count confirms it. A one-line fix is shown under it, for example "Disable unused servers in /mcp".
- **Storage view:** the same grid and category list that `/context` draws (⛁ ⛀ ⛶ ⛝).

## Install

```text
/plugin marketplace add bcanozgur/cc-side-context
/plugin install cc-side-context@cc-side-context
```

Restart Claude Code. The pane opens with every new session.

It needs a Claude Code build with function hooks (plugin `hooks/register.tsx` modules), 2.1.29x or newer. That API is in early access and may change between releases.

## Use

| Command | Effect |
| --- | --- |
| `/side-context` | Toggle the pane |
| `/side-context on` / `off` | Show or hide it |
| `/side-context full` | Show it with an exact count |

Buttons at the bottom of the pane:

| Button | Key | Effect |
| --- | --- | --- |
| `storage` / `list` | `s` | Switch between the `/context` grid view and the list view |
| `files` / `less` | `e` | Show or hide the largest memory files, loaded MCP tools and skills |
| `info` | `h` | Explain what each row is |
| `exact` | `r` | Recount with the token-count API, as `/context` does |
| `✕` | `x` | Hide the pane for this session |

### Estimate vs. exact

After each turn the pane refreshes from a free **estimate**: no API calls, computed locally. That estimate can be well off for some rows, tool schemas most of all. So an estimate only raises a question (`?`). Only an **exact** count (`r`, or the storage view) flags a row as too large (`*`).

The storage view keeps using the exact count while it is open, so it matches `/context`. Each refresh in that view sends token-count requests, like `/context` does.

## Develop

```text
hooks/register.tsx   the hooks module: command, refresh, pane drawing
types/index.d.ts     state contract and snapshot types
tests/               claude plugin test suite
```

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .   # load the working copy into a session
```
