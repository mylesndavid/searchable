use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// ── Types exposed to frontend ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub session_id: String,
    pub project_path: String,
    pub project_display: String,
    pub slug: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub first_message_preview: String,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub message_count: u32,
    pub user_message_count: u32,
    pub assistant_message_count: u32,
    pub tool_call_count: u32,
    pub models_used: Vec<String>,
    pub tools_used: HashMap<String, u32>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub subagent_count: u32,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type", rename_all_fields = "camelCase")]
pub enum ConversationMessage {
    #[serde(rename = "user")]
    User {
        uuid: String,
        timestamp: String,
        content: String,
    },
    #[serde(rename = "assistant")]
    Assistant {
        uuid: String,
        timestamp: String,
        text_blocks: Vec<String>,
        thinking_summary: Option<String>,
        tool_calls: Vec<ToolCallInfo>,
        model: Option<String>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInfo {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub messages: Vec<ConversationMessage>,
    pub total_count: usize,
    pub has_more: bool,
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub project_path: String,
    pub slug: Option<String>,
    pub message_uuid: String,
    pub message_type: String,
    pub timestamp: String,
    pub snippet: String,
    pub git_branch: Option<String>,
}

// ── Internal parsing types ───────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    uuid: Option<String>,
    timestamp: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    slug: Option<String>,
    message: Option<RawMessage>,
    #[serde(default)]
    is_sidechain: bool,
    source_tool_assistant_uuid: Option<String>,
    tool_use_result: Option<serde_json::Value>,
}

/// Strip ANSI escape codes from a string
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip escape sequence
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // Skip until we hit a letter (the terminator)
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMessage {
    role: Option<String>,
    model: Option<String>,
    content: Option<serde_json::Value>,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct RawUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

// ── Session Scanner ──────────────────────────────────────────────────────────

fn decode_project_path(encoded: &str) -> String {
    // "-Users-myles-gravity-Development-Gravity" -> "~/Development/Gravity"
    let parts: Vec<&str> = encoded.split('-').collect();
    if parts.len() >= 3 && parts[0].is_empty() && parts[1] == "Users" {
        // Skip "-Users-<username>" prefix, reconstruct path
        let username = parts[2];
        let home = dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("/Users/{}", username));
        if parts.len() > 3 {
            let rest = parts[3..].join("/");
            format!("~/{}", rest)
        } else {
            "~".to_string()
        }
    } else {
        encoded.replace('-', "/")
    }
}

pub fn scan_all_sessions(claude_dir: &Path) -> Result<Vec<SessionMetadata>, Box<dyn std::error::Error>> {
    let projects_dir = claude_dir.join("projects");
    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    for project_entry in std::fs::read_dir(&projects_dir)? {
        let project_entry = project_entry?;
        if !project_entry.file_type()?.is_dir() {
            continue;
        }
        let project_name = project_entry.file_name().to_string_lossy().to_string();
        let project_dir = project_entry.path();

        for file_entry in std::fs::read_dir(&project_dir)? {
            let file_entry = file_entry?;
            let path = file_entry.path();
            if path.extension().map_or(true, |e| e != "jsonl") {
                continue;
            }
            let session_id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            // Count subagents
            let subagent_dir = project_dir.join(&session_id).join("subagents");
            let subagent_count = if subagent_dir.exists() {
                std::fs::read_dir(&subagent_dir)
                    .map(|rd| rd.filter(|e| e.is_ok()).count() as u32)
                    .unwrap_or(0)
            } else {
                0
            };

            match scan_session_file(&path, &session_id, &project_name, subagent_count) {
                Ok(meta) => sessions.push(meta),
                Err(e) => eprintln!("Warning: failed to scan {}: {}", path.display(), e),
            }
        }
    }

    // Sort by most recent first
    sessions.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    Ok(sessions)
}

fn scan_session_file(
    path: &Path,
    session_id: &str,
    project_name: &str,
    subagent_count: u32,
) -> Result<SessionMetadata, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let reader = BufReader::with_capacity(64 * 1024, file);

    let mut first_timestamp: Option<String> = None;
    let mut last_timestamp: Option<String> = None;
    let mut slug: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut last_user_text = String::new();
    let mut message_count: u32 = 0;
    let mut user_count: u32 = 0;
    let mut assistant_count: u32 = 0;
    let mut tool_call_count: u32 = 0;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut models: HashMap<String, bool> = HashMap::new();
    let mut tools: HashMap<String, u32> = HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let entry: RawEntry = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip sidechain (subagent progress) messages
        if entry.is_sidechain {
            continue;
        }

        let entry_type = entry.entry_type.as_deref().unwrap_or("");

        // Track timestamps
        if let Some(ts) = &entry.timestamp {
            if first_timestamp.is_none() {
                first_timestamp = Some(ts.clone());
            }
            last_timestamp = Some(ts.clone());
        }

        // Take slug, cwd, branch from first message that has them
        if slug.is_none() {
            slug = entry.slug;
        }
        if cwd.is_none() {
            cwd = entry.cwd;
        }
        if git_branch.is_none() {
            git_branch = entry.git_branch;
        }

        match entry_type {
            "user" => {
                // Skip tool results (they have sourceToolAssistantUUID)
                if entry.source_tool_assistant_uuid.is_some() || entry.tool_use_result.is_some() {
                    continue;
                }
                user_count += 1;
                message_count += 1;

                if let Some(msg) = &entry.message {
                    let text = extract_user_text(&msg.content);
                    if !text.is_empty() {
                        last_user_text = text;
                    }
                }
            }
            "assistant" => {
                assistant_count += 1;
                message_count += 1;

                if let Some(msg) = &entry.message {
                    // Track model
                    if let Some(model) = &msg.model {
                        models.insert(model.clone(), true);
                    }
                    // Track tokens
                    if let Some(usage) = &msg.usage {
                        total_input += usage.input_tokens.unwrap_or(0)
                            + usage.cache_read_input_tokens.unwrap_or(0)
                            + usage.cache_creation_input_tokens.unwrap_or(0);
                        total_output += usage.output_tokens.unwrap_or(0);
                    }
                    // Count tool calls
                    if let Some(content) = &msg.content {
                        if let Some(arr) = content.as_array() {
                            for block in arr {
                                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                    tool_call_count += 1;
                                    if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                                        *tools.entry(name.to_string()).or_insert(0) += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Truncate first message preview
    if last_user_text.len() > 200 {
        last_user_text.truncate(200);
        last_user_text.push_str("...");
    }

    Ok(SessionMetadata {
        session_id: session_id.to_string(),
        project_path: project_name.to_string(),
        project_display: decode_project_path(project_name),
        slug,
        cwd,
        git_branch,
        first_message_preview: last_user_text,
        first_timestamp,
        last_timestamp,
        message_count,
        user_message_count: user_count,
        assistant_message_count: assistant_count,
        tool_call_count,
        models_used: models.into_keys().collect(),
        tools_used: tools,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        subagent_count,
        file_size_bytes: file_size,
    })
}

fn extract_user_text(content: &Option<serde_json::Value>) -> String {
    let raw = match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => {
            let mut text = String::new();
            for item in arr {
                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                    text = t.to_string();
                    break;
                }
                if let Some(c) = item.get("content").and_then(|c| c.as_str()) {
                    text = c.to_string();
                    break;
                }
            }
            text
        }
        _ => String::new(),
    };
    strip_ansi(&raw)
}

/// Extract text from a tool_result content field.
/// Content can be a string, or an array of {type: "text", text: "..."} blocks.
fn extract_tool_result_text(content: &serde_json::Value) -> String {
    let raw = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                }
            }
            if parts.is_empty() {
                serde_json::to_string(content).unwrap_or_default()
            } else {
                parts.join("\n")
            }
        }
        _ => serde_json::to_string(content).unwrap_or_default(),
    };
    strip_ansi(&raw)
}

// ── Conversation Parser ──────────────────────────────────────────────────────

pub fn parse_conversation(path: &Path) -> Result<Vec<ConversationMessage>, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(64 * 1024, file);

    // First pass: collect all entries and build tool result map
    let mut entries: Vec<RawEntry> = Vec::new();
    let mut tool_results: HashMap<String, String> = HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let entry: RawEntry = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.is_sidechain {
            continue;
        }

        // If this is a tool result, map tool_use_id -> result content
        if entry.entry_type.as_deref() == Some("user") {
            if entry.source_tool_assistant_uuid.is_some() || entry.tool_use_result.is_some() {
                if let Some(msg) = &entry.message {
                    if let Some(content) = &msg.content {
                        if let Some(arr) = content.as_array() {
                            for block in arr {
                                if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                                    if let Some(tool_use_id) = block.get("tool_use_id").and_then(|t| t.as_str()) {
                                        let result_text = block
                                            .get("content")
                                            .map(|c| extract_tool_result_text(c))
                                            .unwrap_or_default();
                                        // Truncate very long results for the frontend
                                        let truncated = if result_text.len() > 10000 {
                                            format!("{}...\n[truncated, {} total bytes]", &result_text[..10000], result_text.len())
                                        } else {
                                            result_text
                                        };
                                        tool_results.insert(tool_use_id.to_string(), truncated);
                                    }
                                }
                            }
                        }
                    }
                }
                continue; // Don't add tool results as standalone messages
            }
        }

        entries.push(entry);
    }

    // Second pass: build conversation messages
    let mut messages = Vec::new();

    for entry in &entries {
        let entry_type = entry.entry_type.as_deref().unwrap_or("");
        let uuid = entry.uuid.clone().unwrap_or_default();
        let timestamp = entry.timestamp.clone().unwrap_or_default();

        match entry_type {
            "user" => {
                // Double-check: skip if this is a tool result that slipped through
                if entry.source_tool_assistant_uuid.is_some() || entry.tool_use_result.is_some() {
                    continue;
                }
                // Also skip if content is only tool_result blocks
                if let Some(msg) = &entry.message {
                    if let Some(serde_json::Value::Array(arr)) = &msg.content {
                        let all_tool_results = !arr.is_empty() && arr.iter().all(|b| {
                            b.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                        });
                        if all_tool_results {
                            continue;
                        }
                    }
                }
                let content = entry
                    .message
                    .as_ref()
                    .map(|m| extract_user_text(&m.content))
                    .unwrap_or_default();
                if !content.is_empty() {
                    messages.push(ConversationMessage::User {
                        uuid,
                        timestamp,
                        content,
                    });
                }
            }
            "assistant" => {
                if let Some(msg) = &entry.message {
                    let mut text_blocks = Vec::new();
                    let mut thinking_summary: Option<String> = None;
                    let mut tool_calls = Vec::new();

                    if let Some(content) = &msg.content {
                        if let Some(arr) = content.as_array() {
                            for block in arr {
                                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                match block_type {
                                    "text" => {
                                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                            if !text.trim().is_empty() {
                                                text_blocks.push(text.to_string());
                                            }
                                        }
                                    }
                                    "thinking" => {
                                        if let Some(thinking) = block.get("thinking").and_then(|t| t.as_str()) {
                                            // Just take first 200 chars as summary
                                            let summary = if thinking.len() > 200 {
                                                format!("{}...", &thinking[..200])
                                            } else {
                                                thinking.to_string()
                                            };
                                            thinking_summary = Some(summary);
                                        }
                                    }
                                    "tool_use" => {
                                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                                        let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                        let result = tool_results.get(&id).cloned();

                                        tool_calls.push(ToolCallInfo { id, name, input, result });
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }

                    let input_tokens = msg.usage.as_ref().and_then(|u| {
                        Some(
                            u.input_tokens.unwrap_or(0)
                                + u.cache_read_input_tokens.unwrap_or(0)
                                + u.cache_creation_input_tokens.unwrap_or(0),
                        )
                    });
                    let output_tokens = msg.usage.as_ref().and_then(|u| u.output_tokens);

                    messages.push(ConversationMessage::Assistant {
                        uuid,
                        timestamp,
                        text_blocks,
                        thinking_summary,
                        tool_calls,
                        model: msg.model.clone(),
                        input_tokens,
                        output_tokens,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(messages)
}

// ── Search ───────────────────────────────────────────────────────────────────

pub fn search_all(
    claude_dir: &Path,
    sessions: &[SessionMetadata],
    query: &str,
) -> Result<Vec<SearchHit>, Box<dyn std::error::Error>> {
    let query_lower = query.to_lowercase();
    let mut hits = Vec::new();

    for session in sessions {
        let jsonl_path = claude_dir
            .join("projects")
            .join(&session.project_path)
            .join(format!("{}.jsonl", session.session_id));

        if !jsonl_path.exists() {
            continue;
        }

        let file = match File::open(&jsonl_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::with_capacity(64 * 1024, file);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            // Quick check: does the line contain the query at all?
            if !line.to_lowercase().contains(&query_lower) {
                continue;
            }

            let entry: RawEntry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue,
            };

            if entry.is_sidechain {
                continue;
            }

            let entry_type = entry.entry_type.as_deref().unwrap_or("");
            if entry_type != "user" && entry_type != "assistant" {
                continue;
            }

            // Extract text content and check for match
            let text = if let Some(msg) = &entry.message {
                match &msg.content {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(arr)) => {
                        let mut parts = Vec::new();
                        for block in arr {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                parts.push(t.to_string());
                            }
                            if let Some(t) = block.get("content").and_then(|t| t.as_str()) {
                                parts.push(t.to_string());
                            }
                            // Search tool inputs too
                            if let Some(input) = block.get("input") {
                                if let Some(cmd) = input.get("command").and_then(|c| c.as_str()) {
                                    parts.push(cmd.to_string());
                                }
                                if let Some(fp) = input.get("file_path").and_then(|f| f.as_str()) {
                                    parts.push(fp.to_string());
                                }
                            }
                        }
                        parts.join(" ")
                    }
                    _ => String::new(),
                }
            } else {
                String::new()
            };

            if !text.to_lowercase().contains(&query_lower) {
                continue;
            }

            // Build snippet with context around the match
            let snippet = build_snippet(&text, &query_lower, 150);

            hits.push(SearchHit {
                session_id: session.session_id.clone(),
                project_path: session.project_path.clone(),
                slug: session.slug.clone(),
                message_uuid: entry.uuid.unwrap_or_default(),
                message_type: entry_type.to_string(),
                timestamp: entry.timestamp.unwrap_or_default(),
                snippet,
                git_branch: session.git_branch.clone(),
            });

            // Limit hits per session to prevent one giant session from dominating
            if hits.len() >= 100 {
                return Ok(hits);
            }
        }
    }

    Ok(hits)
}

fn build_snippet(text: &str, query_lower: &str, context_chars: usize) -> String {
    let text_lower = text.to_lowercase();
    if let Some(pos) = text_lower.find(query_lower) {
        // Find char-safe boundaries by snapping to char boundaries
        let mut start = pos.saturating_sub(context_chars);
        while start > 0 && !text.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = (pos + query_lower.len() + context_chars).min(text.len());
        while end < text.len() && !text.is_char_boundary(end) {
            end += 1;
        }
        let mut snippet = String::new();
        if start > 0 {
            snippet.push_str("...");
        }
        snippet.push_str(&text[start..end]);
        if end < text.len() {
            snippet.push_str("...");
        }
        snippet
    } else {
        text.chars().take(300).collect()
    }
}
