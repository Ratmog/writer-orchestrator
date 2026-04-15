# Writer Orchestrator Reference (Project Memory)

Last updated: 2026-04-05

This file is a short, durable context dump so future sessions can continue work without re-deriving the setup.

## Goal

Build a local-first, multi-agent writing workstation for fanfic:
- Run multiple CLI agents side-by-side (Claude Code, Codex CLI, Gemini CLI, Cursor CLI) plus a plain shell.
- Show exactly what they are doing (visible terminals, logs).
- Maintain a canon database (from your EPUBs) to ground writing and reviews (RAG-style search, but local).
- Provide an editor + canon chapter reader + inline annotations.
- Add an automation layer: one-click workflows like "write -> review -> fix" with task queue + transcript logging.

Key constraint: no model APIs. The app launches local CLIs in PTYs.

## Repo Layout

Workspace root: `/Users/srikarravella/Desktop/claude_story`
- `writer-orchestrator/`: Tauri v2 app (React+TS frontend, Rust backend).
- `CLAUDE.md` and other writing docs live at workspace root and are used as role context for automation.

App project: `/Users/srikarravella/Desktop/claude_story/writer-orchestrator`
- `src/App.tsx`: "Shadow Forge" UI shell + terminals + editor + reader + DB UI.
- `src/components/MarkdownEditor.tsx`: CodeMirror markdown editor + lint gutter annotations.
- `src-tauri/src/lib.rs`: PTY spawning, workspace FS ops, draft watcher, DB tool invocations, automation primitives.
- `tools/`: local canon DB utilities (EPUB ingest, chunking, Chroma search).

## How To Run (Dev)

From `writer-orchestrator/`:
```bash
PATH=/opt/homebrew/bin:$PATH npm install
PATH=/opt/homebrew/bin:$PATH npm run tauri dev
```

Notes:
- The `PATH=/opt/homebrew/bin:$PATH` prefix matters on this machine to prefer Homebrew tools.
- Frontend builds with `PATH=/opt/homebrew/bin:$PATH npm run build`.
- Backend check: `cd src-tauri && cargo check`.

## Agents

Default agents are defined in Rust and also persisted to a user config file:
- Config dir: Tauri `app_config_dir()`
- `agents.json`: list of `{id,label,command,args}`
- `workspace.json`: last used workspace root

Default agent ids (used throughout UI):
- `claude`, `codex`, `gemini`, `cursor`, `shell`

`shell` defaults to `zsh -l` so it behaves like a normal terminal.

## UI (Current)

Theme: "Shadow Forge" (dark, 3-pane)
- Left: agents list + workspace tree
- Middle: terminal tabs (xterm.js sessions)
- Right: panel tabs
  - `Editor`: markdown draft editor + inline annotations (from `drafts/annotations.json`)
  - `Reader`: canon chapter browser + chapter text (loaded from Chroma via `db_search`)
  - `DB`: query search results view
  - `Outline`: read-only view of `drafts/outline.md` (auto-reloads if written)

Command palette: `Cmd/Ctrl+K` (minimal set of commands right now).

## Drafts + File Watching

Backend watches:
- `${workspaceRoot}/drafts/**`

On change:
- If the active draft file changes, editor auto-reloads it.
- If `drafts/annotations.json` changes, annotations reload.
- If `drafts/outline.md` changes, outline reload.

## Canon Database (Local)

ChromaDB persistent store:
- Default path: `.writer_orchestrator/chroma` relative to workspace root
- Override:
  - CLI flag `--db-dir`
  - env var `WRITER_ORCH_DB_DIR`

Tools live in: `/Users/srikarravella/Desktop/claude_story/writer-orchestrator/tools`
- `ingest_epub.py`: parse EPUB -> paragraphs -> chunk -> upsert into Chroma
- `db_search.py`: semantic query OR browse by chapter
- `db_list_chapters.py`: list available chapter numbers + titles
- `chunking.py`: paragraph-aware chunker
- `requirements.txt`: Python deps (Chroma, sentence-transformers, ebooklib, bs4, lxml)

Important: embeddings are computed locally via `sentence-transformers` (no API).

## Automation Layer (Phase 4 Status)

Backend primitives exist in `src-tauri/src/lib.rs`:
- `AutomationTask` storage
- queue (`task_queue`) + runner thread (`start_runner_if_needed`)
- capture markers:
  - agent must output JSON between:
    - `BEGIN_RESULT <task_id>`
    - `END_RESULT <task_id>`
- transcript logging:
  - each PTY session writes to `${workspaceRoot}/logs/agent-<agent>-<session>.log`
- role context loader:
  - reads workspace files like `CLAUDE.md`, `.codex`, `.cursorrules`, etc and prepends them to automation prompts

Automation UI is NOT built yet (no task list panel, no queue controls, no one-click workflow buttons wired).

## Known Issues / TODO (High Signal)

1. Automation file-writing safety check likely breaks new file writes.
   - `ensure_within_root()` canonicalizes the target path; canonicalize fails if file doesn't exist.
   - Affects `maybe_write_result_files()` when writing a new `drafts/chX.md`.
   - Fix: validate path lexically (join + normalize) against canonicalized root, without requiring target to exist.

2. `start_runner_if_needed()` currently calls `spawn_agent_terminal(...)` directly (works), but Phase 4 still needs:
   - task list UI
   - preset workflow graph ("write -> review -> fix")
   - per-agent working dir tweaks (if desired)
   - output watcher to trigger next task automatically based on completion

3. UI polish: tree twisty icon is functional but could be cleaner; outline panel is read-only.

## Recent Stabilization Fixes (2026-04-05)

- Restored draggable vertical split between terminal pane and right panel in the new Shadow Forge layout.
- Fixed potential command-palette stale closure bug so actions always use current app state.
- Improved agent initialization so missing default agents (including `shell`) are merged into existing `agents.json` automatically.
- Fixed path safety for writes that create new files:
  - Added lexical root-bounded path resolver for write paths.
  - `fs_write_file` now supports creating new nested files under workspace safely.
  - Automation result writer no longer fails when target file does not already exist.

## Startup Behavior (Updated 2026-04-05)

- First launch workspace setup:
  - App now checks whether `workspace.json` has a valid configured folder.
  - If not configured, a blocking setup overlay appears and requires selecting/entering a workspace.
  - On macOS, `Browse` uses native folder picker via `osascript`.

- Automatic agent startup:
  - On startup, app probes CLI availability for each configured agent command.
  - If available, it auto-starts `claude`, `codex`, and `gemini` terminals.
  - If availability probing fails, app falls back gracefully and still loads.

## Stability Test Checklist (Manual UI)

Run in order after `npm run tauri dev`:

1. First-launch workspace gate:
   - Delete/rename `workspace.json` in app config dir and relaunch.
   - Confirm setup overlay appears and blocks normal UI actions.
   - Use `Browse` and `Use Folder`; overlay should close and tree should load selected folder.

2. Agent auto-start:
   - On startup with configured workspace, verify `claude`, `codex`, `gemini` auto-open terminals when installed.
   - Verify unavailable agents are marked `Not installed` and are not auto-started.

3. Terminal basics:
   - Switch tabs, type in active terminal, confirm output appears.
   - Kill and restart one agent from tab controls.

4. Workspace tree + editor:
   - Open a draft file from tree.
   - Edit and save; file content should persist.
   - External draft change should auto-reload in editor.

5. Reader + DB:
   - `Reader` -> `Browse` chapter index, then load a chapter.
   - `DB` search query should return hits when DB exists.

6. Outline + annotations watcher:
   - Update `drafts/outline.md` and `drafts/annotations.json` externally.
   - Verify UI panels update automatically.

## Copyright / Scraping Note

Canon ingestion is designed around your owned EPUB files. Avoid scraping copyrighted chapters from random sites; it can violate site ToS and copyright. For fanfic you control or public-domain content, ingestion is typically fine but still respect hosting ToS.
