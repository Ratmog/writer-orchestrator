# Functional + Security Audit (April 16, 2026)

## Test execution summary

### Executed checks
1. `npm run build` (frontend build and typecheck path) — **PASS**.
2. `cargo test` in `src-tauri` — **BLOCKED in environment** (missing system `glib-2.0.pc` for `glib-sys`).
3. `python3 tools/db_search.py --help` — **PASS** (CLI entrypoint loads).
4. `python3 tools/db_list_chapters.py --help` — **PASS** (CLI entrypoint loads).
5. `npm audit --omit=dev` — **BLOCKED in environment** (registry audit endpoint returned HTTP 403).

## Functional coverage map (code-path inspection + runnable checks)

### Frontend
- Startup invokes backend health and workspace commands (`list_agents`, `get_workspace_status`, `list_agent_availability`).
- Terminal output/exit event listeners are wired and session lifecycle is handled.
- File open/save flows call `fs_read_file` and `fs_write_file`.
- Canon and DB tabs call `db_search` and `db_list_chapters`.
- Automation tab calls enqueue/list commands and subscribes to task updates.

### Backend
- Tauri command surface includes agents, workspace ops, filesystem ops, DB bridge, terminal PTY ops, and automation queue.
- Automation runner waits up to 600s for marker-bounded JSON capture.
- Draft watcher emits `workspace://file_changed` events.

## Hidden bugs and reliability risks found
1. **Potential write-escape through symlinked workspace subpaths** (security issue): fixed in this change by rejecting symlink path components for write targets.
2. **Automation task completion may be brittle for CLIs that require explicit submit keystrokes** (timeout path remains possible).
3. **Reader chapter reconstruction is naive concat of chunks, with hard `k: 9999` cap** (very long chapter edge cases).
4. **Rust backend test/check loop is difficult to run on clean Linux machines without GTK/GLib dev packages**.

## Security notes
- Added symlink-path rejection in write path to prevent accidental writes outside workspace root through symlink traversal.
- Existing read/list operations already canonicalize target and enforce root boundaries.

## Recommended next hardening
1. Add preflight diagnostics in UI for Python/DB/system deps.
2. Add agent-specific "submit strategy" abstraction for automation prompts.
3. Add integration tests around filesystem command boundaries and automation marker capture.
4. Add dependency scanning in CI for Rust + npm + Python.
