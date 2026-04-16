# Writer Orchestrator Audit (April 16, 2026)

## What works
- Frontend production build succeeds via `npm run build`.
- Core Tauri backend contains structured commands for PTY sessions, workspace file operations, draft watching, DB tool bridges, and automation task queue.

## High-confidence breakpoints
1. **Rust checks/tests fail in this environment due missing native GLib tooling** (`glib-2.0.pc` not found while compiling `glib-sys`).
2. **Automation backend sends prompts to PTY but does not reliably send the final Enter/agent-specific submit sequence**; tasks can timeout waiting for `BEGIN_RESULT/END_RESULT` markers.
3. **Canon reader is capped at 9,999 chunks and reconstructs chapter text by concatenating chunk text only**, which is fragile for long chapters and context metadata.
4. **Single large frontend bundle (~1.17MB JS before gzip, warning from Vite)** likely hurts startup and memory usage.
5. **Product docs are sparse** (`README.md` is template text), so onboarding and troubleshooting are difficult.

## Product ideas (next roadmap)
- **Workflow Graph 1.0**: drag-and-drop pipeline (write -> critique -> revise -> consistency check), with retries and branch comparison.
- **Continuity Guardrails**: persistent entities/timeline panel that runs diffs against canon + previous drafts and writes inline annotations.
- **Draft Experiments**: branch drafts per scene/chapter with side-by-side semantic diff and "accept chunk" merge.
- **Prompt Packs**: reusable task templates with role presets and expected JSON schemas.
- **Observability Mode**: replayable task timeline, token/time cost approximations, and per-agent reliability scorecards.
- **Offline Publish**: export chapter package (markdown + metadata + change log + citations to canon chunks).

## Suggested execution order
1. Stabilize automation completion protocol (explicit submit behavior per CLI).
2. Improve setup diagnostics (preflight check for Python deps, DB availability, CLI availability).
3. Add code splitting and lazy tab loading.
4. Replace placeholder README with operator-focused docs and quickstart.
5. Ship workflow graph + continuity guardrails as premium UX layer.
