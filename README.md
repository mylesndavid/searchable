# Searchable

Browse and search your [Claude Code](https://claude.ai/claude-code) session history.

A desktop app that reads your `~/.claude/` directory and gives you a visual interface to explore conversations, search across sessions, and see stats on your Claude Code usage.

## Install

### Homebrew (recommended)

```bash
brew install mylesndavid/tap/searchable
```

### Manual download

1. Go to [Releases](https://github.com/mylesndavid/searchable/releases/latest)
2. Download `Searchable_x.x.x_aarch64.dmg`
3. Open the DMG and drag to Applications
4. First launch: right-click the app > Open (macOS Gatekeeper)

### Build from source

```bash
# Prerequisites: Rust, Node.js
git clone https://github.com/mylesndavid/searchable.git
cd searchable
npm install
npm run tauri build
# App will be at src-tauri/target/release/bundle/macos/Searchable.app
```

## Features

**Session Browser** — workspace grid showing all your projects, click to drill into sessions

**Conversation Viewer** — full conversation with markdown rendering, expandable tool calls (diffs, bash output, file reads), thinking blocks

**Search** — `Cmd+K` to search across all sessions. Finds text in user messages, assistant responses, and tool outputs

**Activity Heatmap** — GitHub-style contribution graph built from actual message timestamps

**Stats Dashboard** — total messages, tokens, tool usage breakdown, messages per day chart, model distribution

**Resume Sessions** — copy the `claude --resume` command or launch directly in Terminal

## Requirements

- macOS (Apple Silicon for now, Intel build coming)
- Claude Code installed with session data in `~/.claude/`

## How it works

The Rust backend scans all JSONL files in `~/.claude/projects/`, parses message types (user, assistant, tool calls, tool results), and exposes them via Tauri commands. The React frontend renders conversations with markdown, syntax-highlighted code blocks, and collapsible tool call details.

No data leaves your machine. Everything runs locally.

## Tech Stack

- [Tauri v2](https://tauri.app/) (Rust backend)
- React + TypeScript
- TailwindCSS
- [react-markdown](https://github.com/remarkjs/react-markdown) + remark-gfm
