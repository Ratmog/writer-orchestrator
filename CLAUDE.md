# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This App Is

Writer Orchestrator is a local-first, multi-agent writing workstation built with Tauri v2 (Rust backend) + React + TypeScript frontend. It runs multiple CLI agents (Claude Code, Codex CLI, Gemini CLI, etc.) side-by-side in real PTYs, with a markdown draft editor, canon chapter reader (ChromaDB RAG), and an automation task queue. No model APIs — all agents are spawned as local CLI processes.

## Commands

**Development**
```bash
# Must prefix PATH on this machine so Homebrew tools take precedence
PATH=/opt/homebrew/bin:$PATH npm run tauri dev
```

**Frontend only**
```bash
PATH=/opt/homebrew/bin:$PATH npm run build   # tsc + vite build
PATH=/opt/homebrew/bin:$PATH npm run dev     # vite dev server only
```

**Rust backend check**
```bash
cd src-tauri && cargo check
```

**Canon DB tools** (Python, run from `tools/`)
```bash
pip install -r tools/requirements.txt
python tools/ingest_epub.py <epub_file>          # ingest EPUB into ChromaDB
python tools/db_search.py "<query>"              # semantic search
python tools/db_list_chapters.py                 # list available chapters
```

## Architecture

### Frontend (`src/`)
- `App.tsx` — "Shadow Forge" UI shell. Three-pane layout: left sidebar (agent list + workspace file tree), center (xterm.js terminal tabs), right panel (Editor / Reader / DB / Outline tabs). Holds most global state via Zustand.
- `components/MarkdownEditor.tsx` — CodeMirror 6 markdown editor with lint gutter for inline annotations loaded from `drafts/annotations.json`.

### Backend (`src-tauri/src/lib.rs`)
All Tauri commands are defined here. Key areas:
- **PTY management** — spawns agent CLIs into `portable_pty` sessions; streams output to frontend via Tauri events (`terminal_output`). Sessions are keyed by UUID stored in a `DashMap`.
- **Agent config** — agents persisted to `agents.json` in Tauri `app_config_dir()`. Default agents: `claude`, `codex`, `gemini`, `cursor`, `shell` (defaults to `zsh -l`).
- **File system ops** — `fs_read_file`, `fs_write_file`, `fs_list_dir` with path safety enforced via lexical root-bounded resolver (does NOT require target to exist — allows creating new files).
- **File watcher** — watches `${workspaceRoot}/drafts/**`; emits reload events to UI when drafts, `annotations.json`, or `outline.md` change.
- **Automation layer** — `AutomationTask` struct, `task_queue` (VecDeque behind Mutex), `start_runner_if_needed()` runner thread. Capture protocol: agent output between `BEGIN_RESULT <task_id>` / `END_RESULT <task_id>` markers is parsed as JSON. Transcripts logged to `${workspaceRoot}/logs/agent-<agent>-<session>.log`. Role context loader prepends workspace files (`CLAUDE.md`, `.codex`, `.cursorrules`, etc.) to automation prompts.

### Canon Database (`tools/`)
ChromaDB persistent store at `${workspaceRoot}/.writer_orchestrator/chroma` (overridable via `--db-dir` flag or `WRITER_ORCH_DB_DIR` env var). Embeddings computed locally via `sentence-transformers` — no API calls.

### Workspace Config
- `workspace.json` — last used workspace root path (in Tauri `app_config_dir()`). If missing or invalid on launch, a blocking setup overlay appears requiring folder selection.
- `agents.json` — agent specs. Missing default agents are merged in automatically on startup.

## Known Issues

1. **Automation UI not built** — backend primitives exist (task queue, runner thread, capture markers, transcript logging) but no task list panel or workflow graph UI yet.
2. **`start_runner_if_needed()`** calls `spawn_agent_terminal()` directly; still needs: task list UI, preset workflow graph ("write → review → fix"), output watcher to auto-trigger next task.
