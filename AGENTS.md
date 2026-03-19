# Claude Session Browser

VS Code / Cursor extension that shows Claude Code sessions from all projects in a single sidebar panel.

## Status: Paused

Created as a proof-of-concept for [anthropics/claude-code#34985](https://github.com/anthropics/claude-code/issues/34985). Waiting for Anthropic to implement cross-project session browsing natively. Not actively developed.

## Overview

- Reads session `.jsonl` files from `~/.claude/projects/*/`
- WebView-based sidebar panel with search, project filter, time grouping
- Status indicators (closed/open/active/awaiting review) via process detection
- Inline rename, delete, resume actions
- Session restore across editor restarts
- Works in both VS Code and Cursor

## Build

```bash
npm install
npx tsc -p ./
npx @vscode/vsce package --no-dependencies
```

## Install

```bash
# VS Code
code --install-extension claude-session-browser-0.1.0.vsix

# Cursor
cursor --install-extension claude-session-browser-0.1.0.vsix
```

## Architecture

```
src/
  extension.ts          # Entry point, registers commands
  webviewProvider.ts    # WebView panel (HTML/CSS/JS), all UI logic
  sessionReader.ts      # Reads ~/.claude/projects/*/*.jsonl, parses metadata
  sessionStatus.ts      # Detects running claude processes for status dots
  sessionTreeProvider.ts # Legacy TreeView (unused, kept for reference)
resources/
  icon.svg              # Activity bar icon (24x24, monochrome)
  icon-large.svg        # Marketplace icon source (266x266)
  icon.png              # Generated from icon-large.svg via sharp
```

## Session JSONL format (undocumented, reverse-engineered)

- Files: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
- Path encoding: `path.replace(/[^a-zA-Z0-9]/g, "-")`
- Message types: `user`, `assistant`, `custom-title`, `ai-title`, `summary`, `teleported-from`
- Title priority: `customTitle` > `aiTitle` > first user message
- Sidechain sessions have `"isSidechain":true` in first line
