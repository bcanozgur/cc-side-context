# Contributing

Thanks for helping. Bug reports with real numbers are the most useful thing you can send: the pane is only as good as its estimates on sessions it has not seen.

## Reporting a bug

[Open an issue](https://github.com/bcanozgur/cc-side-context/issues/new?template=bug_report.md) with:

- `claude --version`, the plugin version (`/plugin` → cc-side-context), your OS and terminal (or the desktop app);
- subscription or API key;
- if you can, the output of `/side-context stats`. It holds no prompt text, but read it before pasting.

A screenshot of the pane next to `/context` helps most when a figure looks wrong.

## Setting up

You need Claude Code 2.1.287 or newer (mods are on by default from there).

```bash
git clone https://github.com/bcanozgur/cc-side-context
cd cc-side-context
claude --plugin-dir .   # a session with your working copy loaded
```

Restart that session to pick up a change. Disable the marketplace install in `/plugin` meanwhile, so the two copies do not both load.

## Before you open a pull request

```bash
claude plugin validate --strict .
claude plugin test .
```

Both run in CI on Linux and macOS.

- **Add a test** for a behaviour you change: `tests/cc-side-context.test.ts` drives the mod through a mocked engine (`engine(on)` at the top), so most changes can be tested without a live session.
- **Terminal and page.** The pane has two layouts: `hooks/pane.tsx` in counted cells for the terminal, and `hooks/pane-web.tsx` for the desktop app and other surfaces. A change to what the pane shows usually belongs in both.
- **Nothing leaves the machine.** Do not add network calls, telemetry or writes outside `.claude/side-context/` and the plugin's store. If a feature needs one, open an issue first.
- **Keep the README honest.** If you change what the mod hooks, update "What it changes in your session".
- Add a line to the top of `CHANGELOG.md` under the unreleased version.

## Where to start

Issues labelled [`good first issue`](https://github.com/bcanozgur/cc-side-context/labels/good%20first%20issue) are small and self-contained. Ideas that would help:

- better labels for MCP tool results in **Biggest outputs**;
- guard advice for more commands (what to pipe through `head`, `jq` or `--quiet`);
- estimates checked against exact counts on real sessions in other languages.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
