mod scanner;

use scanner::SessionMetadata;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct AppState {
    claude_dir: PathBuf,
    sessions: Mutex<Vec<SessionMetadata>>,
    active_session: Mutex<Option<String>>,
}

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Result<Vec<SessionMetadata>, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.is_empty() {
        *sessions = scanner::scan_all_sessions(&state.claude_dir).map_err(|e| e.to_string())?;
    }
    Ok(sessions.clone())
}

#[tauri::command]
fn refresh_sessions(state: State<AppState>) -> Result<Vec<SessionMetadata>, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    *sessions = scanner::scan_all_sessions(&state.claude_dir).map_err(|e| e.to_string())?;
    Ok(sessions.clone())
}

#[tauri::command]
fn get_conversation(
    state: State<AppState>,
    session_id: String,
    project_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<scanner::ConversationPage, String> {
    let jsonl_path = state
        .claude_dir
        .join("projects")
        .join(&project_path)
        .join(format!("{}.jsonl", session_id));
    let all = scanner::parse_conversation(&jsonl_path).map_err(|e| e.to_string())?;
    let total = all.len();
    let lim = limit.unwrap_or(100);
    let off = offset.unwrap_or_else(|| total.saturating_sub(lim));
    let page: Vec<scanner::ConversationMessage> = all.into_iter().skip(off).take(lim).collect();
    let has_more_above = off > 0;
    Ok(scanner::ConversationPage {
        messages: page,
        total_count: total,
        has_more: has_more_above,
        offset: off,
    })
}

#[tauri::command]
fn search_sessions(
    state: State<AppState>,
    query: String,
) -> Result<Vec<scanner::SearchHit>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.is_empty() {
        return Ok(vec![]);
    }
    scanner::search_all(&state.claude_dir, &sessions, &query).map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_claude_code(directory: Option<String>, resume_session: Option<String>) -> Result<String, String> {
    let script = if let Some(session_id) = &resume_session {
        let dir = directory.unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        format!("tell application \"Terminal\" to do script \"cd {} && claude --resume {}\"", dir, session_id)
    } else {
        let dir = directory.unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        format!("tell application \"Terminal\" to do script \"cd {} && claude\"", dir)
    };
    std::process::Command::new("osascript").arg("-e").arg(&script).spawn()
        .map_err(|e| format!("Failed to launch: {}", e))?;
    Ok("launched".to_string())
}

/// Send a message to Claude using --print mode with stream-json output.
/// Each call spawns a new process that resumes the session, sends the message,
/// streams the response, and exits. The session persists via --resume.
#[tauri::command]
fn send_claude_message(
    state: State<AppState>,
    app: tauri::AppHandle,
    session_id: String,
    message: String,
    directory: Option<String>,
    dangerous_mode: bool,
) -> Result<String, String> {
    let dir = directory.unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());

    // Track active session
    {
        let mut active = state.active_session.lock().map_err(|e| e.to_string())?;
        *active = Some(session_id.clone());
    }

    let sid = session_id.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new("claude");
        cmd.arg("--print")
           .arg("--resume").arg(&sid)
           .arg("--output-format").arg("stream-json")
           .arg("--verbose");
        if dangerous_mode {
            cmd.arg("--dangerously-skip-permissions");
        }
        cmd.arg(&message);
        cmd.current_dir(&dir);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        match cmd.spawn() {
            Ok(mut child) => {
                // Stream stdout
                if let Some(stdout) = child.stdout.take() {
                    use std::io::BufRead;
                    let reader = std::io::BufReader::new(stdout);
                    for line in reader.lines().flatten() {
                        // Each line is a JSON object from stream-json format
                        let _ = app_handle.emit("claude-stream", serde_json::json!({
                            "sessionId": sid,
                            "data": line,
                        }));
                    }
                }
                let _ = child.wait();
                let _ = app_handle.emit("claude-done", serde_json::json!({
                    "sessionId": sid,
                }));
            }
            Err(e) => {
                let _ = app_handle.emit("claude-stream", serde_json::json!({
                    "sessionId": sid,
                    "data": format!("{{\"type\":\"error\",\"error\":\"Failed to start: {}\"}}", e),
                }));
                let _ = app_handle.emit("claude-done", serde_json::json!({
                    "sessionId": sid,
                }));
            }
        }
    });

    Ok("sending".to_string())
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> Result<serde_json::Value, String> {
    let stats_path = state.claude_dir.join("stats-cache.json");
    if !stats_path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&stats_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// Scan all sessions to build a detailed activity heatmap from actual message timestamps.
/// Returns {daily: {"2026-01-15": count}, hourly: {"2026-01-15T14": count}}
#[tauri::command]
fn get_activity_data(state: State<AppState>) -> Result<serde_json::Value, String> {
    let projects_dir = state.claude_dir.join("projects");
    if !projects_dir.exists() {
        return Ok(serde_json::json!({"daily": {}, "hourly": {}}));
    }

    let mut daily: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut hourly: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    for project_entry in std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let project_entry = project_entry.map_err(|e| e.to_string())?;
        if !project_entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        for file_entry in std::fs::read_dir(project_entry.path()).map_err(|e| e.to_string())? {
            let file_entry = file_entry.map_err(|e| e.to_string())?;
            let path = file_entry.path();
            if path.extension().map_or(true, |e| e != "jsonl") { continue; }

            if let Ok(file) = std::fs::File::open(&path) {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(file);
                for line in reader.lines().flatten() {
                    // Quick extract timestamp without full JSON parse
                    if let Some(ts_start) = line.find("\"timestamp\":\"") {
                        let ts_slice = &line[ts_start + 13..];
                        if let Some(ts_end) = ts_slice.find('"') {
                            let ts = &ts_slice[..ts_end];
                            if ts.len() >= 13 {
                                // "2026-03-04T06:43:18.504Z"
                                let day = &ts[..10];  // "2026-03-04"
                                let hour = &ts[..13]; // "2026-03-04T06"
                                *daily.entry(day.to_string()).or_insert(0) += 1;
                                *hourly.entry(hour.to_string()).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "daily": daily,
        "hourly": hourly,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let claude_dir = dirs::home_dir()
        .expect("Could not find home directory")
        .join(".claude");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            claude_dir,
            sessions: Mutex::new(Vec::new()),
            active_session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            refresh_sessions,
            get_conversation,
            search_sessions,
            launch_claude_code,
            send_claude_message,
            get_stats,
            get_activity_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
