import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import {
  Search, RefreshCw, MessageSquare, GitBranch, Wrench,
  Terminal, FileEdit, Eye, FileText, Code, Loader2,
  ArrowLeft, Play, BarChart3, Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  projectDisplay: string;
  slug: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstMessagePreview: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  modelsUsed: string[];
  toolsUsed: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  subagentCount: number;
  fileSizeBytes: number;
}

interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, any>;
  result: string | null;
}

interface SearchHit {
  sessionId: string;
  projectPath: string;
  slug: string | null;
  messageUuid: string;
  messageType: string;
  timestamp: string;
  snippet: string;
  gitBranch: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function timeAgo(ts: string | null): string {
  if (!ts) return "";
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); } catch { return ts; }
}

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

function toolIcon(name: string) {
  const c = "w-3.5 h-3.5";
  switch (name) {
    case "Bash": return <Terminal className={c} />;
    case "Edit": return <FileEdit className={c} />;
    case "Read": return <Eye className={c} />;
    case "Write": return <FileText className={c} />;
    case "Grep": case "Glob": return <Search className={c} />;
    case "Agent": return <Zap className={c} />;
    default: return <Code className={c} />;
  }
}

function toolSummary(tool: ToolCallInfo): string {
  const { name, input } = tool;
  if (name === "Bash") return input.description || input.command?.substring(0, 80) || "";
  if (name === "Edit" || name === "Read" || name === "Write") return input.file_path || "";
  if (name === "Grep") return `"${input.pattern || ""}" ${input.path || ""}`;
  if (name === "Glob") return input.pattern || "";
  if (name === "Agent") return input.description || "";
  if (name === "WebSearch") return input.query || "";
  return "";
}

function CopyCommandButton({ cwd, sessionId }: { cwd: string | null; sessionId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        const cmd = `cd ${cwd || "~"} && claude --resume ${sessionId} --dangerously-skip-permissions`;
        navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition-all ${
        copied ? "text-green-400 border-green-600/50 bg-green-950/20" : "text-neutral-400 hover:text-white border-neutral-800 hover:bg-neutral-800"
      }`}
    >
      <Code className="w-3.5 h-3.5" /> {copied ? "Copied!" : "Copy Command"}
    </button>
  );
}

// ── Markdown Renderer ────────────────────────────────────────────────────────

function Md({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return <code className="bg-neutral-800 text-orange-300 px-1 py-0.5 rounded text-[13px]" {...props}>{children}</code>;
          }
          return (
            <pre className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 overflow-x-auto my-2">
              <code className="text-[13px] text-neutral-300" {...props}>{children}</code>
            </pre>
          );
        },
        p({ children }) { return <p className="mb-2 last:mb-0">{children}</p>; },
        ul({ children }) { return <ul className="list-disc ml-4 mb-2 space-y-0.5">{children}</ul>; },
        ol({ children }) { return <ol className="list-decimal ml-4 mb-2 space-y-0.5">{children}</ol>; },
        li({ children }) { return <li className="text-sm">{children}</li>; },
        h1({ children }) { return <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>; },
        h2({ children }) { return <h2 className="text-base font-bold mt-3 mb-1">{children}</h2>; },
        h3({ children }) { return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>; },
        a({ href, children }) { return <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noopener">{children}</a>; },
        blockquote({ children }) { return <blockquote className="border-l-2 border-neutral-700 pl-3 text-neutral-400 italic my-2">{children}</blockquote>; },
        table({ children }) { return <table className="border-collapse text-xs my-2 w-full">{children}</table>; },
        th({ children }) { return <th className="border border-neutral-700 px-2 py-1 text-left bg-neutral-800">{children}</th>; },
        td({ children }) { return <td className="border border-neutral-800 px-2 py-1">{children}</td>; },
      }}
    >
      {children}
    </Markdown>
  );
}


// ── Session Card ─────────────────────────────────────────────────────────────

function SessionCard({
  session, onClick, onResume, customName,
}: {
  session: SessionMetadata;
  onClick: () => void;
  onResume: () => void;
  customName?: string | null;
}) {
  const topTools = Object.entries(session.toolsUsed).sort(([, a], [, b]) => b - a).slice(0, 4);
  return (
    <div className="group w-full text-left p-4 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800/80 hover:border-neutral-700 transition-all">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onClick} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-white truncate">
              {customName || session.slug || session.sessionId.substring(0, 12)}
            </span>
            {customName && session.slug && (
              <span className="text-[10px] text-neutral-600 truncate">{session.slug}</span>
            )}
            {session.gitBranch && session.gitBranch !== "HEAD" && (
              <span className="flex items-center gap-1 text-xs text-purple-400 shrink-0">
                <GitBranch className="w-3 h-3" />
                {session.gitBranch.length > 25 ? session.gitBranch.substring(0, 25) + "..." : session.gitBranch}
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-500 mb-2">{session.projectDisplay}</div>
          <p className="text-sm text-neutral-400 line-clamp-2 leading-relaxed">{session.firstMessagePreview}</p>
        </button>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="text-xs text-neutral-500">{timeAgo(session.lastTimestamp)}</div>
          <button
            onClick={(e) => { e.stopPropagation(); onResume(); }}
            className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs bg-green-600 hover:bg-green-500 text-white px-2 py-1 rounded transition-all"
            title="Resume this session in Claude Code"
          >
            <Play className="w-3 h-3" /> Resume
          </button>
        </div>
      </div>
      <button onClick={onClick} className="w-full text-left">
        <div className="flex items-center gap-4 mt-3 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{session.messageCount}</span>
          <span className="flex items-center gap-1"><Wrench className="w-3 h-3" />{session.toolCallCount}</span>
          <span>{fmtTokens(session.totalOutputTokens)} out</span>
          {session.subagentCount > 0 && <span className="text-blue-400">{session.subagentCount} agents</span>}
          <div className="flex-1" />
          {topTools.map(([name, count]) => (
            <span key={name} className="flex items-center gap-0.5" title={`${name}: ${count}`}>
              {toolIcon(name)}<span>{count}</span>
            </span>
          ))}
        </div>
      </button>
    </div>
  );
}

// ── Tool Call Block ──────────────────────────────────────────────────────────

function ToolCallBlock({ tool }: { tool: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(tool);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 my-2 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-2 w-full text-left hover:bg-neutral-800/50 transition-colors"
      >
        <span className="text-neutral-500">{toolIcon(tool.name)}</span>
        <span className="text-xs font-mono font-semibold text-neutral-300">{tool.name}</span>
        <span className="text-xs text-neutral-500 truncate flex-1">{summary}</span>
        {tool.result && <span className="text-[10px] text-neutral-600 shrink-0">{tool.result.length > 1000 ? `${(tool.result.length/1000).toFixed(0)}K chars` : `${tool.result.length} chars`}</span>}
        <span className="text-neutral-600 text-xs">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-neutral-800 p-3 space-y-2 max-h-[500px] overflow-y-auto">
          {tool.name === "Edit" && tool.input.file_path && (
            <>
              <div className="text-xs font-mono text-neutral-500">{tool.input.file_path}</div>
              {tool.input.old_string && (
                <pre className="text-xs bg-red-950/20 text-red-300/80 p-2 rounded border border-red-900/30 overflow-x-auto whitespace-pre-wrap">{tool.input.old_string}</pre>
              )}
              {tool.input.new_string && (
                <pre className="text-xs bg-green-950/20 text-green-300/80 p-2 rounded border border-green-900/30 overflow-x-auto whitespace-pre-wrap">{tool.input.new_string}</pre>
              )}
            </>
          )}
          {tool.name === "Bash" && (
            <pre className="text-xs bg-neutral-900 text-green-400 p-3 rounded border border-neutral-800 overflow-x-auto font-mono">
              <span className="text-neutral-500">$ </span>{tool.input.command}
            </pre>
          )}
          {(tool.name === "Read" || tool.name === "Write") && (
            <div className="text-xs font-mono text-neutral-500">{tool.input.file_path}</div>
          )}
          {tool.name === "Agent" && (
            <div className="text-xs text-neutral-400 bg-neutral-900 rounded p-2 border border-neutral-800">
              <span className="text-blue-400">{tool.input.subagent_type || "agent"}</span>: {tool.input.prompt?.substring(0, 300) || tool.input.description}
            </div>
          )}
          {!["Edit", "Bash", "Read", "Write", "Agent"].includes(tool.name) && (
            <pre className="text-xs text-neutral-500 bg-neutral-900 rounded p-2 border border-neutral-800 overflow-x-auto">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
          {tool.result && (
            <details open={tool.result.length < 500}>
              <summary className="text-xs text-neutral-600 cursor-pointer hover:text-neutral-400 select-none">Output</summary>
              <pre className="text-xs text-neutral-400 bg-neutral-900 p-2 rounded border border-neutral-800 mt-1 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap font-mono">{tool.result}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── Conversation View ────────────────────────────────────────────────────────

interface ConvPage {
  messages: any[];
  totalCount: number;
  hasMore: boolean;
  offset: number;
}

function ConversationView({ session, onBack, customName, onRename }: { session: SessionMetadata; onBack: () => void; customName?: string | null; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(customName || "");
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 80;

  const scrollRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(async (offset: number | null, prepend: boolean) => {
    try {
      const params: any = {
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        limit: PAGE_SIZE,
      };
      if (offset !== null) params.offset = offset;
      const page = await invoke<ConvPage>("get_conversation", params);
      setMessages((prev) => prepend ? [...page.messages, ...prev] : page.messages);
      setTotalCount(page.totalCount);
      setHasMore(page.offset > 0); // has older messages above
      if (page.totalCount === 0) setError("No messages parsed from this session");
    } catch (e) {
      console.error(e);
      setError(String(e));
    }
  }, [session.sessionId, session.projectPath]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setMessages([]);
    // Load from the end (offset=null lets Rust default to end)
    loadPage(null, false).finally(() => {
      setLoading(false);
      // Scroll to bottom after render
      setTimeout(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }, 50);
    });
  }, [loadPage]);

  const loadOlder = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    // Calculate offset for older messages
    const currentOffset = totalCount - messages.length;
    const newOffset = Math.max(0, currentOffset - PAGE_SIZE);
    await loadPage(newOffset, true);
    setLoadingMore(false);
    // Maintain scroll position after prepending
    setTimeout(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    }, 50);
  };

  const resumeSession = () => {
    invoke("launch_claude_code", { directory: session.cwd, resumeSession: session.sessionId });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 shrink-0">
        <button onClick={onBack} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                autoFocus
                className="font-semibold text-white text-sm bg-neutral-800 border border-neutral-600 rounded px-1 py-0.5 focus:outline-none focus:border-blue-500 w-48"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => { setEditing(false); onRename?.(editName); }}
                onKeyDown={(e) => { if (e.key === "Enter") { setEditing(false); onRename?.(editName); } if (e.key === "Escape") setEditing(false); }}
              />
            ) : (
              <span
                className="font-semibold text-white text-sm cursor-pointer hover:text-blue-400 transition-colors"
                onDoubleClick={() => { setEditing(true); setEditName(customName || session.slug || ""); }}
                title="Double-click to rename"
              >
                {customName || session.slug || session.sessionId.substring(0, 12)}
              </span>
            )}
            {customName && session.slug && !editing && (
              <span className="text-[10px] text-neutral-600">{session.slug}</span>
            )}
            {session.gitBranch && session.gitBranch !== "HEAD" && (
              <span className="flex items-center gap-1 text-xs text-purple-400"><GitBranch className="w-3 h-3" /> {session.gitBranch}</span>
            )}
          </div>
          <div className="text-xs text-neutral-500">{session.projectDisplay} &middot; {session.messageCount} messages &middot; {fmtTokens(session.totalOutputTokens)} tokens</div>
        </div>
        <button
          onClick={resumeSession}
          className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          <Terminal className="w-3.5 h-3.5" /> Resume in Terminal
        </button>
        <CopyCommandButton cwd={session.cwd} sessionId={session.sessionId} />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            <span className="text-sm text-neutral-500">Loading conversation...</span>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <div className="text-red-400 text-sm mb-2">Failed to load conversation</div>
            <div className="text-xs text-neutral-500 font-mono">{error}</div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto p-4 space-y-4">
            {hasMore && (
              <button
                onClick={loadOlder}
                disabled={loadingMore}
                className="w-full py-2.5 text-xs text-neutral-500 hover:text-white bg-neutral-900/50 hover:bg-neutral-800 border border-neutral-800 rounded-lg transition-colors flex items-center justify-center gap-2 mb-4"
              >
                {loadingMore ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading...</> : `Load older messages (${totalCount - messages.length} above)`}
              </button>
            )}
            <div className="text-[10px] text-neutral-700 text-center py-1">
              {messages.length} of {totalCount}
            </div>
            {messages.map((msg: any, idx) => {
              const uuid = msg.uuid || `msg-${idx}`;
              const ts = msg.timestamp || "";

              if (msg.type === "user" && msg.content) {
                return (
                  <div key={uuid} className="flex justify-end">
                    <div className="max-w-[75%] bg-blue-600/15 border border-blue-500/20 rounded-2xl rounded-br-md px-4 py-3">
                      <div className="text-[10px] text-blue-400/60 mb-1">{fmtTime(ts)}</div>
                      <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                    </div>
                  </div>
                );
              }

              if (msg.type === "assistant") {
                const textBlocks: string[] = msg.textBlocks || [];
                const toolCalls: ToolCallInfo[] = msg.toolCalls || [];
                return (
                  <div key={uuid} className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                      <span>{fmtTime(ts)}</span>
                      {msg.model && <span className="font-mono">{String(msg.model).replace("claude-", "").replace("-20251001", "")}</span>}
                      {msg.outputTokens > 0 && <span>{fmtTokens(msg.outputTokens)} tokens</span>}
                    </div>
                    {msg.thinkingSummary && (
                      <details className="mb-1">
                        <summary className="text-[11px] text-neutral-600 cursor-pointer hover:text-neutral-400 select-none italic">thinking...</summary>
                        <div className="text-xs text-neutral-500 bg-neutral-900/50 rounded-lg p-3 mt-1 italic border border-neutral-800">{msg.thinkingSummary}</div>
                      </details>
                    )}
                    {textBlocks.map((text: string, i: number) => (
                      <div key={i} className="text-sm text-neutral-300 leading-relaxed">
                        <Md>{text}</Md>
                      </div>
                    ))}
                    {toolCalls.map((tool: ToolCallInfo) => (
                      <ToolCallBlock key={tool.id} tool={tool} />
                    ))}
                    {textBlocks.length === 0 && toolCalls.length === 0 && !msg.thinkingSummary && (
                      <div className="text-xs text-neutral-600 italic">empty response</div>
                    )}
                  </div>
                );
              }

              // Unknown message type — skip
              return null;
            })}
            <div className="h-8" />
          </div>
        )}
      </div>

    </div>
  );
}

// ── Search View ──────────────────────────────────────────────────────────────

function SearchView({ sessions, onOpenSession }: { sessions: SessionMetadata[]; onOpenSession: (s: SessionMetadata) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const doSearch = useCallback(async () => {
    if (query.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      const hits = await invoke<SearchHit[]>("search_sessions", { query: query.trim() });
      setResults(hits);
    } catch (e) { console.error(e); }
    setSearching(false);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(doSearch, 300);
    return () => clearTimeout(t);
  }, [query, doSearch]);

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
        <input
          type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all conversations..."
          className="w-full bg-neutral-900 border border-neutral-700 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
          autoFocus
        />
        {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-neutral-500" />}
      </div>
      {results.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-neutral-500">{results.length} results</div>
          {results.map((hit, i) => {
            const session = sessions.find((s) => s.sessionId === hit.sessionId && s.projectPath === hit.projectPath);
            return (
              <button
                key={i}
                onClick={() => session && onOpenSession(session)}
                className="w-full text-left p-3 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 transition-all"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-white">{hit.slug || hit.sessionId.substring(0, 8)}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">{hit.messageType}</span>
                  {hit.gitBranch && <span className="text-xs text-purple-400">{hit.gitBranch}</span>}
                  <span className="text-xs text-neutral-600 ml-auto">{timeAgo(hit.timestamp)}</span>
                </div>
                <p className="text-sm text-neutral-400 line-clamp-2">{hit.snippet}</p>
              </button>
            );
          })}
        </div>
      )}
      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <div className="text-center py-12 text-neutral-500 text-sm">No results found</div>
      )}
    </div>
  );
}

// ── Stats View ───────────────────────────────────────────────────────────────

function ActivityHeatmap({ daily }: { daily: Record<string, number> }) {
  // Dynamically calculate weeks to fill the container
  const today = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Find earliest date in data, or default to 20 weeks back
  const dataKeys = Object.keys(daily).sort();
  const earliest = dataKeys.length > 0 ? new Date(dataKeys[0]) : new Date(today);
  const diffWeeks = Math.ceil((today.getTime() - earliest.getTime()) / (7 * 86400000)) + 2;
  const weeks = Math.max(diffWeeks, 20);

  const grid: { date: string; count: number; day: number; future: boolean }[][] = [];
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (weeks * 7) + (6 - startDate.getDay()));

  for (let w = 0; w < weeks; w++) {
    const week: { date: string; count: number; day: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(cellDate.getDate() + w * 7 + d);
      const key = cellDate.toISOString().substring(0, 10);
      const isFuture = cellDate > today;
      week.push({ date: key, count: daily[key] || 0, day: d, future: isFuture });
    }
    grid.push(week);
  }

  const maxCount = Math.max(...Object.values(daily), 1);

  function cellColor(count: number): string {
    if (count === 0) return "bg-neutral-800/40";
    const intensity = count / maxCount;
    if (intensity > 0.75) return "bg-green-400";
    if (intensity > 0.5) return "bg-green-500/90";
    if (intensity > 0.25) return "bg-green-600/80";
    return "bg-green-700/60";
  }

  const months: { label: string; col: number }[] = [];
  let lastMonth = "";
  grid.forEach((week, wi) => {
    const m = new Date(week[0].date).toLocaleString("en", { month: "short" });
    if (m !== lastMonth) { months.push({ label: m, col: wi }); lastMonth = m; }
  });

  // Calculate cell size to fill width — each cell + gap
  return (
    <div className="w-full">
      {/* Month labels */}
      <div className="flex ml-8 mb-1 gap-0">
        {months.map(({ label, col }, i) => {
          const nextCol = months[i + 1]?.col ?? weeks;
          const span = nextCol - col;
          return (
            <div key={`${label}-${col}`} className="text-[10px] text-neutral-500 shrink-0" style={{ width: `calc(${span} * (100% - 30px) / ${weeks})` }}>
              {label}
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] w-full">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] mr-1 shrink-0">
          {dayNames.map((d, i) => (
            <div key={d} className="h-[14px] text-[9px] text-neutral-600 leading-[14px] w-7">
              {i % 2 === 1 ? d : ""}
            </div>
          ))}
        </div>
        {/* Grid */}
        {grid.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px] flex-1">
            {week.map(({ date, count, future }) => (
              <div
                key={date}
                className={`w-full aspect-square rounded-sm ${future ? "" : `${cellColor(count)} hover:ring-1 hover:ring-white/30`} group/cell relative`}
              >
                {!future && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-neutral-800 border border-neutral-700 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap opacity-0 group-hover/cell:opacity-100 pointer-events-none transition-opacity z-20">
                    {new Date(date + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" })}: {count.toLocaleString()} msgs
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-3 ml-8">
        <span className="text-[9px] text-neutral-600">Less</span>
        {["bg-neutral-800/40", "bg-green-700/60", "bg-green-600/80", "bg-green-500/90", "bg-green-400"].map((c, i) => (
          <div key={i} className={`w-[11px] h-[11px] rounded-sm ${c}`} />
        ))}
        <span className="text-[9px] text-neutral-600">More</span>
        <span className="text-[9px] text-neutral-700 ml-4">
          {Object.values(daily).reduce((a, b) => a + b, 0).toLocaleString()} total
        </span>
      </div>
    </div>
  );
}

// Approximate API pricing per 1M tokens (for cost estimation)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "opus": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

function estimateCost(statsData: any): number {
  if (!statsData?.modelUsage) return 0;
  let total = 0;
  for (const [model, usage] of Object.entries(statsData.modelUsage) as any[]) {
    const tier = model.includes("opus") ? "opus" : model.includes("haiku") ? "haiku" : "sonnet";
    const p = MODEL_PRICING[tier];
    const inp = (usage.inputTokens || 0) / 1_000_000 * p.input;
    const out = (usage.outputTokens || 0) / 1_000_000 * p.output;
    const cacheR = (usage.cacheReadInputTokens || 0) / 1_000_000 * p.cacheRead;
    const cacheW = (usage.cacheCreationInputTokens || 0) / 1_000_000 * p.cacheWrite;
    total += inp + out + cacheR + cacheW;
  }
  return total;
}

function StatsView({ sessions }: { sessions: SessionMetadata[] }) {
  const [activityData, setActivityData] = useState<{ daily: Record<string, number>; hourly: Record<string, number> } | null>(null);
  const [statsData, setStatsData] = useState<any>(null);

  useEffect(() => {
    invoke<{ daily: Record<string, number>; hourly: Record<string, number> }>("get_activity_data")
      .then(setActivityData)
      .catch(console.error);
    invoke("get_stats").then(setStatsData).catch(console.error);
  }, []);

  const totalMessages = sessions.reduce((s, x) => s + x.messageCount, 0);
  const totalToolCalls = sessions.reduce((s, x) => s + x.toolCallCount, 0);
  const totalOutput = sessions.reduce((s, x) => s + x.totalOutputTokens, 0);
  const totalInput = sessions.reduce((s, x) => s + x.totalInputTokens, 0);
  const estimatedCost = estimateCost(statsData);

  // Tool breakdown
  const toolTotals: Record<string, number> = {};
  sessions.forEach((s) => Object.entries(s.toolsUsed).forEach(([k, v]) => (toolTotals[k] = (toolTotals[k] || 0) + v)));
  const sortedTools = Object.entries(toolTotals).sort(([, a], [, b]) => b - a);
  const maxToolCount = sortedTools[0]?.[1] || 1;

  // Model breakdown
  const modelCounts: Record<string, number> = {};
  sessions.forEach((s) => s.modelsUsed.forEach((m) => (modelCounts[m] = (modelCounts[m] || 0) + 1)));

  // Daily bar chart from real data
  const daily = activityData?.daily || {};
  const sortedDays = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).slice(-21);
  const maxDay = Math.max(...sortedDays.map(([, v]) => v), 1);

  // Total active days
  const activeDays = Object.keys(daily).length;

  // Busiest day
  const busiestDay = sortedDays.reduce((best, [day, count]) => count > (best[1] || 0) ? [day, count] : best, ["", 0] as [string, number]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Sessions", value: fmtNum(sessions.length), sub: `${fmtNum(sessions.filter((s) => s.subagentCount > 0).length)} with agents` },
          { label: "Messages", value: fmtNum(totalMessages), sub: `${fmtNum(sessions.reduce((s, x) => s + x.userMessageCount, 0))} from you` },
          { label: "Tokens", value: fmtTokens(totalOutput + totalInput), sub: `${fmtTokens(totalOutput)} out · ${fmtTokens(totalInput)} in` },
          { label: "Est. Cost", value: estimatedCost > 0 ? `$${estimatedCost.toFixed(0)}` : "$0", sub: estimatedCost > 0 ? "at API rates" : "subscription" },
          { label: "Active Days", value: fmtNum(activeDays), sub: busiestDay[0] ? `peak: ${busiestDay[0].substring(5)}` : "" },
        ].map(({ label, value, sub }) => (
          <div key={label} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <div className="text-2xl font-bold text-white">{value}</div>
            <div className="text-[10px] text-neutral-500 uppercase tracking-wider mt-1">{label}</div>
            <div className="text-[10px] text-neutral-600 mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* Activity Heatmap */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Activity</h3>
        {activityData ? (
          <ActivityHeatmap daily={activityData.daily} />
        ) : (
          <div className="flex items-center gap-2 py-8 justify-center text-neutral-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Scanning messages...
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Tool Breakdown */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Most Used Tools</h3>
          <div className="space-y-2">
            {sortedTools.slice(0, 12).map(([name, count]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-neutral-400 w-5">{toolIcon(name)}</span>
                <span className="text-xs text-neutral-300 w-20 shrink-0 truncate">{name}</span>
                <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${(count / maxToolCount) * 100}%` }} />
                </div>
                <span className="text-xs text-neutral-500 w-12 text-right">{count.toLocaleString()}</span>
                <span className="text-[10px] text-neutral-600 w-10 text-right">{((count / totalToolCalls) * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Daily Activity Bar Chart */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Messages per Day (last 3 weeks)</h3>
          <div className="flex gap-[3px]">
            {sortedDays.map(([day, count]) => {
              const barH = count > 0 ? Math.max(Math.round((count / maxDay) * 120), 4) : 0;
              return (
                <div key={day} className="flex-1 group relative text-center">
                  {/* Tooltip */}
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-neutral-800 border border-neutral-700 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                    {new Date(day + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" })}: {count.toLocaleString()} msgs
                  </div>
                  <div className="text-[8px] text-neutral-500 h-4">{count > 0 ? count.toLocaleString() : ""}</div>
                  <div className="h-[120px] flex items-end">
                    <div className="w-full bg-green-500 rounded-t hover:bg-green-400 transition-all" style={{ height: barH }} />
                  </div>
                  <div className="text-[8px] text-neutral-600 h-4">{day.substring(8)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Models */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Models & Token Usage</h3>
        <div className="space-y-3">
          {statsData?.modelUsage && Object.entries(statsData.modelUsage as Record<string, any>)
            .sort(([, a]: any, [, b]: any) => (b.outputTokens || 0) - (a.outputTokens || 0))
            .map(([model, usage]: [string, any]) => {
              const tier = model.includes("opus") ? "opus" : model.includes("haiku") ? "haiku" : "sonnet";
              const p = MODEL_PRICING[tier];
              const cost = (usage.inputTokens || 0) / 1e6 * p.input
                + (usage.outputTokens || 0) / 1e6 * p.output
                + (usage.cacheReadInputTokens || 0) / 1e6 * p.cacheRead
                + (usage.cacheCreationInputTokens || 0) / 1e6 * p.cacheWrite;
              return (
                <div key={model} className="flex items-center gap-3 bg-neutral-800/50 rounded-lg px-3 py-2">
                  <span className="text-xs font-mono text-neutral-300 w-40 truncate">{model.replace("claude-", "")}</span>
                  <span className="text-[10px] text-neutral-500">{fmtTokens(usage.outputTokens || 0)} out</span>
                  <span className="text-[10px] text-neutral-500">{fmtTokens(usage.cacheReadInputTokens || 0)} cached</span>
                  <span className="text-[10px] text-neutral-500">{modelCounts[model] || 0} sessions</span>
                  <div className="flex-1" />
                  <span className="text-xs text-green-400 font-medium">${cost.toFixed(2)}</span>
                </div>
              );
            })}
          {!statsData?.modelUsage && Object.entries(modelCounts).sort(([, a], [, b]) => b - a).map(([model, count]) => (
            <div key={model} className="flex items-center gap-2 bg-neutral-800 rounded-lg px-3 py-1.5">
              <span className="text-xs font-mono text-neutral-300">{model.replace("claude-", "")}</span>
              <span className="text-xs text-neutral-500">{count} sessions</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────

type View =
  | { type: "home" }
  | { type: "project"; project: string }
  | { type: "search" }
  | { type: "stats" }
  | { type: "conversation"; session: SessionMetadata };

function App() {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ type: "home" });
  const filter: string = "";
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    invoke<SessionMetadata[]>("list_sessions", {})
      .then(setSessions)
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
    invoke<Record<string, string>>("get_session_names").then(setSessionNames).catch(() => {});
  }, []);

  const getDisplayName = (s: SessionMetadata) => sessionNames[s.sessionId] || null;
  const doRename = async (sessionId: string, name: string) => {
    await invoke("rename_session", { sessionId, name });
    const updated = await invoke<Record<string, string>>("get_session_names");
    setSessionNames(updated);
  };

  const refresh = () => {
    setLoading(true);
    invoke<SessionMetadata[]>("refresh_sessions", {})
      .then(setSessions)
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  };

  const launchNew = () => invoke("launch_claude_code", {});
  const resumeSession = (s: SessionMetadata) => invoke("launch_claude_code", { directory: s.cwd, resumeSession: s.sessionId });

  const filtered = sessions.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (s.slug?.toLowerCase().includes(q)) || s.firstMessagePreview.toLowerCase().includes(q) ||
      s.projectDisplay.toLowerCase().includes(q) || (s.gitBranch?.toLowerCase().includes(q)) || s.sessionId.includes(q);
  });

  const grouped = filtered.reduce<Record<string, SessionMetadata[]>>((acc, s) => {
    (acc[s.projectDisplay] ||= []).push(s);
    return acc;
  }, {});

  // Cmd+K to search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setView((v) => (v.type === "search" ? { type: "home" } : { type: "search" })); }
      if (e.key === "Escape" && view.type !== "home" && view.type !== "project") setView({ type: "home" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view]);

  // ── Conversation View ──
  if (view.type === "conversation") {
    return <div className="h-screen flex flex-col bg-[#0a0a0a]"><ConversationView session={view.session} onBack={() => setView({ type: "home" })} customName={getDisplayName(view.session)} onRename={(name) => doRename(view.session.sessionId, name)} /></div>;
  }

  // ── Search View ──
  if (view.type === "search") {
    return (
      <div className="h-screen flex flex-col bg-[#0a0a0a]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50">
          <button onClick={() => setView({ type: "home" })} className="p-1.5 hover:bg-neutral-800 rounded-lg"><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-sm font-semibold text-white">Search</span>
          <span className="text-xs text-neutral-600 ml-auto">ESC to close</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SearchView sessions={sessions} onOpenSession={(s) => setView({ type: "conversation", session: s })} />
        </div>
      </div>
    );
  }

  // ── Stats View ──
  if (view.type === "stats") {
    return (
      <div className="h-screen flex flex-col bg-[#0a0a0a]">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 shrink-0">
          <button onClick={() => setView({ type: "home" })} className="p-1.5 hover:bg-neutral-800 rounded-lg"><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-sm font-semibold text-white">Stats</span>
          <div className="flex-1" />
          <button onClick={() => setView({ type: "search" })} className="flex items-center gap-1.5 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-600 transition-colors">
            <Search className="w-3.5 h-3.5" /> Search <kbd className="text-[10px] text-neutral-600 bg-neutral-900 px-1 py-0.5 rounded ml-1">⌘K</kbd>
          </button>
          <button onClick={launchNew} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
            <Terminal className="w-3.5 h-3.5" /> New Session
          </button>
          <button onClick={refresh} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 text-neutral-400 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto"><StatsView sessions={sessions} /></div>
      </div>
    );
  }

  // ── Project Drill-Down ──
  if (view.type === "project") {
    const projectSessions = sessions.filter((s) => s.projectDisplay === view.project);
    return (
      <div className="h-screen flex flex-col bg-[#0a0a0a]">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 shrink-0">
          <button onClick={() => setView({ type: "home" })} className="p-1.5 hover:bg-neutral-800 rounded-lg"><ArrowLeft className="w-4 h-4" /></button>
          <h1 className="text-sm font-bold text-white">{view.project}</h1>
          <span className="text-xs text-neutral-500">{projectSessions.length} sessions</span>
          <div className="flex-1" />
          <button onClick={() => setView({ type: "search" })} className="flex items-center gap-1.5 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-600 transition-colors">
            <Search className="w-3.5 h-3.5" /> Search <kbd className="text-[10px] text-neutral-600 bg-neutral-900 px-1 py-0.5 rounded ml-1">⌘K</kbd>
          </button>
          <button onClick={launchNew} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
            <Terminal className="w-3.5 h-3.5" /> New Session
          </button>
          <button onClick={refresh} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors" title="Refresh">
            <RefreshCw className={`w-4 h-4 text-neutral-400 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {projectSessions.map((s) => (
            <SessionCard
              key={s.sessionId} session={s}
              customName={getDisplayName(s)}
              onClick={() => setView({ type: "conversation", session: s })}
              onResume={() => resumeSession(s)}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Home — Workspace Grid ──
  const sortedProjects = Object.entries(grouped)
    .map(([project, projectSessions]) => ({
      name: project,
      sessions: projectSessions,
      totalMessages: projectSessions.reduce((s, x) => s + x.messageCount, 0),
      totalTokens: projectSessions.reduce((s, x) => s + x.totalOutputTokens, 0),
      totalTools: projectSessions.reduce((s, x) => s + x.toolCallCount, 0),
      lastActive: projectSessions[0]?.lastTimestamp || "",
      latestSession: projectSessions[0],
    }))
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a]">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 shrink-0">
        <h1 className="text-base font-bold text-white">Searchable</h1>
        <div className="flex-1" />
        <button onClick={() => setView({ type: "stats" })} className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white px-2 py-1.5 rounded-lg hover:bg-neutral-800 transition-colors">
          <BarChart3 className="w-3.5 h-3.5" /> Stats
        </button>
        <button onClick={() => setView({ type: "search" })} className="flex items-center gap-1.5 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-600 transition-colors">
          <Search className="w-3.5 h-3.5" /> Search <kbd className="text-[10px] text-neutral-600 bg-neutral-900 px-1 py-0.5 rounded ml-1">⌘K</kbd>
        </button>
        <button onClick={launchNew} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
          <Terminal className="w-3.5 h-3.5" /> New Session
        </button>
        <button onClick={refresh} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors" title="Refresh">
          <RefreshCw className={`w-4 h-4 text-neutral-400 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            <span className="text-sm text-neutral-500">Scanning sessions...</span>
          </div>
        ) : (
          <>
            {/* Workspace Cards */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Workspaces <span className="text-neutral-600 normal-case font-normal">{sortedProjects.length}</span></h2>
              {sortedProjects.length > 6 && (
                <button onClick={() => setShowAllWorkspaces(!showAllWorkspaces)} className="text-xs text-neutral-500 hover:text-white transition-colors">
                  {showAllWorkspaces ? "Show Less" : `Show All (${sortedProjects.length})`}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {(showAllWorkspaces ? sortedProjects : sortedProjects.slice(0, 6)).map(({ name, sessions: ps, totalMessages, totalTokens, totalTools, lastActive, latestSession }) => (
                <button
                  key={name}
                  onClick={() => setView({ type: "project", project: name })}
                  className="text-left p-5 rounded-xl border border-neutral-800 bg-neutral-900 hover:bg-neutral-800/80 hover:border-neutral-700 transition-all group"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors truncate min-w-0">{name}</div>
                    <span className="text-[10px] text-neutral-600 shrink-0">{timeAgo(lastActive)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-neutral-500 mb-3">
                    <span>{ps.length} sessions</span>
                    <span>{fmtTokens(totalMessages)} msgs</span>
                    <span>{fmtTokens(totalTokens)} tokens</span>
                    <span>{totalTools} tools</span>
                  </div>
                  {latestSession && (
                    <div className="text-xs text-neutral-500 line-clamp-2 leading-relaxed">
                      <span className="text-neutral-400">Latest:</span> {latestSession.firstMessagePreview}
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Recent Sessions */}
            <div className="mb-4">
              <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">Recent Sessions</h2>
            </div>
            <div className="space-y-2">
              {sessions.slice(0, 10).map((s) => (
                <SessionCard
                  key={s.sessionId} session={s}
                  onClick={() => setView({ type: "conversation", session: s })}
                  onResume={() => resumeSession(s)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 px-4 py-1.5 border-t border-neutral-800/50 text-[10px] text-neutral-600">
        <span>{sessions.length} sessions across {Object.keys(grouped).length} workspaces</span>
        <span>{fmtTokens(sessions.reduce((s, x) => s + x.totalOutputTokens, 0))} total tokens</span>
        <span>{sessions.reduce((s, x) => s + x.toolCallCount, 0).toLocaleString()} tool calls</span>
      </div>
    </div>
  );
}

export default App;
