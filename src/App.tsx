import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import MarkdownEditor, { type Annotation } from "./components/MarkdownEditor";
import "./App.css";

type AgentSpec = {
  id: string;
  label: string;
  command: string;
  args: string[];
};

type SpawnResult = {
  session_id: string;
};

type TerminalOutput = {
  session_id: string;
  data: string;
};

type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

type FsFile = {
  path: string;
  content: string;
  mtime_ms: number | null;
};

type WorkspaceStatus = {
  root: string;
  configured: boolean;
};

type AgentAvailability = {
  id: string;
  command: string;
  available: boolean;
};

type AutomationTask = {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  status: string; // queued | running | completed | failed
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  session_id: string | null;
  result_json: unknown | null;
  error: string | null;
};

type AgentDecor = {
  color: string;
  icon: string;
  role: string;
  shortcut: string;
};

const AGENT_DECOR: Record<string, AgentDecor> = {
  claude: { color: "#F4A261", icon: "C", role: "Writer", shortcut: "1" },
  codex: { color: "#72D1C2", icon: "X", role: "Editor", shortcut: "2" },
  gemini: { color: "#B49CDE", icon: "G", role: "Lore", shortcut: "3" },
  cursor: { color: "#7BC87F", icon: "U", role: "Tools", shortcut: "4" },
  shell: { color: "#8A8A8A", icon: "$", role: "Shell", shortcut: "5" },
};

type RightTab = "editor" | "reader" | "db" | "outline" | "automation";

export default function App() {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [status, setStatus] = useState<string>("");
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  const [workspaceInput, setWorkspaceInput] = useState<string>("");
  const [needsWorkspaceSetup, setNeedsWorkspaceSetup] = useState<boolean>(false);
  const [startupLoaded, setStartupLoaded] = useState<boolean>(false);
  const [availabilityLoaded, setAvailabilityLoaded] = useState<boolean>(false);
  const [availabilityByAgent, setAvailabilityByAgent] = useState<Record<string, boolean>>({});

  const [draft, setDraft] = useState<string>("");
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const [rightTab, setRightTab] = useState<RightTab>("editor");

  const [canonWork, setCanonWork] = useState<string>("shadow_slave");
  const [canonChapter, setCanonChapter] = useState<string>("");
  const [canonText, setCanonText] = useState<string>("");
  const [canonChapters, setCanonChapters] = useState<Array<{ chapter_num: number; chapter_title: string }>>([]);
  const [canonLoading, setCanonLoading] = useState<boolean>(false);

  const [dbWork, setDbWork] = useState<string>("shadow_slave");
  const [dbQuery, setDbQuery] = useState<string>("");
  const [dbChapter, setDbChapter] = useState<string>("");
  const [dbHits, setDbHits] = useState<
    Array<{
      id: string;
      chapter_num?: number;
      chapter_title?: string;
      para_start?: number;
      para_end?: number;
      text: string;
    }>
  >([]);

  const [outlineText, setOutlineText] = useState<string>("");

  // Automation panel state.
  const [automationTasks, setAutomationTasks] = useState<AutomationTask[]>([]);
  const [autoAgentId, setAutoAgentId] = useState<string>("claude");
  const [autoTitle, setAutoTitle] = useState<string>("");
  const [autoPrompt, setAutoPrompt] = useState<string>("");

  // One session per agent (MVP).
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, string>>({});
  const [activeTerminalAgentId, setActiveTerminalAgentId] = useState<string | null>(null);

  // Workspace tree state (lazy-loaded).
  const [dirChildren, setDirChildren] = useState<Record<string, FsEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});

  // Terminal instances by session id.
  const terminalsRef = useRef<Map<string, { term: Terminal; fit: FitAddon }>>(new Map());
  const activeFilePathRef = useRef<string | null>(null);
  const workspaceRootRef = useRef<string>("");
  const mainRef = useRef<HTMLElement | null>(null);
  const autoStartDoneRef = useRef<boolean>(false);
  const annotationsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Vertical split: terminal column width in pixels.
  const [terminalWidthPx, setTerminalWidthPx] = useState<number>(640);

  // Command palette.
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);

  const activeSessionId = useMemo(() => {
    if (!activeTerminalAgentId) return null;
    return sessionsByAgent[activeTerminalAgentId] ?? null;
  }, [activeTerminalAgentId, sessionsByAgent]);

  const runningCount = useMemo(() => Object.values(sessionsByAgent).filter(Boolean).length, [sessionsByAgent]);
  const availableAgentCount = useMemo(
    () => agents.filter((a) => availabilityByAgent[a.id] !== false).length,
    [agents, availabilityByAgent],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_agents")) as AgentSpec[];
        const ws = (await invoke("get_workspace_status")) as WorkspaceStatus;
        let availability: AgentAvailability[] = [];
        try {
          availability = (await invoke("list_agent_availability")) as AgentAvailability[];
        } catch {
          availability = list.map((a) => ({ id: a.id, command: a.command, available: true }));
        }
        if (!cancelled) {
          setAgents(list);
          setActiveTerminalAgentId((prev) => {
            if (prev && list.some((a) => a.id === prev)) return prev;
            return list.length ? list[0].id : null;
          });

          const availMap: Record<string, boolean> = {};
          for (const a of availability) availMap[a.id] = a.available;
          setAvailabilityByAgent(availMap);
          setAvailabilityLoaded(true);

          setWorkspaceRoot(ws.root);
          setWorkspaceInput(ws.root);
          setNeedsWorkspaceSetup(!ws.configured);
          setStartupLoaded(true);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus(`Failed to load startup state: ${String(e)}`);
          setAvailabilityLoaded(true);
          setStartupLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (needsWorkspaceSetup) return;
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmdOpen((p) => !p);
        return;
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        return;
      }
      if (cmdOpen) return;

      // Number shortcuts: switch active agent.
      const byShortcut = (agents || []).find((a) => AGENT_DECOR[a.id]?.shortcut === e.key);
      if (byShortcut) setActiveTerminalAgentId(byShortcut.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [agents, cmdOpen, needsWorkspaceSetup]);

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      setStatus(`UI error: ${e.message}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = typeof e.reason === "string" ? e.reason : e.reason?.message || "Unhandled promise rejection";
      setStatus(`UI async error: ${msg}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Listen for automation task updates from the backend runner.
  useEffect(() => {
    let unlisten: null | (() => void) = null;
    let disposed = false;
    (async () => {
      unlisten = await listen<string>("automation://task_updated", () => {
        if (disposed) return;
        invoke("automation_list_tasks")
          .then((tasks) => {
            if (!disposed) {
              const list = tasks as AutomationTask[];
              list.sort((a, b) => b.created_at_ms - a.created_at_ms);
              setAutomationTasks(list);
            }
          })
          .catch(() => {});
      });
    })().catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (autoStartDoneRef.current) return;
    if (!startupLoaded || !availabilityLoaded) return;
    if (!agents.length) return;
    if (needsWorkspaceSetup) return;
    autoStartDoneRef.current = true;

    const preferred = ["claude", "codex", "gemini"];
    const toStart = preferred.filter(
      (id) => agents.some((a) => a.id === id) && availabilityByAgent[id] !== false,
    );
    if (!toStart.length) return;

    (async () => {
      for (const id of toStart) {
        // eslint-disable-next-line no-await-in-loop
        await startAgent(id);
      }
      setStatus(`Auto-started: ${toStart.join(", ")}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupLoaded, availabilityLoaded, agents, availabilityByAgent, needsWorkspaceSetup]);

  useEffect(() => {
    let unlistenOutput: null | (() => void) = null;
    let unlistenExit: null | (() => void) = null;
    let unlistenChanged: null | (() => void) = null;
    let disposed = false;

    (async () => {
      unlistenOutput = await listen<TerminalOutput>("terminal://output", (event) => {
        if (disposed) return;
        const entry = terminalsRef.current.get(event.payload.session_id);
        entry?.term.write(event.payload.data);
      });
      unlistenExit = await listen<TerminalOutput>("terminal://exit", (event) => {
        if (disposed) return;
        if (event.payload.session_id === activeSessionId) {
          setStatus("Active terminal session exited.");
        }
      });

      unlistenChanged = await listen<{ path: string }>("workspace://file_changed", (event) => {
        const p = event.payload.path;
        const af = activeFilePathRef.current;
        if (af && p === af) {
          invoke("fs_read_file", { path: af })
            .then((f) => {
              const file = f as FsFile;
              setDraft(file.content);
              setStatus(`Reloaded: ${file.path}`);
            })
            .catch((e) => setStatus(`Reload failed: ${String(e)}`));
        }
        // Convention: draft annotations file.
        const root = workspaceRootRef.current;
        if (root && p === `${root}/drafts/annotations.json`) {
          if (annotationsDebounceRef.current) clearTimeout(annotationsDebounceRef.current);
          annotationsDebounceRef.current = setTimeout(() => void loadAnnotations(), 300);
        }
        if (root && p === `${root}/drafts/outline.md`) {
          loadOutline();
        }
      });
    })().catch((e) => setStatus(`Event listen failed: ${String(e)}`));

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
      unlistenChanged?.();
    };
  }, [activeSessionId]);

  function ensureTerminalAttached(container: HTMLDivElement | null, sessionId: string) {
    if (!container) return;
    if (terminalsRef.current.has(sessionId)) return;

    const term = new Terminal({
      fontFamily: "var(--mono)",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 7000,
      theme: {
        background: "#0c0c0b",
        foreground: "#d6deeb",
        cursor: "#d6deeb",
        selectionBackground: "rgba(214,222,235,0.25)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    terminalsRef.current.set(sessionId, { term, fit });

    term.onData((data) => {
      invoke("terminal_write", { session_id: sessionId, data }).catch((e) =>
        setStatus(`Write failed: ${String(e)}`),
      );
    });

    invoke("terminal_resize", { session_id: sessionId, rows: term.rows, cols: term.cols }).catch((e) =>
      setStatus(`Resize failed: ${String(e)}`),
    );
  }

  function fitActiveTerminal() {
    if (!activeSessionId) return;
    const entry = terminalsRef.current.get(activeSessionId);
    if (!entry) return;
    entry.fit.fit();
    invoke("terminal_resize", {
      session_id: activeSessionId,
      rows: entry.term.rows,
      cols: entry.term.cols,
    }).catch((e) => setStatus(`Resize failed: ${String(e)}`));
  }

  useEffect(() => {
    const onResize = () => fitActiveTerminal();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeSessionId]);

  useEffect(() => {
    fitActiveTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, rightTab, cmdOpen, terminalWidthPx]);

  async function startAgent(agentId: string) {
    setStatus("");
    try {
      if (availabilityByAgent[agentId] === false) {
        setStatus(`Agent unavailable in PATH: ${agentId}`);
        return;
      }
      const existing = sessionsByAgent[agentId];
      if (existing) {
        setActiveTerminalAgentId(agentId);
        return;
      }
      const res = (await invoke("spawn_agent_terminal", { agent_id: agentId })) as SpawnResult;
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: res.session_id }));
      setActiveTerminalAgentId(agentId);
      setStatus(`Started ${agentId}.`);
    } catch (e) {
      setStatus(`Spawn failed: ${String(e)}`);
    }
  }

  async function killAgent(agentId: string) {
    const sessionId = sessionsByAgent[agentId];
    if (!sessionId) return;
    setStatus("");
    try {
      await invoke("terminal_kill", { session_id: sessionId });
      terminalsRef.current.get(sessionId)?.term.dispose();
      terminalsRef.current.delete(sessionId);
      setSessionsByAgent((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
      if (activeTerminalAgentId === agentId) {
        setActiveTerminalAgentId((prev) => {
          if (prev !== agentId) return prev;
          const nextAgent = agents.find((a) => a.id !== agentId);
          return nextAgent ? nextAgent.id : null;
        });
      }
      setStatus(`Killed ${agentId}.`);
    } catch (e) {
      setStatus(`Kill failed: ${String(e)}`);
    }
  }

  async function startAllAgents() {
    const startable = agents.filter((a) => availabilityByAgent[a.id] !== false);
    for (const a of startable) {
      // eslint-disable-next-line no-await-in-loop
      await startAgent(a.id);
    }
    if (!startable.length) {
      setStatus("No available agents found in PATH.");
    }
  }

  async function killAllAgents() {
    for (const a of agents) {
      // eslint-disable-next-line no-await-in-loop
      await killAgent(a.id);
    }
  }

  async function setWorkspace(nextRoot?: string): Promise<boolean> {
    const target = (nextRoot ?? workspaceInput).trim();
    if (!target) {
      setStatus("Workspace path is required.");
      return false;
    }
    setStatus("");
    try {
      const ws = (await invoke("set_workspace", { root: target })) as { root: string };
      setWorkspaceRoot(ws.root);
      setWorkspaceInput(ws.root);
      setDirChildren({});
      setExpandedDirs({ [ws.root]: true });
      loadAnnotations();
      loadOutline();
      setNeedsWorkspaceSetup(false);
      setStatus("Workspace updated.");
      return true;
    } catch (e) {
      setStatus(`Workspace update failed: ${String(e)}`);
      return false;
    }
  }

  async function browseWorkspaceFolder() {
    try {
      const picked = (await invoke("pick_workspace_folder")) as string | null;
      if (picked && picked.trim()) {
        setWorkspaceInput(picked.trim());
      }
    } catch (e) {
      setStatus(`Folder picker failed: ${String(e)}`);
    }
  }

  async function openFile(path: string) {
    setStatus("");
    try {
      const f = (await invoke("fs_read_file", { path })) as FsFile;
      setActiveFilePath(f.path);
      setDraft(f.content);
      setRightTab("editor");
      setStatus(`Opened: ${f.path}`);
      loadAnnotations();
    } catch (e) {
      setStatus(`Open failed: ${String(e)}`);
    }
  }

  async function saveFile() {
    if (!activeFilePath) {
      setStatus("No active file to save.");
      return;
    }
    setStatus("");
    try {
      await invoke("fs_write_file", { path: activeFilePath, content: draft });
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    }
  }

  async function loadAnnotations() {
    if (!workspaceRoot) return;
    const p = `${workspaceRoot}/drafts/annotations.json`;
    try {
      const f = (await invoke("fs_read_file", { path: p })) as FsFile;
      const raw = JSON.parse(f.content) as Array<any>;
      const ann: Annotation[] = (raw || [])
        .filter((x) => typeof x?.line === "number" && typeof x?.message === "string")
        .map((x) => ({
          line: x.line,
          message: x.message,
          agent: x.agent,
          severity: x.severity,
        }));
      setAnnotations(ann);
    } catch {
      setAnnotations([]);
    }
  }

  async function loadOutline() {
    if (!workspaceRoot) return;
    const p = `${workspaceRoot}/drafts/outline.md`;
    try {
      const f = (await invoke("fs_read_file", { path: p })) as FsFile;
      setOutlineText(f.content);
    } catch {
      setOutlineText("");
    }
  }

  async function refreshAutomationTasks() {
    try {
      const tasks = (await invoke("automation_list_tasks")) as AutomationTask[];
      tasks.sort((a, b) => b.created_at_ms - a.created_at_ms);
      setAutomationTasks(tasks);
    } catch (e) {
      setStatus(`Automation list failed: ${String(e)}`);
    }
  }

  async function enqueueTask() {
    if (!autoTitle.trim() || !autoPrompt.trim()) {
      setStatus("Task title and prompt are required.");
      return;
    }
    setStatus("");
    try {
      await invoke("automation_enqueue_task", {
        agent_id: autoAgentId,
        title: autoTitle.trim(),
        prompt: autoPrompt.trim(),
      });
      setAutoTitle("");
      setAutoPrompt("");
      setStatus("Task enqueued.");
      await refreshAutomationTasks();
    } catch (e) {
      setStatus(`Enqueue failed: ${String(e)}`);
    }
  }

  async function runDbSearch() {
    setStatus("");
    try {
      const chapterNum = dbChapter.trim() ? Number(dbChapter.trim()) : null;
      const res = (await invoke("db_search", {
        work: dbWork,
        query: dbQuery.trim() ? dbQuery.trim() : null,
        chapter: chapterNum && !Number.isNaN(chapterNum) ? chapterNum : null,
        k: 8,
      })) as any;
      if (!res.ok) {
        setDbHits([]);
        setStatus(res.error || "DB search failed.");
        return;
      }
      setDbHits(
        (res.hits || []).map((h: any) => ({
          id: h.id,
          chapter_num: h.chapter_num ?? undefined,
          chapter_title: h.chapter_title ?? undefined,
          para_start: h.para_start ?? undefined,
          para_end: h.para_end ?? undefined,
          text: h.text || "",
        })),
      );
      setStatus("DB search ok.");
    } catch (e) {
      setStatus(`DB search error: ${String(e)}`);
    }
  }

  async function loadCanonChapter(chapterOverride?: number) {
    setStatus("");
    try {
      const chapterNum =
        typeof chapterOverride === "number"
          ? chapterOverride
          : canonChapter.trim()
            ? Number(canonChapter.trim())
            : null;
      if (!chapterNum || Number.isNaN(chapterNum)) {
        setStatus("Enter a chapter number.");
        return;
      }
      setCanonLoading(true);
      const res = (await invoke("db_search", {
        work: canonWork,
        query: null,
        chapter: chapterNum,
        k: 9999,
      })) as any;
      if (!res.ok) {
        setCanonText("");
        setStatus(res.error || "Canon load failed.");
        setCanonLoading(false);
        return;
      }
      const text = (res.hits || []).map((h: any) => (h.text || "").trim()).join("\n\n");
      setCanonText(text);
      setRightTab("reader");
      setStatus(`Loaded canon chapter ${chapterNum} (chunks).`);
      setCanonLoading(false);
    } catch (e) {
      setStatus(`Canon load error: ${String(e)}`);
      setCanonLoading(false);
    }
  }

  async function refreshCanonChapters() {
    setStatus("");
    try {
      const res = (await invoke("db_list_chapters", { work: canonWork })) as any;
      if (!res.ok) {
        setCanonChapters([]);
        setStatus(res.error || "Failed to list chapters.");
        return;
      }
      setCanonChapters(
        (res.chapters || []).map((c: any) => ({
          chapter_num: Number(c.chapter_num),
          chapter_title: String(c.chapter_title || ""),
        })),
      );
      setStatus(`Loaded chapter index (${(res.chapters || []).length}).`);
    } catch (e) {
      setStatus(`List chapters error: ${String(e)}`);
    }
  }

  async function loadDir(path: string) {
    try {
      const entries = (await invoke("fs_list_dir", { path })) as FsEntry[];
      setDirChildren((prev) => ({ ...prev, [path]: entries }));
    } catch (e) {
      setStatus(`List dir failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (needsWorkspaceSetup) return;
    if (!workspaceRoot) return;
    loadDir(workspaceRoot);
    setExpandedDirs((prev) => ({ ...prev, [workspaceRoot]: true }));
    loadAnnotations();
    loadOutline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, needsWorkspaceSetup]);

  function onVerticalDividerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const host = mainRef.current;
    if (!host) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = host.getBoundingClientRect();
    const startX = e.clientX;
    const startW = terminalWidthPx;
    const minW = 380;
    const maxW = Math.max(minW, rect.width - 380);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = Math.max(minW, Math.min(maxW, startW + dx));
      setTerminalWidthPx(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      fitActiveTerminal();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      return next;
    });
    if (!dirChildren[path]) {
      loadDir(path);
    }
  }

  function renderTree(path: string, depth: number) {
    const children = dirChildren[path] ?? [];
    return children.map((entry) => {
      const pad = { paddingLeft: `${10 + depth * 14}px` };
      if (entry.is_dir) {
        const isOpen = !!expandedDirs[entry.path];
        return (
          <div key={entry.path} className="sfTreeRow">
            <button className="sfTreeBtn" style={pad} onClick={() => toggleDir(entry.path)}>
              <span
                className="sfTwisty"
                style={{
                  transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 150ms ease",
                }}
              >
                ▶
              </span>
              <span className="sfTreeName">{entry.name}</span>
            </button>
            {isOpen ? <div>{renderTree(entry.path, depth + 1)}</div> : null}
          </div>
        );
      }

      return (
        <div key={entry.path} className="sfTreeRow">
          <button className="sfTreeBtn" style={pad} onClick={() => openFile(entry.path)}>
            <span className="sfTwisty" />
            <span className="sfTreeName file">{entry.name}</span>
          </button>
        </div>
      );
    });
  }

  const allPaletteCommands: Array<{ label: string; run: () => void }> = [
    { label: "Start all agents", run: () => void startAllAgents() },
    { label: "Kill all agents", run: () => void killAllAgents() },
    { label: "Save current draft", run: () => void saveFile() },
    { label: "Open editor", run: () => setRightTab("editor") },
    { label: "Open canon browser", run: () => setRightTab("reader") },
    { label: "Refresh canon chapters", run: () => void refreshCanonChapters() },
    { label: "Open DB search", run: () => setRightTab("db") },
    { label: "Open outline", run: () => setRightTab("outline") },
    {
      label: "Open task queue",
      run: () => {
        setRightTab("automation");
        void refreshAutomationTasks();
      },
    },
  ];
  const q = cmdQuery.trim().toLowerCase();
  const paletteCommands = !q
    ? allPaletteCommands
    : allPaletteCommands.filter((c) => c.label.toLowerCase().includes(q));

  return (
    <div className="sfShell" style={{ position: "relative" }}>
      {needsWorkspaceSetup ? (
        <div className="sfOverlay" style={{ zIndex: 140 }}>
          <div className="sfSetupCard" onClick={(e) => e.stopPropagation()}>
            <div className="sfSetupTitle">Select Workspace Folder</div>
            <div className="sfSetupBody">
              Choose your project folder once. The app will use it for drafts, canon DB, logs, and agent commands.
            </div>
            <div className="sfSetupRow">
              <input
                className="sfInput"
                value={workspaceInput}
                onChange={(e) => setWorkspaceInput(e.currentTarget.value)}
                placeholder="/Users/you/your-project"
                autoFocus
              />
            </div>
            <div className="sfSetupActions">
              <button className="sfBtn secondary" onClick={browseWorkspaceFolder}>
                Browse
              </button>
              <button className="sfBtn" disabled={!workspaceInput.trim()} onClick={() => void setWorkspace()}>
                Use Folder
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cmdOpen ? (
        <div
          className="sfOverlay"
          onClick={() => {
            setCmdOpen(false);
            setCmdQuery("");
          }}
        >
          <div className="sfPalette" onClick={(e) => e.stopPropagation()}>
            <div className="sfPaletteTop">
              <input
                autoFocus
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.currentTarget.value)}
                placeholder="Type a command..."
                className="sfPaletteInput"
              />
            </div>
            {paletteCommands.map((c) => (
              <div
                key={c.label}
                className="sfCmdRow"
                onClick={() => {
                  setCmdOpen(false);
                  setCmdQuery("");
                  c.run();
                }}
              >
                <span style={{ color: "#555", fontSize: 12 }}>▸</span>
                {c.label}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sfTopbar">
        <div className="sfWinDots">
          <span className="sfDot" style={{ background: "#BF5F56" }} />
          <span className="sfDot" style={{ background: "#BFA340" }} />
          <span className="sfDot" style={{ background: "#6BBF5F" }} />
        </div>
        <div className="sfTitle">Shadow Forge</div>
        <div className="sfVersion">v0.1</div>

        <div className="sfTopbarActions">
          <div
            className="sfCmdBtn"
            onClick={() => {
              if (!needsWorkspaceSetup) setCmdOpen(true);
            }}
            role="button"
            tabIndex={0}
            style={needsWorkspaceSetup ? { opacity: 0.45, cursor: "default" } : undefined}
          >
            Command <span className="sfKbd">⌘K</span>
          </div>
          <input
            className="sfInput"
            value={workspaceInput}
            onChange={(e) => setWorkspaceInput(e.currentTarget.value)}
            placeholder="Workspace path..."
          />
          <button className="sfBtn secondary" onClick={browseWorkspaceFolder}>
            Browse
          </button>
          <button className="sfBtn" onClick={() => void setWorkspace()} disabled={!workspaceInput.trim()}>
            Set
          </button>
          <button
            className="sfBtn secondary"
            onClick={startAllAgents}
            disabled={!agents.length || needsWorkspaceSetup || !availableAgentCount}
          >
            Start All
          </button>
          <button
            className="sfBtn secondary"
            onClick={killAllAgents}
            disabled={!Object.keys(sessionsByAgent).length || needsWorkspaceSetup}
          >
            Kill All
          </button>
          <div className="sfChips">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`sfPulseDot ${runningCount ? "on" : ""}`} /> {runningCount} agents
            </span>
            <span>available: {availableAgentCount}</span>
          </div>
        </div>
      </div>

      <div className="sfBody">
        <aside className="sfSidebar">
          <div className="sfSectionTitle">AGENTS</div>
          <div className="sfAgentList">
            {agents.map((a) => {
              const decor = AGENT_DECOR[a.id] ?? { color: "#888", icon: "?", role: "—", shortcut: "" };
              const active = a.id === activeTerminalAgentId;
              const running = !!sessionsByAgent[a.id];
              const available = availabilityByAgent[a.id] !== false;
              return (
                <div
                  key={a.id}
                  className={`sfAgentRow ${active ? "active" : ""}`}
                  onClick={() => {
                    if (!needsWorkspaceSetup) setActiveTerminalAgentId(a.id);
                  }}
                  style={!available ? { opacity: 0.45 } : undefined}
                >
                  <div className="sfAgentIcon" style={active ? { color: decor.color } : undefined}>
                    {decor.icon}
                  </div>
                  <div className="sfAgentMeta">
                    <div className="sfAgentName" style={!active ? undefined : { color: "#ccc" }}>
                      {a.label}
                    </div>
                    <div className="sfAgentRole">{available ? decor.role : "Not installed"}</div>
                  </div>
                  <div className="sfAgentRight">
                    {decor.shortcut ? <span className="sfKbd">{decor.shortcut}</span> : null}
                    <span className={`sfPulseDot ${running ? "on" : ""}`} style={!available ? { background: "#2a2a2a" } : undefined} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sfSplitLine" />

          <div className="sfSectionTitle" style={{ paddingTop: 10 }}>
            WORKSPACE
          </div>
          <div className="sfWorkspace">{workspaceRoot ? renderTree(workspaceRoot, 0) : null}</div>
        </aside>

        <main className="sfMain" ref={mainRef}>
          <section className="sfTerminalCol" style={{ flex: `0 0 ${terminalWidthPx}px` }}>
            <div className="sfTabbar">
              {agents.map((a) => {
                const decor = AGENT_DECOR[a.id] ?? { color: "#888", icon: "?", role: "—", shortcut: "" };
                const sel = a.id === activeTerminalAgentId;
                const running = !!sessionsByAgent[a.id];
                return (
                  <button
                    key={a.id}
                    className={`sfTab ${sel ? "active" : ""}`}
                    style={sel ? { color: decor.color } : undefined}
                    onClick={() => setActiveTerminalAgentId(a.id)}
                  >
                    <span className={`sfPulseDot ${running ? "on" : ""}`} />
                    {a.label}
                  </button>
                );
              })}
              <div style={{ flex: 1 }} />
              {activeTerminalAgentId ? (
                sessionsByAgent[activeTerminalAgentId] ? (
                  <button className="sfBtn secondary" onClick={() => killAgent(activeTerminalAgentId)}>
                    Kill
                  </button>
                ) : (
                  <button
                    className="sfBtn secondary"
                    onClick={() => startAgent(activeTerminalAgentId)}
                    disabled={needsWorkspaceSetup || availabilityByAgent[activeTerminalAgentId] === false}
                  >
                    Start
                  </button>
                )
              ) : (
                <button className="sfBtn secondary" disabled>
                  Start
                </button>
              )}
            </div>

            <div className="sfTerminalWrap">
              {Object.entries(sessionsByAgent).map(([agentId, sessionId]) => (
                <div
                  key={sessionId}
                  className={`sfTerminalFrame ${sessionId === activeSessionId ? "active" : "inactive"}`}
                  ref={(el) => ensureTerminalAttached(el, sessionId)}
                  data-agent={agentId}
                />
              ))}
              {!activeSessionId ? (
                <div style={{ padding: 16, color: "#555", fontFamily: "var(--mono)", fontSize: 12 }}>
                  Start the selected agent to open a terminal session.
                </div>
              ) : null}
            </div>
          </section>

          <div className="sfVDivider" onPointerDown={onVerticalDividerPointerDown} />

          <section className="sfRightCol">
            <div className="sfPanelHead">
              {(
                [
                  ["editor", "Editor"],
                  ["reader", "Reader"],
                  ["db", "DB"],
                  ["outline", "Outline"],
                  ["automation", "Tasks"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={`sfTab ${rightTab === id ? "active" : ""}`}
                  onClick={() => {
                    setRightTab(id);
                    if (id === "automation") void refreshAutomationTasks();
                  }}
                >
                  {label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#333", paddingRight: 8 }}>
                {activeFilePath ? activeFilePath.split("/").slice(-1)[0] : "draft"}
              </span>
            </div>

            <div className="sfPanelContent">
              {rightTab === "editor" ? (
                <div className="h-full min-h-0 flex flex-col">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      background: "var(--bg0)",
                      borderBottom: "1px solid var(--line0)",
                      color: "#555",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                    }}
                  >
                    <button className="sfBtn" onClick={saveFile} disabled={!activeFilePath}>
                      Save
                    </button>
                    <span style={{ color: "#444" }}>Annotations: drafts/annotations.json</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ color: "#333" }}>{status}</span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <MarkdownEditor
                      value={draft}
                      onChange={setDraft}
                      annotations={annotations}
                      placeholder="Write markdown here..."
                    />
                  </div>
                </div>
              ) : null}

              {rightTab === "reader" ? (
                <div className="h-full min-h-0 flex flex-col">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 14px",
                      background: "var(--bg0)",
                      borderBottom: "1px solid var(--line0)",
                    }}
                  >
                    <input
                      className="sfInput"
                      style={{ width: 170, minWidth: 170 }}
                      value={canonWork}
                      onChange={(e) => setCanonWork(e.currentTarget.value)}
                      placeholder="work id"
                    />
                    <input
                      className="sfInput"
                      style={{ width: 120, minWidth: 120 }}
                      value={canonChapter}
                      onChange={(e) => setCanonChapter(e.currentTarget.value)}
                      placeholder="chapter #"
                    />
                    <button className="sfBtn secondary" onClick={refreshCanonChapters}>
                      Browse
                    </button>
                    <button className="sfBtn" onClick={() => loadCanonChapter()}>
                      Load
                    </button>
                    {canonLoading ? (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#444" }}>Loading...</div>
                    ) : null}
                  </div>
                  <div className="flex-1 min-h-0 grid grid-cols-[280px_1fr]">
                    <div style={{ borderRight: "1px solid var(--line0)", background: "var(--bg0)", overflow: "auto" }}>
                      <div className="sfSectionTitle" style={{ paddingTop: 12 }}>
                        CHAPTERS
                      </div>
                      <div style={{ padding: "0 10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {canonChapters.map((c) => (
                          <button
                            key={c.chapter_num}
                            onClick={() => {
                              setCanonChapter(String(c.chapter_num));
                              loadCanonChapter(c.chapter_num);
                            }}
                            style={{
                              textAlign: "left",
                              padding: "10px 10px",
                              borderRadius: 10,
                              border: "1px solid rgba(255,255,255,0.06)",
                              background: "rgba(255,255,255,0.02)",
                              color: "#ccc",
                              cursor: "pointer",
                            }}
                          >
                            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#777", fontWeight: 700 }}>
                              ch {c.chapter_num}
                            </div>
                            <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "#888" }}>
                              {c.chapter_title || "—"}
                            </div>
                          </button>
                        ))}
                        {!canonChapters.length ? (
                          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#444", padding: "0 4px" }}>
                            No index loaded. Click Browse after ingest.
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="min-h-0">
                      <MarkdownEditor
                        value={canonText}
                        readOnly
                        placeholder="Canon chapter text will appear here."
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {rightTab === "db" ? (
                <div className="h-full min-h-0 flex flex-col">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 14px",
                      background: "var(--bg0)",
                      borderBottom: "1px solid var(--line0)",
                    }}
                  >
                    <input
                      className="sfInput"
                      style={{ width: 170, minWidth: 170 }}
                      value={dbWork}
                      onChange={(e) => setDbWork(e.currentTarget.value)}
                      placeholder="work id"
                    />
                    <input className="sfInput" value={dbQuery} onChange={(e) => setDbQuery(e.currentTarget.value)} placeholder="query" />
                    <input
                      className="sfInput"
                      style={{ width: 140, minWidth: 140 }}
                      value={dbChapter}
                      onChange={(e) => setDbChapter(e.currentTarget.value)}
                      placeholder="chapter # (optional)"
                    />
                    <button className="sfBtn" onClick={runDbSearch}>
                      Search
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {dbHits.map((h) => (
                        <div
                          key={h.id}
                          style={{
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.06)",
                            background: "rgba(255,255,255,0.02)",
                            padding: 12,
                          }}
                        >
                          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#666", fontWeight: 700 }}>
                            ch {h.chapter_num ?? "?"} p{h.para_start ?? "?"}-{h.para_end ?? "?"} {h.chapter_title ?? ""}
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--serif)",
                              fontSize: 13.5,
                              lineHeight: 1.6,
                              color: "#a09c90",
                              marginTop: 8,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {h.text}
                          </div>
                        </div>
                      ))}
                      {!dbHits.length ? (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#444" }}>No results.</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {rightTab === "automation" ? (
                <div className="h-full min-h-0 flex flex-col" style={{ overflow: "auto" }}>
                  {/* New task form */}
                  <div
                    style={{
                      padding: "12px 14px",
                      background: "var(--bg0)",
                      borderBottom: "1px solid var(--line0)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div className="sfSectionTitle" style={{ paddingTop: 0 }}>NEW TASK</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        className="sfInput"
                        style={{ width: 120, minWidth: 120 }}
                        value={autoAgentId}
                        onChange={(e) => setAutoAgentId(e.currentTarget.value)}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.label}</option>
                        ))}
                      </select>
                      <input
                        className="sfInput"
                        style={{ flex: 1 }}
                        value={autoTitle}
                        onChange={(e) => setAutoTitle(e.currentTarget.value)}
                        placeholder="Task title"
                      />
                    </div>
                    <textarea
                      className="sfInput"
                      style={{ resize: "vertical", minHeight: 72, fontFamily: "var(--mono)", fontSize: 12 }}
                      value={autoPrompt}
                      onChange={(e) => setAutoPrompt(e.currentTarget.value)}
                      placeholder="Prompt sent to agent. Agent must output JSON between BEGIN_RESULT / END_RESULT markers."
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="sfBtn"
                        onClick={() => void enqueueTask()}
                        disabled={!autoTitle.trim() || !autoPrompt.trim()}
                      >
                        Enqueue Task
                      </button>
                      <button className="sfBtn secondary" onClick={() => void refreshAutomationTasks()}>
                        Refresh
                      </button>
                    </div>
                  </div>

                  {/* Task list */}
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 14px" }}>
                    <div className="sfSectionTitle" style={{ paddingTop: 0, paddingBottom: 8 }}>
                      TASKS ({automationTasks.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {automationTasks.map((t) => {
                        const statusColors: Record<string, string> = {
                          queued: "#555",
                          running: "#F4A261",
                          completed: "#6BBF5F",
                          failed: "#BF5F56",
                        };
                        const color = statusColors[t.status] ?? "#555";
                        const elapsed =
                          t.finished_at_ms && t.started_at_ms
                            ? `${((t.finished_at_ms - t.started_at_ms) / 1000).toFixed(1)}s`
                            : null;
                        return (
                          <div
                            key={t.id}
                            style={{
                              borderRadius: 8,
                              border: `1px solid ${color}33`,
                              background: "rgba(255,255,255,0.02)",
                              padding: "10px 12px",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 10,
                                  color,
                                  fontWeight: 700,
                                  textTransform: "uppercase",
                                  minWidth: 70,
                                }}
                              >
                                {t.status}
                              </span>
                              <span style={{ fontFamily: "var(--sans)", fontSize: 13, color: "#ccc", flex: 1 }}>
                                {t.title}
                              </span>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#444" }}>
                                {t.agent_id}
                              </span>
                            </div>
                            {t.error ? (
                              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#BF5F56", marginTop: 4 }}>
                                {t.error}
                              </div>
                            ) : null}
                            {elapsed ? (
                              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#444", marginTop: 2 }}>
                                {elapsed}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      {!automationTasks.length ? (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#444" }}>
                          No tasks yet. Enqueue a task above.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {rightTab === "outline" ? (
                <div className="h-full min-h-0 flex flex-col">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      background: "var(--bg0)",
                      borderBottom: "1px solid var(--line0)",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "#555",
                    }}
                  >
                    <button className="sfBtn secondary" onClick={loadOutline}>
                      Reload
                    </button>
                    <span style={{ color: "#444" }}>File: drafts/outline.md</span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <MarkdownEditor
                      value={
                        outlineText ||
                        "# Outline\n\nCreate `drafts/outline.md` in your workspace to show outline here.\n\nTip: agents can update it and the UI will auto-reload."
                      }
                      readOnly
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </div>

      <div className="sfBottomBar">
        <span style={{ color: "#444" }}>{workspaceRoot ? workspaceRoot.split("/").slice(-1)[0] : "workspace"}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className={`sfPulseDot ${runningCount ? "on" : ""}`} /> {runningCount}
        </span>
        <span>canon: {canonChapters.length ? canonChapters.length : "—"}</span>
        <span>hits: {dbHits.length}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "#f4a261" }}>{status ? status : "ready"}</span>
      </div>
    </div>
  );
}
