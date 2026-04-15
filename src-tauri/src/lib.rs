use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::mpsc,
    sync::Mutex,
    time::UNIX_EPOCH,
};

use dashmap::DashMap;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentSpec {
    id: String,
    label: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SpawnResult {
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AutomationTask {
    id: String,
    agent_id: String,
    title: String,
    prompt: String,
    status: String, // queued | running | completed | failed
    created_at_ms: u128,
    started_at_ms: Option<u128>,
    finished_at_ms: Option<u128>,
    session_id: Option<String>,
    result_json: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AutomationEnqueueResult {
    task_id: String,
}

#[derive(Debug, Clone)]
struct CaptureState {
    task_id: String,
    buf: String,
}

#[derive(Debug, Clone, Serialize)]
struct FileWritten {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct WorkspaceInfo {
    root: String,
}

#[derive(Debug, Clone, Serialize)]
struct WorkspaceStatus {
    root: String,
    configured: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AgentAvailability {
    id: String,
    command: String,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
struct FsFile {
    path: String,
    content: String,
    mtime_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
struct FileChanged {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbHit {
    id: String,
    distance: Option<f64>,
    work: Option<String>,
    chapter_num: Option<i64>,
    chapter_title: Option<String>,
    para_start: Option<i64>,
    para_end: Option<i64>,
    chunk_index: Option<i64>,
    chunk_count: Option<i64>,
    source_epub: Option<String>,
    source_href: Option<String>,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbSearchResult {
    ok: bool,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    hits: Vec<DbHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChapterInfo {
    chapter_num: i64,
    #[serde(default)]
    chapter_title: String,
    #[serde(default)]
    chunk_max_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChapterListResult {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    work: Option<String>,
    #[serde(default)]
    chapters: Vec<ChapterInfo>,
}

struct SessionHandle {
    agent_id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    capture: Mutex<Option<CaptureState>>,
    log_file: Mutex<Option<fs::File>>,
}

struct AppState {
    agents: Mutex<Vec<AgentSpec>>,
    workspace_root: Mutex<PathBuf>,
    drafts_watcher: Mutex<Option<RecommendedWatcher>>,
    sessions: DashMap<String, SessionHandle>,
    agent_sessions: DashMap<String, String>,

    tasks: DashMap<String, AutomationTask>,
    task_queue: Mutex<VecDeque<String>>,
    task_waiters: DashMap<String, mpsc::Sender<serde_json::Value>>,
    runner_started: Mutex<bool>,
}

fn default_agents() -> Vec<AgentSpec> {
    vec![
        AgentSpec {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            command: "claude".to_string(),
            args: vec![],
        },
        AgentSpec {
            id: "codex".to_string(),
            label: "Codex CLI".to_string(),
            command: "codex".to_string(),
            args: vec![],
        },
        AgentSpec {
            id: "gemini".to_string(),
            label: "Gemini CLI".to_string(),
            command: "gemini".to_string(),
            args: vec![],
        },
        AgentSpec {
            id: "cursor".to_string(),
            label: "Cursor CLI".to_string(),
            command: "cursor".to_string(),
            args: vec![],
        },
        AgentSpec {
            id: "shell".to_string(),
            label: "Shell".to_string(),
            command: "zsh".to_string(),
            args: vec!["-l".to_string()],
        },
    ]
}

fn merge_missing_default_agents(mut configured: Vec<AgentSpec>) -> Vec<AgentSpec> {
    let existing_ids: std::collections::HashSet<String> =
        configured.iter().map(|a| a.id.clone()).collect();
    for d in default_agents() {
        if !existing_ids.contains(&d.id) {
            configured.push(d);
        }
    }
    configured
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    Ok(())
}

fn agents_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("agents.json"))
        .map_err(|e| format!("app_config_dir failed: {e}"))
}

fn workspace_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("workspace.json"))
        .map_err(|e| format!("app_config_dir failed: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceConfig {
    root: String,
}

fn load_agents(app: &AppHandle) -> Result<Vec<AgentSpec>, String> {
    let config_path = agents_config_path(app)?;
    if !config_path.exists() {
        ensure_parent_dir(&config_path)?;
        let agents = default_agents();
        let json = serde_json::to_string_pretty(&agents).map_err(|e| format!("json: {e}"))?;
        fs::write(&config_path, json).map_err(|e| format!("write agents.json: {e}"))?;
        return Ok(agents);
    }

    let raw = fs::read_to_string(&config_path).map_err(|e| format!("read agents.json: {e}"))?;
    let agents: Vec<AgentSpec> =
        serde_json::from_str(&raw).map_err(|e| format!("parse agents.json: {e}"))?;
    let merged = merge_missing_default_agents(agents);
    // Persist merged config so future runs are stable.
    if let Ok(json) = serde_json::to_string_pretty(&merged) {
        let _ = fs::write(&config_path, json);
    }
    Ok(merged)
}

fn canonicalize_existing_dir(path: &Path) -> Result<PathBuf, String> {
    let md = fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    if !md.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    fs::canonicalize(path).map_err(|e| format!("canonicalize failed: {e}"))
}

fn default_workspace_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn load_workspace_root(app: &AppHandle) -> PathBuf {
    let config_path = match workspace_config_path(app) {
        Ok(p) => p,
        Err(_) => return default_workspace_root(),
    };
    let raw = match fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return default_workspace_root(),
    };
    let parsed: WorkspaceConfig = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => return default_workspace_root(),
    };
    canonicalize_existing_dir(Path::new(&parsed.root)).unwrap_or_else(|_| default_workspace_root())
}

fn save_workspace_root(app: &AppHandle, root: &Path) -> Result<(), String> {
    let config_path = workspace_config_path(app)?;
    ensure_parent_dir(&config_path)?;
    let cfg = WorkspaceConfig {
        root: root.to_string_lossy().to_string(),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| format!("json: {e}"))?;
    fs::write(&config_path, json).map_err(|e| format!("write workspace.json: {e}"))?;
    Ok(())
}

fn tasks_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("automation_tasks.json"))
        .map_err(|e| format!("app_config_dir failed: {e}"))
}

fn save_tasks_to_disk(app: &AppHandle, state: &AppState) {
    let path = match tasks_config_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let tasks: Vec<AutomationTask> = state.tasks.iter().map(|t| t.value().clone()).collect();
    if let Ok(json) = serde_json::to_string_pretty(&tasks) {
        let _ = ensure_parent_dir(&path);
        let _ = fs::write(&path, json);
    }
}

fn load_tasks_from_disk(app: &AppHandle) -> Vec<AutomationTask> {
    let path = match tasks_config_path(app) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    serde_json::from_str::<Vec<AutomationTask>>(&raw).unwrap_or_default()
}

fn workspace_is_configured(app: &AppHandle) -> bool {
    let config_path = match workspace_config_path(app) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let raw = match fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let parsed: WorkspaceConfig = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => return false,
    };
    canonicalize_existing_dir(Path::new(&parsed.root)).is_ok()
}

fn preferred_path_env() -> String {
    // Ensure modern Homebrew tools are preferred over older /usr/local installs.
    let current = std::env::var("PATH").unwrap_or_default();
    if current.starts_with("/opt/homebrew/bin:") {
        current
    } else {
        format!("/opt/homebrew/bin:{current}")
    }
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn command_in_path(command: &str) -> bool {
    let cmd = command.trim();
    if cmd.is_empty() {
        return false;
    }
    let script = format!("command -v {} >/dev/null 2>&1", shell_single_quote(cmd));
    Command::new("sh")
        .arg("-lc")
        .arg(script)
        .env("PATH", preferred_path_env())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn logs_dir(root: &Path) -> PathBuf {
    root.join("logs")
}

fn open_session_log(root: &Path, agent_id: &str, session_id: &str) -> Option<fs::File> {
    let dir = logs_dir(root);
    let _ = fs::create_dir_all(&dir);
    let p = dir.join(format!("agent-{}-{}.log", agent_id, session_id));
    fs::OpenOptions::new().create(true).append(true).open(p).ok()
}

fn log_write(session: &SessionHandle, prefix: &str, data: &str) {
    let mut guard = match session.log_file.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let f = match guard.as_mut() {
        Some(f) => f,
        None => return,
    };
    let _ = f.write_all(prefix.as_bytes());
    let _ = f.write_all(data.as_bytes());
    let _ = f.flush();
}

#[tauri::command]
fn list_agents(state: State<'_, AppState>) -> Vec<AgentSpec> {
    state
        .agents
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn get_workspace(state: State<'_, AppState>) -> WorkspaceInfo {
    let root = state
        .workspace_root
        .lock()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "".to_string());
    WorkspaceInfo { root }
}

#[tauri::command]
fn get_workspace_status(app: AppHandle, state: State<'_, AppState>) -> WorkspaceStatus {
    let root = state
        .workspace_root
        .lock()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "".to_string());
    WorkspaceStatus {
        root,
        configured: workspace_is_configured(&app),
    }
}

#[tauri::command]
fn list_agent_availability(state: State<'_, AppState>) -> Vec<AgentAvailability> {
    let agents = state
        .agents
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default();
    agents
        .into_iter()
        .map(|a| AgentAvailability {
            id: a.id,
            command: a.command.clone(),
            available: command_in_path(&a.command),
        })
        .collect()
}

#[tauri::command]
fn pick_workspace_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Select Workspace Folder\")")
            .output()
            .map_err(|e| format!("osascript failed: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
            if stderr.contains("user canceled") {
                return Ok(None);
            }
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(None);
        }
        return Ok(Some(path));
    }
    #[cfg(target_os = "linux")]
    {
        // Try zenity (GNOME/GTK), then kdialog (KDE).
        let zenity = Command::new("zenity")
            .arg("--file-selection")
            .arg("--directory")
            .arg("--title=Select Workspace Folder")
            .output();
        if let Ok(o) = zenity {
            if o.status.success() {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                return Ok(if path.is_empty() { None } else { Some(path) });
            }
            // Exit code 1 means user canceled.
            if o.status.code() == Some(1) {
                return Ok(None);
            }
        }
        // zenity not available or failed; try kdialog.
        let kdialog = Command::new("kdialog")
            .arg("--getexistingdirectory")
            .arg(".")
            .output();
        if let Ok(o) = kdialog {
            if o.status.success() {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                return Ok(if path.is_empty() { None } else { Some(path) });
            }
            if o.status.code() == Some(1) {
                return Ok(None);
            }
        }
        Ok(None)
    }
    #[cfg(target_os = "windows")]
    {
        let script = "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); \
                      $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
                      $d.Description = 'Select Workspace Folder'; \
                      if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
        let out = Command::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(script)
            .output()
            .map_err(|e| format!("powershell failed: {e}"))?;
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn set_workspace(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<WorkspaceInfo, String> {
    let canon = canonicalize_existing_dir(Path::new(&root))?;
    {
        let mut guard = state.workspace_root.lock().map_err(|_| "workspace poisoned")?;
        *guard = canon.clone();
    }
    let _ = save_workspace_root(&app, &canon);
    let _ = restart_drafts_watcher(&app, &state);
    Ok(WorkspaceInfo {
        root: canon.to_string_lossy().to_string(),
    })
}

fn ensure_within_root(root: &Path, target: &Path) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| format!("canonicalize root failed: {e}"))?;
    let target = fs::canonicalize(target).map_err(|e| format!("canonicalize target failed: {e}"))?;
    if !target.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }
    Ok(())
}

fn normalize_path_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// Resolve user-supplied path (absolute or relative) under workspace root without requiring the target to exist.
fn resolve_under_root(root: &Path, user_path: &str) -> Result<PathBuf, String> {
    let root_canon = fs::canonicalize(root).map_err(|e| format!("canonicalize root failed: {e}"))?;
    let raw = PathBuf::from(user_path);
    let candidate = if raw.is_absolute() {
        raw
    } else {
        root_canon.join(raw)
    };
    let normalized = normalize_path_lexical(&candidate);
    if !normalized.starts_with(&root_canon) {
        return Err("Path is outside workspace root".to_string());
    }
    Ok(normalized)
}

fn mtime_ms(path: &Path) -> Option<u128> {
    let md = fs::metadata(path).ok()?;
    let modified = md.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())
}

#[tauri::command]
fn fs_list_dir(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<FsEntry>, String> {
    let root = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let target = match path {
        None => root.clone(),
        Some(p) => PathBuf::from(p),
    };
    ensure_within_root(&root, &target)?;

    let mut entries: Vec<FsEntry> = vec![];
    let rd = fs::read_dir(&target).map_err(|e| format!("read_dir failed: {e}"))?;
    for item in rd {
        let item = item.map_err(|e| format!("read_dir item failed: {e}"))?;
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        // Skip noisy system files.
        if name == ".DS_Store" {
            continue;
        }
        let md = item.metadata().map_err(|e| format!("metadata failed: {e}"))?;
        entries.push(FsEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: md.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn fs_read_file(state: State<'_, AppState>, path: String) -> Result<FsFile, String> {
    let root = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let target = PathBuf::from(&path);
    ensure_within_root(&root, &target)?;

    let md = fs::metadata(&target).map_err(|e| format!("stat failed: {e}"))?;
    if md.len() > 5 * 1024 * 1024 {
        return Err("Refusing to read files > 5MB".to_string());
    }
    let bytes = fs::read(&target).map_err(|e| format!("read failed: {e}"))?;
    let content = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => {
            return Err(format!(
                "Cannot open binary or non-UTF-8 file: {}",
                target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())
            ));
        }
    };
    Ok(FsFile {
        path,
        content,
        mtime_ms: mtime_ms(&target),
    })
}

#[tauri::command]
fn fs_write_file(state: State<'_, AppState>, path: String, content: String) -> Result<(), String> {
    let root = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let target = resolve_under_root(&root, &path)?;
    let parent = target.parent().ok_or_else(|| "Invalid path".to_string())?;
    let root_canon = fs::canonicalize(&root).map_err(|e| format!("canonicalize root failed: {e}"))?;
    if !parent.starts_with(&root_canon) {
        return Err("Path is outside workspace root".to_string());
    }
    ensure_parent_dir(&target)?;
    fs::write(&target, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

fn drafts_dir(root: &Path) -> PathBuf {
    root.join("drafts")
}

fn restart_drafts_watcher(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let root = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let drafts = drafts_dir(&root);
    fs::create_dir_all(&drafts).map_err(|e| format!("create drafts dir failed: {e}"))?;

    if let Ok(mut guard) = state.drafts_watcher.lock() {
        *guard = None;
    }

    let app_for_cb = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = app_for_cb.emit(
                    "workspace://file_changed",
                    FileChanged {
                        path: p.to_string_lossy().to_string(),
                    },
                );
            }
        }
    })
    .map_err(|e| format!("watcher init failed: {e}"))?;

    watcher
        .watch(&drafts, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    if let Ok(mut guard) = state.drafts_watcher.lock() {
        *guard = Some(watcher);
    }

    Ok(())
}

fn tools_dir_from_app(_app: &AppHandle) -> Result<PathBuf, String> {
    // Dev default: current_dir is repo root. Sometimes it can be `src-tauri/`.
    let cwd = std::env::current_dir().map_err(|e| format!("current_dir failed: {e}"))?;
    let direct = cwd.join("tools");
    if direct.exists() {
        return Ok(direct);
    }
    let up = cwd.parent().map(|p| p.join("tools"));
    if let Some(p) = up {
        if p.exists() {
            return Ok(p);
        }
    }
    Ok(direct)
}

fn load_role_context(agent_id: &str, workspace_root: &Path) -> String {
    let mut parts: Vec<String> = vec![];
    let candidates: &[(&str, &[&str])] = &[
        ("claude", &["CLAUDE.md"]),
        ("codex", &["AGENTS.md", ".codex"]),
        ("cursor", &[".cursorrules"]),
        ("gemini", &["GEMINI.md"]),
    ];

    let mut files: Vec<&str> = vec![];
    for (id, cands) in candidates {
        if *id == agent_id {
            files.extend_from_slice(cands);
        }
    }
    for f in ["AGENTS.md", "CLAUDE.md"] {
        if !files.contains(&f) {
            files.push(f);
        }
    }

    for name in files {
        let p = workspace_root.join(name);
        if !p.exists() {
            continue;
        }
        if let Ok(s) = fs::read_to_string(&p) {
            parts.push(format!("## {}\n\n{}\n", name, s));
        }
    }

    if parts.is_empty() {
        return "".to_string();
    }
    format!(
        "ROLE CONTEXT (read carefully; obey if applicable)\n\n{}\nEND ROLE CONTEXT\n\n",
        parts.join("\n")
    )
}

fn maybe_write_result_files(app: &AppHandle, state: &AppState, v: &serde_json::Value) {
    let root = match state.workspace_root.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };

    let write_one = |path_s: &str, content_s: &str| {
        let target = match resolve_under_root(&root, path_s) {
            Ok(p) => p,
            Err(_) => return,
        };
        if ensure_parent_dir(&target).is_err() {
            return;
        }
        let _ = fs::write(&target, content_s);
        let _ = app.emit(
            "automation://file_written",
            FileWritten {
                path: target.to_string_lossy().to_string(),
            },
        );
    };

    if let Some(obj) = v.as_object() {
        if let (Some(p), Some(c)) = (obj.get("path"), obj.get("content")) {
            if let (Some(p), Some(c)) = (p.as_str(), c.as_str()) {
                write_one(p, c);
            }
        }
        if let Some(arr) = obj.get("write_files").and_then(|x| x.as_array()) {
            for item in arr {
                if let (Some(p), Some(c)) = (item.get("path"), item.get("content")) {
                    if let (Some(p), Some(c)) = (p.as_str(), c.as_str()) {
                        write_one(p, c);
                    }
                }
            }
        }
    }
}

fn handle_capture(app: &AppHandle, state: &AppState, session_id: &str, data: &str) {
    let session = match state.sessions.get(session_id) {
        Some(s) => s,
        None => return,
    };
    log_write(&session, "OUT ", data);

    let mut capture_guard = match session.capture.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let cap = match capture_guard.as_mut() {
        Some(c) => c,
        None => return,
    };

    cap.buf.push_str(data);
    if cap.buf.len() > 2_000_000 {
        cap.buf.drain(..1_000_000);
    }

    let begin = format!("BEGIN_RESULT {}", cap.task_id);
    let end = format!("END_RESULT {}", cap.task_id);

    let bpos = match cap.buf.find(&begin) {
        Some(p) => p + begin.len(),
        None => return,
    };
    let epos = match cap.buf.find(&end) {
        Some(p) => p,
        None => return,
    };
    if epos <= bpos {
        return;
    }

    let payload = cap.buf[bpos..epos].trim().to_string();
    let task_id = cap.task_id.clone();
    *capture_guard = None;

    let parsed_json = serde_json::from_str::<serde_json::Value>(&payload)
        .unwrap_or_else(|_| serde_json::Value::String(payload.clone()));

    if let Some(mut task) = state.tasks.get_mut(&task_id) {
        task.status = "completed".to_string();
        task.finished_at_ms = Some(now_ms());
        task.result_json = Some(parsed_json.clone());
    }
    save_tasks_to_disk(app, state);
    let _ = app.emit("automation://task_updated", &task_id);

    maybe_write_result_files(app, state, &parsed_json);

    if let Some((_, tx)) = state.task_waiters.remove(&task_id) {
        let _ = tx.send(parsed_json);
    }
}

#[tauri::command]
fn db_search(
    app: AppHandle,
    state: State<'_, AppState>,
    work: String,
    query: Option<String>,
    chapter: Option<i64>,
    k: Option<i64>,
) -> Result<DbSearchResult, String> {
    let workspace = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let tools_dir = tools_dir_from_app(&app)?;
    let script = tools_dir.join("db_search.py");

    if !script.exists() {
        return Err(format!("Missing tools script at {}", script.to_string_lossy()));
    }

    let mut cmd = Command::new("python3");
    cmd.arg(script);
    cmd.arg("--work").arg(&work);
    cmd.arg("--json");
    if let Some(q) = query {
        if !q.trim().is_empty() {
            cmd.arg("--query").arg(q);
        }
    }
    if let Some(ch) = chapter {
        cmd.arg("--chapter").arg(ch.to_string());
    }
    if let Some(kk) = k {
        cmd.arg("--k").arg(kk.to_string());
    }

    // Ensure DB relative paths resolve to workspace.
    cmd.current_dir(&workspace);

    let out = cmd.output().map_err(|e| format!("Failed to run db_search.py: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() && stdout.trim().is_empty() {
        return Ok(DbSearchResult {
            ok: false,
            mode: None,
            error: Some(stderr.trim().to_string()),
            hits: vec![],
        });
    }

    let parsed: DbSearchResult =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse db_search output failed: {e}"))?;
    Ok(parsed)
}

#[tauri::command]
fn db_list_chapters(
    app: AppHandle,
    state: State<'_, AppState>,
    work: String,
) -> Result<ChapterListResult, String> {
    let workspace = state.workspace_root.lock().map_err(|_| "workspace poisoned")?.clone();
    let tools_dir = tools_dir_from_app(&app)?;
    let script = tools_dir.join("db_list_chapters.py");

    if !script.exists() {
        return Err(format!(
            "Missing tools script at {}",
            script.to_string_lossy()
        ));
    }

    let mut cmd = Command::new("python3");
    cmd.arg(script);
    cmd.arg("--work").arg(&work);
    cmd.arg("--json");
    cmd.current_dir(&workspace);

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run db_list_chapters.py: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() && stdout.trim().is_empty() {
        return Ok(ChapterListResult {
            ok: false,
            error: Some(stderr.trim().to_string()),
            work: Some(work),
            chapters: vec![],
        });
    }

    let parsed: ChapterListResult = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Parse db_list_chapters output failed: {e}"))?;
    Ok(parsed)
}

#[tauri::command]
fn spawn_agent_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<SpawnResult, String> {
    // Reuse existing session if present.
    if let Some(existing) = state.agent_sessions.get(&agent_id) {
        if state.sessions.contains_key(existing.value()) {
            return Ok(SpawnResult {
                session_id: existing.value().clone(),
            });
        }
    }

    let agent = {
        let agents = state.agents.lock().map_err(|_| "agents poisoned")?;
        agents
            .iter()
            .find(|a| a.id == agent_id)
            .cloned()
            .ok_or_else(|| format!("Unknown agent id: {agent_id}"))?
    };

    let pty_system = native_pty_system();
    let pty_size = PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(agent.command);
    for a in agent.args {
        cmd.arg(a);
    }
    let cwd = state
        .workspace_root
        .lock()
        .map(|p| p.clone())
        .unwrap_or_else(|_| default_workspace_root());
    cmd.cwd(cwd.clone());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", preferred_path_env());

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    drop(pair.slave);

    let master = pair.master;
    let writer = master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    let log = open_session_log(&cwd, &agent_id, &session_id);

    state.sessions.insert(
        session_id.clone(),
        SessionHandle {
            agent_id: agent_id.clone(),
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            capture: Mutex::new(None),
            log_file: Mutex::new(log),
        },
    );
    state.agent_sessions.insert(agent_id.clone(), session_id.clone());

    let app_for_thread = app.clone();
    let session_id_for_thread = session_id.clone();
    std::thread::spawn(move || {
        let state = app_for_thread.state::<AppState>();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(
                        "terminal://output",
                        TerminalOutput {
                            session_id: session_id_for_thread.clone(),
                            data: s.clone(),
                        },
                    );
                    handle_capture(&app_for_thread, &state, &session_id_for_thread, &s);
                }
                Err(_) => break,
            }
        }
        // Natural PTY exit (EOF or read error): remove the session so the
        // frontend can rehydrate a fresh one when the user clicks Start.
        state.sessions.remove(&session_id_for_thread);
        state.agent_sessions.retain(|_, v| v != &session_id_for_thread);
        let _ = app_for_thread.emit(
            "terminal://exit",
            TerminalOutput {
                session_id: session_id_for_thread.clone(),
                data: "".to_string(),
            },
        );
    });

    Ok(SpawnResult { session_id })
}

#[tauri::command]
fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Unknown session id: {session_id}"))?;
    let mut writer = session.writer.lock().map_err(|_| "writer poisoned")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))?;
    log_write(&session, "IN  ", &data);
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Unknown session id: {session_id}"))?;
    let master = session.master.lock().map_err(|_| "master poisoned")?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_kill(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (_, session) = state
        .sessions
        .remove(&session_id)
        .ok_or_else(|| format!("Unknown session id: {session_id}"))?;
    state.agent_sessions.retain(|_, v| v != &session_id);
    let mut child = session.child.lock().map_err(|_| "child poisoned")?;
    let _ = child.kill();
    Ok(())
}

fn start_runner_if_needed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut started = match state.runner_started.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if *started {
        return;
    }
    *started = true;

    let app_for_thread = app.clone();
    std::thread::spawn(move || loop {
        let state = app_for_thread.state::<AppState>();
        let next_id = {
            let mut q = match state.task_queue.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            q.pop_front()
        };
        let task_id = match next_id {
            Some(t) => t,
            None => {
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
        };

        let (agent_id, prompt, title) = match state.tasks.get_mut(&task_id) {
            Some(mut t) => {
                t.status = "running".to_string();
                t.started_at_ms = Some(now_ms());
                (t.agent_id.clone(), t.prompt.clone(), t.title.clone())
            }
            None => continue,
        };
        save_tasks_to_disk(&app_for_thread, &state);
        let _ = app_for_thread.emit("automation://task_updated", &task_id);

        let session_id = match spawn_agent_terminal(app_for_thread.clone(), state.clone(), agent_id.clone()) {
            Ok(r) => r.session_id,
            Err(e) => {
                if let Some(mut t) = state.tasks.get_mut(&task_id) {
                    t.status = "failed".to_string();
                    t.finished_at_ms = Some(now_ms());
                    t.error = Some(e);
                }
                save_tasks_to_disk(&app_for_thread, &state);
                let _ = app_for_thread.emit("automation://task_updated", &task_id);
                continue;
            }
        };

        if let Some(mut t) = state.tasks.get_mut(&task_id) {
            t.session_id = Some(session_id.clone());
        }

        let role_ctx = {
            let ws = state
                .workspace_root
                .lock()
                .map(|p| p.clone())
                .unwrap_or_else(|_| default_workspace_root());
            load_role_context(&agent_id, &ws)
        };

        let mut full_prompt = String::new();
        full_prompt.push_str("\n\n");
        full_prompt.push_str(&format!("# TASK {}\n", task_id));
        full_prompt.push_str(&format!("# TITLE {}\n\n", title));
        if !role_ctx.is_empty() {
            full_prompt.push_str(&role_ctx);
        }
        full_prompt.push_str(&prompt);
        full_prompt.push_str("\n\n");
        full_prompt.push_str(&format!(
            "When finished, output ONLY valid JSON between these exact markers:\nBEGIN_RESULT {}\n<json>\nEND_RESULT {}\n",
            task_id, task_id
        ));
        full_prompt.push_str("\n");

        // Install capture state.
        if let Some(session) = state.sessions.get(&session_id) {
            if let Ok(mut cap) = session.capture.lock() {
                *cap = Some(CaptureState {
                    task_id: task_id.clone(),
                    buf: String::new(),
                });
            }
        }

        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        state.task_waiters.insert(task_id.clone(), tx);

        // Send prompt.
        let write_res = (|| -> Result<(), String> {
            let session = state
                .sessions
                .get(&session_id)
                .ok_or_else(|| "Session vanished".to_string())?;
            let mut w = session.writer.lock().map_err(|_| "writer poisoned")?;
            w.write_all(full_prompt.as_bytes())
                .map_err(|e| format!("write failed: {e}"))?;
            w.flush().map_err(|e| format!("flush failed: {e}"))?;
            log_write(&session, "IN  ", &full_prompt);
            Ok(())
        })();

        if let Err(e) = write_res {
            state.task_waiters.remove(&task_id);
            if let Some(mut t) = state.tasks.get_mut(&task_id) {
                t.status = "failed".to_string();
                t.finished_at_ms = Some(now_ms());
                t.error = Some(e);
            }
            save_tasks_to_disk(&app_for_thread, &state);
            let _ = app_for_thread.emit("automation://task_updated", &task_id);
            continue;
        }

        let result = rx.recv_timeout(std::time::Duration::from_secs(600));
        if result.is_err() {
            state.task_waiters.remove(&task_id);
            if let Some(mut t) = state.tasks.get_mut(&task_id) {
                t.status = "failed".to_string();
                t.finished_at_ms = Some(now_ms());
                t.error = Some("Timed out waiting for result markers.".to_string());
            }
            save_tasks_to_disk(&app_for_thread, &state);
            let _ = app_for_thread.emit("automation://task_updated", &task_id);
        }
    });
}

#[tauri::command]
fn automation_enqueue_task(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    title: String,
    prompt: String,
) -> Result<AutomationEnqueueResult, String> {
    let id = Uuid::new_v4().to_string();
    let task = AutomationTask {
        id: id.clone(),
        agent_id,
        title,
        prompt,
        status: "queued".to_string(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        session_id: None,
        result_json: None,
        error: None,
    };
    state.tasks.insert(id.clone(), task);
    {
        let mut q = state.task_queue.lock().map_err(|_| "queue poisoned")?;
        q.push_back(id.clone());
    }
    start_runner_if_needed(&app);
    save_tasks_to_disk(&app, &state);
    let _ = app.emit("automation://task_updated", &id);
    Ok(AutomationEnqueueResult { task_id: id })
}

#[tauri::command]
fn automation_list_tasks(state: State<'_, AppState>) -> Vec<AutomationTask> {
    state.tasks.iter().map(|t| t.value().clone()).collect()
}

#[tauri::command]
fn automation_write_chapter(
    app: AppHandle,
    state: State<'_, AppState>,
    chapter_num: i64,
    brief: String,
) -> Result<Vec<String>, String> {
    let path = format!("drafts/ch{}.md", chapter_num);
    let prompt = format!(
        "Write chapter {} as Markdown for this project.\n\nBrief:\n{}\n\nReturn JSON with keys: path, content.\nSet path to \"{}\".\n",
        chapter_num, brief, path
    );
    let res = automation_enqueue_task(
        app,
        state,
        "claude".to_string(),
        format!("Write Chapter {}", chapter_num),
        prompt,
    )?;
    Ok(vec![res.task_id])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            agents: Mutex::new(vec![]),
            workspace_root: Mutex::new(default_workspace_root()),
            drafts_watcher: Mutex::new(None),
            sessions: DashMap::new(),
            agent_sessions: DashMap::new(),
            tasks: DashMap::new(),
            task_queue: Mutex::new(VecDeque::new()),
            task_waiters: DashMap::new(),
            runner_started: Mutex::new(false),
        })
        .setup(|app| {
            let agents = load_agents(app.handle()).unwrap_or_else(|_| default_agents());
            if let Ok(mut guard) = app.state::<AppState>().agents.lock() {
                *guard = agents;
            }
            let ws = load_workspace_root(app.handle());
            if let Ok(mut guard) = app.state::<AppState>().workspace_root.lock() {
                *guard = ws;
            }
            let state = app.state::<AppState>();
            let mut had_interrupted_or_pending = false;
            for mut task in load_tasks_from_disk(app.handle()) {
                match task.status.as_str() {
                    "running" => {
                        task.status = "failed".into();
                        task.error = Some("Interrupted by app restart".into());
                        task.finished_at_ms = Some(now_ms());
                        had_interrupted_or_pending = true;
                    }
                    "queued" => {
                        if let Ok(mut q) = state.task_queue.lock() {
                            q.push_back(task.id.clone());
                        }
                        had_interrupted_or_pending = true;
                    }
                    _ => {}
                }
                state.tasks.insert(task.id.clone(), task);
            }
            if had_interrupted_or_pending {
                save_tasks_to_disk(app.handle(), &state);
                start_runner_if_needed(app.handle());
            }
            let _ = restart_drafts_watcher(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            get_workspace,
            get_workspace_status,
            set_workspace,
            pick_workspace_folder,
            list_agent_availability,
            fs_list_dir,
            fs_read_file,
            fs_write_file,
            db_list_chapters,
            db_search,
            spawn_agent_terminal,
            terminal_write,
            terminal_resize,
            terminal_kill,
            automation_enqueue_task,
            automation_list_tasks,
            automation_write_chapter
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_temp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("writer-orch-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).expect("create temp root");
        p
    }

    #[test]
    fn normalize_path_lexical_collapses_dot_segments() {
        let p = PathBuf::from("/tmp/a/./b/../c");
        let out = normalize_path_lexical(&p);
        assert_eq!(out, PathBuf::from("/tmp/a/c"));
    }

    #[test]
    fn resolve_under_root_allows_relative_paths_in_root() {
        let root = mk_temp_root();
        let resolved = resolve_under_root(&root, "drafts/ch1.md").expect("resolve");
        assert!(resolved.starts_with(fs::canonicalize(&root).expect("canon root")));
    }

    #[test]
    fn resolve_under_root_rejects_escape() {
        let root = mk_temp_root();
        let err = resolve_under_root(&root, "../../etc/passwd").expect_err("must reject");
        assert!(err.to_lowercase().contains("outside workspace"));
    }

    #[test]
    fn command_in_path_detects_existing_binary() {
        assert!(command_in_path("sh"));
    }

    #[test]
    fn command_in_path_rejects_missing_binary() {
        assert!(!command_in_path("writer_orch_cmd_that_should_not_exist_12345"));
    }
}
