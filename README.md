# Claude Session Browser

VS Code / Cursor extension for browsing Claude Code sessions across all projects in a single sidebar panel.

**Status: Paused** — waiting for Anthropic to implement this natively ([#34985](https://github.com/anthropics/claude-code/issues/34985)).

## Why

Claude Code's VS Code extension shows sessions only from the current project directory. If you work from a central workspace (like an Obsidian vault) and have multiple code projects, sessions from other directories are invisible. You can't see, search, or resume them without switching folders.

We wanted to see all sessions in one place.

## What we built

A sidebar panel that reads `~/.claude/projects/*/` and shows every session from every project:

- **Three view modes**: All Sessions (grouped by time), By Project (collapsible groups), Current Project
- **Search**: filters by session title, then full-text search through JSONL content
- **Project filter**: dropdown to filter by project in All Sessions mode
- **Status indicators**: colored bars showing closed / open / agent working / awaiting review (detected via running `claude` processes)
- **Inline actions**: rename (contentEditable), delete (with confirmation), click to resume
- **Session dedup**: one terminal per session, re-focuses existing terminal on click
- **Session restore**: remembers open sessions across editor restarts
- **Styling**: matches Claude Code's own CSS variables and layout

Works in both VS Code and Cursor.

## What we learned

By reverse-engineering the Claude Code extension (`extension.js` bundle), we found:

- Sessions are stored as `.jsonl` files in `~/.claude/projects/<encoded-path>/`
- Path encoding: `path.replace(/[^a-zA-Z0-9]/g, "-")`
- `SessionHistoryManager.fetchSessions()` reads only one directory — the current project's
- The fix is trivial: add an `allProjects` parameter that reads all subdirectories
- Session metadata: `customTitle` > `aiTitle` > first user message for display title
- Running processes visible via `ps aux | grep claude` with `--resume <session-id>` in args

## The unsolved problem: VS Code terminal management

The biggest blocker we couldn't fully solve is managing Claude Code terminals from an extension.

**What we wanted**: click a session in the sidebar, it opens in a terminal tab (like the official Claude Code extension does). Track which sessions are open, highlight the active one, restore them after editor restart.

**What VS Code gives you**:
- `createTerminal()` + `sendText()` — that's it. You can create a terminal and type into it, but you can't read its output, detect if the process inside exited, or know its current state.
- `onDidCloseTerminal` fires when the terminal tab is closed, not when the process inside finishes. A Claude session that completed still looks "open" to the extension.
- No terminal output API. We can't tell if Claude is thinking, waiting for input, or showing an error. The status indicators (active/awaiting review) rely on `ps aux` process scanning as a workaround — fragile and OS-specific.
- Terminal restore on editor restart is unreliable. VS Code/Cursor may or may not restore terminal tabs. We save open session IDs to `workspaceState` and try to match restored terminals by name, but it's a race condition with timing hacks (`setTimeout 1500ms`).
- No way to rename a terminal after creation. If a user renames a session, we can't update the terminal tab title — we have to orphan it and create a new one on next click.

This is a fundamental limitation of the VS Code Extension API. The official Claude Code extension works around it by using its own WebView-based terminal (not `vscode.Terminal`), which gives full control over I/O. Building that would be reimplementing a terminal emulator — far beyond the scope of a session browser.

## Why we stopped

1. **Anthropic will likely add this natively**. The change to `fetchSessions()` is ~10 lines. We filed [#34985](https://github.com/anthropics/claude-code/issues/34985) with a concrete implementation proposal. Related issues ([#26766](https://github.com/anthropics/claude-code/issues/26766), [#28745](https://github.com/anthropics/claude-code/issues/28745), [#26394](https://github.com/anthropics/claude-code/issues/26394)) show demand.
2. **Fragile foundation**. We parse an undocumented internal format that can change without notice.
3. **Diminishing returns**. The extension works for our use case. Further polish (webview perfection, edge cases) would be effort spent on something Anthropic will replace.

## Install

```bash
# Build
npm install
npx tsc -p ./
npx @vscode/vsce package --no-dependencies

# Install
code --install-extension claude-session-browser-0.1.0.vsix   # VS Code
cursor --install-extension claude-session-browser-0.1.0.vsix  # Cursor
```

## License

MIT
