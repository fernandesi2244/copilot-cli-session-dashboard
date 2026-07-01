// Extension: session-dashboard
// Multi-session monitor — shows status of all Copilot CLI sessions in a live browser dashboard
// Updated: 2026-05-12

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { joinSession } from "@github/copilot-sdk/extension";
import { exec, spawn, execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, renameSync, mkdirSync, unlinkSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const SESSION_STATE_DIR = join(homedir(), ".copilot", "session-state");
const POLL_INTERVAL_MS = 3000;
const sseClients = new Set();
let serverPort = null;
let mainSession = null; // set after joinSession
const NOTES_FILE = join(homedir(), ".copilot", "session-dashboard-notes.json");
const WORKSPACE_FILE = join(homedir(), ".copilot", "saved-workspace.json");
const TODOS_FILE = join(homedir(), ".copilot", "session-dashboard-todos.json");
const CONFIG_FILE = join(homedir(), ".copilot", "session-dashboard-config.json");

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 30000; // 30 seconds

function loadDashboardConfig() {
    const now = Date.now();
    if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_TTL_MS) {
        return _configCache;
    }
    try {
        if (existsSync(CONFIG_FILE)) {
            _configCache = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) || {};
        } else {
            _configCache = {};
        }
    } catch {
        _configCache = {};
    }
    _configCacheTime = now;
    return _configCache;
}

function resolveUserAlias() {
    // Priority: env var → config file → git user.email local part → "user"
    const fromEnv = process.env.COPILOT_DASHBOARD_USER_ALIAS;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    const cfg = loadDashboardConfig();
    if (cfg.userAlias && typeof cfg.userAlias === "string" && cfg.userAlias.trim()) return cfg.userAlias.trim();
    try {
        const email = execSync("git config --global user.email", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        const local = email.split("@")[0];
        if (local) return local;
    } catch {}
    return "user";
}

const USER_ALIAS = resolveUserAlias();

function resolveCopilotCommand() {
    // Priority: env var → config file → default "copilot".
    // Override this if you launch the Copilot CLI via a wrapper script (e.g.
    // "agency copilot" on an internal Microsoft build).
    const fromEnv = process.env.COPILOT_DASHBOARD_CLI_COMMAND;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    const cfg = loadDashboardConfig();
    if (cfg.copilotCommand && typeof cfg.copilotCommand === "string" && cfg.copilotCommand.trim()) {
        return cfg.copilotCommand.trim();
    }
    return "copilot";
}
const COPILOT_CMD = resolveCopilotCommand();
const AUTO_SAVE_INTERVAL_MS = 60 * 1000; // 1 minute
const WORKSPACE_STARTUP_TIME = Date.now();
const WORKSPACE_STARTUP_GRACE_MS = 3 * 60 * 1000; // 3 min: refuse to shrink saved set during this window
const WORKSPACE_BACKUP_COUNT = 10; // keep N rolling snapshots (.1 = newest)
let lockTimer = null; // countdown timer for lock-after-dismiss
let screenBlankActive = false; // guard against double-spawning
let lockFlowActive = false; // guard against duplicate screen-dismissed calls
const LOCK_COUNTDOWN_SEC = 3;
const INTRUSION_FILE = join(homedir(), ".copilot", "session-dashboard-intrusion.json");

// --- Performance: HTML template cache (generated once, never changes) ---
const _htmlCache = {};
function cachedHtml(name, generator) {
    if (!_htmlCache[name]) _htmlCache[name] = generator();
    return _htmlCache[name];
}

// --- Performance: session scan cache ---
let _scanCache = null;
let _scanCacheTime = 0;
const SCAN_CACHE_TTL_MS = 2000; // 2 seconds

function getCachedSessions(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _scanCache && (now - _scanCacheTime) < SCAN_CACHE_TTL_MS) {
        return _scanCache;
    }
    _scanCache = _scanSessionsUncached();
    _scanCacheTime = now;
    return _scanCache;
}

function invalidateSessionCache() {
    _scanCache = null;
    _scanCacheTime = 0;
}

// Per-session events cache: avoids re-reading events.jsonl if mtime hasn't changed
const _sessionEventsCache = new Map(); // sessionId -> { mtimeMs, rawEvents, lastEvents, progressInfo }

function sendJson(res, data, statusCode = 200, extraHeaders = {}) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
}

// --- Report generation (reads session history from disk on demand) ---
const REPORTS_DIR = join(homedir(), ".copilot", "activity", "reports");

function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
}

function getWeekBounds(year, week) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    sun.setUTCHours(23, 59, 59, 999);
    return { start: mon, end: sun };
}

function getSessionsInRange(startDate, endDate) {
    // Scan all sessions and filter by activity within the date range
    if (!existsSync(SESSION_STATE_DIR)) return [];
    const results = [];
    let dirs;
    try { dirs = readdirSync(SESSION_STATE_DIR); } catch { return []; }

    for (const name of dirs) {
        if (name === ".archive") continue;
        const dir = join(SESSION_STATE_DIR, name);
        try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }

        const wsPath = join(dir, "workspace.yaml");
        const eventsPath = join(dir, "events.jsonl");

        let meta = {};
        try { meta = parseYaml(readFileSync(wsPath, "utf-8")); } catch {}

        const cwdVal = meta.cwd || "";
        if (EXCLUDED_CWD_PATTERNS.some(p => p.test(cwdVal))) continue;

        // Quick date check using metadata — skip sessions clearly outside range
        const created = meta.created_at ? new Date(meta.created_at) : null;
        const updated = meta.updated_at ? new Date(meta.updated_at) : null;
        const createdInRange = created && created >= startDate && created <= endDate;
        const updatedInRange = updated && updated >= startDate && updated <= endDate;

        // If session was created after endDate or last updated before startDate, skip events scan
        if (created && created > endDate && !updatedInRange) continue;
        if (updated && updated < startDate && !createdInRange) continue;

        // Also use file mtime as a cheap pre-check before reading the full events file
        let eventsInRange = [];
        let events = [];
        try {
            const evStat = statSync(eventsPath);
            // If events file was last modified before the range start, no activity in range
            if (evStat.mtime < startDate && !createdInRange && !updatedInRange) continue;

            // Reuse per-session events cache if available and fresh
            const cached = _sessionEventsCache.get(name);
            let raw;
            try {
                const evMtime = statSync(eventsPath).mtimeMs;
                if (cached && cached.mtimeMs === evMtime && cached.rawEvents) {
                    raw = cached.rawEvents;
                } else {
                    raw = readFileSync(eventsPath, "utf-8");
                }
            } catch {
                raw = readFileSync(eventsPath, "utf-8");
            }
            events = raw.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch {}

        // Check if session had any activity in the date range
        eventsInRange = events.filter(e => {
            if (!e.timestamp) return false;
            const t = new Date(e.timestamp);
            return t >= startDate && t <= endDate;
        });

        if (eventsInRange.length === 0 && !createdInRange && !updatedInRange) continue;

        // Count turns and tool calls from events in range
        let turns = 0, toolCalls = 0, taskCompletes = 0, errors = 0;
        for (const e of eventsInRange) {
            if (e.type === "assistant.turn_end") turns++;
            if (e.type === "tool.execution_start") toolCalls++;
            if (e.type === "session.task_complete") taskCompletes++;
            if (e.type === "session.error") errors++;
        }

        results.push({
            id: name,
            summary: meta.summary || "Untitled Session",
            repository: meta.repository || "",
            branch: meta.branch || "",
            cwd: meta.cwd || "",
            createdAt: meta.created_at || "",
            turns, toolCalls, taskCompletes, errors,
        });
    }

    return results.sort((a, b) => b.turns - a.turns);
}

function generateReport(startDate, endDate, type) {
    const sessions = getSessionsInRange(startDate, endDate);
    let totalTurns = 0, totalToolCalls = 0, totalTaskCompletes = 0;
    const repoSet = new Set();
    for (const s of sessions) {
        totalTurns += s.turns;
        totalToolCalls += s.toolCalls;
        totalTaskCompletes += s.taskCompletes;
        if (s.repository) repoSet.add(s.repository);
    }
    return {
        type, generatedAt: new Date().toISOString(),
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        sessionCount: sessions.length,
        totalTurns, totalToolCalls, totalTaskCompletes,
        repositories: [...repoSet],
        sessions,
    };
}

function checkAndGenerateReports() {
    try {
        try { mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
        const now = new Date();

        // Generate missing weekly reports for completed weeks
        for (let i = 1; i <= 12; i++) {
            const pastDate = new Date(now);
            pastDate.setDate(pastDate.getDate() - i * 7);
            const { year, week } = getISOWeek(pastDate);
            const wk = String(week).padStart(2, "0");
            const reportPath = join(REPORTS_DIR, `weekly-${year}-W${wk}.json`);
            if (existsSync(reportPath)) continue;
            const { start, end } = getWeekBounds(year, week);
            if (end >= now) continue;
            const report = generateReport(start, end, "weekly");
            if (report.sessionCount === 0) continue;
            report.label = `Week ${week}, ${year}`;
            const tmp = reportPath + ".tmp";
            writeFileSync(tmp, JSON.stringify(report, null, 2));
            renameSync(tmp, reportPath);
        }

        // Generate missing monthly reports for completed months
        for (let i = 1; i <= 6; i++) {
            const pastDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const ym = pastDate.toISOString().slice(0, 7);
            const reportPath = join(REPORTS_DIR, `monthly-${ym}.json`);
            if (existsSync(reportPath)) continue;
            const monthStart = new Date(Date.UTC(pastDate.getFullYear(), pastDate.getMonth(), 1));
            const monthEnd = new Date(Date.UTC(pastDate.getFullYear(), pastDate.getMonth() + 1, 0, 23, 59, 59, 999));
            if (monthEnd >= now) continue;
            const report = generateReport(monthStart, monthEnd, "monthly");
            if (report.sessionCount === 0) continue;
            const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
            report.label = `${monthNames[pastDate.getMonth()]} ${pastDate.getFullYear()}`;
            const tmp = reportPath + ".tmp";
            writeFileSync(tmp, JSON.stringify(report, null, 2));
            renameSync(tmp, reportPath);
        }
    } catch {}
    invalidateReportsCache();
}// In-memory cache for reports (invalidated on generation)
let reportsCache = null;
let reportsCacheTime = 0;
const REPORTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function listReports() {
    const now = Date.now();
    if (reportsCache && (now - reportsCacheTime) < REPORTS_CACHE_TTL_MS) return reportsCache;
    const reports = { weekly: [], monthly: [], range: [] };
    try {
        if (!existsSync(REPORTS_DIR)) return reports;
        const files = readdirSync(REPORTS_DIR).sort().reverse();
        for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
                const data = JSON.parse(readFileSync(join(REPORTS_DIR, f), "utf-8"));
                if (f.startsWith("weekly-")) reports.weekly.push(data);
                else if (f.startsWith("monthly-")) reports.monthly.push(data);
                else if (f.startsWith("range-")) reports.range.push(data);
            } catch {}
        }
    } catch {}
    reportsCache = reports;
    reportsCacheTime = now;
    return reports;
}

function invalidateReportsCache() { reportsCache = null; reportsCacheTime = 0; }

function generateAndSaveSingleReport(type, startDateStr, endDateStr, label) {
    try { mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
    const startDate = new Date(startDateStr + "T00:00:00.000Z");
    const endDate = new Date(endDateStr + "T23:59:59.999Z");
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate > endDate) return { error: "Invalid date range" };
    if (!["weekly", "monthly"].includes(type)) return { error: "Invalid type" };

    const report = generateReport(startDate, endDate, type);
    report.label = label || (type === "weekly" ? "Week Report" : "Month Report");

    // Determine canonical filename
    let filename;
    if (type === "weekly") {
        const { year, week } = getISOWeek(startDate);
        filename = "weekly-" + year + "-W" + String(week).padStart(2, "0") + ".json";
    } else {
        filename = "monthly-" + startDateStr.slice(0, 7) + ".json";
    }
    const reportPath = join(REPORTS_DIR, filename);
    const tmp = reportPath + "." + Date.now() + ".tmp";
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, reportPath);
    invalidateReportsCache();
    return report;
}

function generateRangeReport(startDateStr, endDateStr) {
    try { mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
    const startDate = new Date(startDateStr + "T00:00:00.000Z");
    const endDate = new Date(endDateStr + "T23:59:59.999Z");
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate > endDate) return { error: "Invalid date range" };

    // Pre-generate any missing weekly/monthly reports that overlap this range
    const now = new Date();
    // Weekly: walk through weeks that overlap the range
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
        const { year, week } = getISOWeek(cursor);
        const wk = String(week).padStart(2, "0");
        const reportPath = join(REPORTS_DIR, "weekly-" + year + "-W" + wk + ".json");
        if (!existsSync(reportPath)) {
            const { start, end } = getWeekBounds(year, week);
            if (end < now) {
                const wr = generateReport(start, end, "weekly");
                if (wr.sessionCount > 0) {
                    wr.label = "Week " + week + ", " + year;
                    const tmp = reportPath + "." + Date.now() + ".tmp";
                    writeFileSync(tmp, JSON.stringify(wr, null, 2));
                    renameSync(tmp, reportPath);
                }
            }
        }
        cursor.setDate(cursor.getDate() + 7);
    }
    // Monthly: walk through months that overlap the range
    let mCursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    while (mCursor <= endDate) {
        const ym = mCursor.toISOString().slice(0, 7);
        const reportPath = join(REPORTS_DIR, "monthly-" + ym + ".json");
        if (!existsSync(reportPath)) {
            const mStart = new Date(Date.UTC(mCursor.getUTCFullYear(), mCursor.getUTCMonth(), 1));
            const mEnd = new Date(Date.UTC(mCursor.getUTCFullYear(), mCursor.getUTCMonth() + 1, 0, 23, 59, 59, 999));
            if (mEnd < now) {
                const mr = generateReport(mStart, mEnd, "monthly");
                if (mr.sessionCount > 0) {
                    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                    mr.label = monthNames[mCursor.getUTCMonth()] + " " + mCursor.getUTCFullYear();
                    const tmp = reportPath + "." + Date.now() + ".tmp";
                    writeFileSync(tmp, JSON.stringify(mr, null, 2));
                    renameSync(tmp, reportPath);
                }
            }
        }
        mCursor.setUTCMonth(mCursor.getUTCMonth() + 1);
    }

    // Generate the range report from raw session data for exact accuracy
    const report = generateReport(startDate, endDate, "range");
    report.label = "Range: " + startDateStr + " → " + endDateStr;

    // Save to disk
    const filename = "range-" + startDateStr + "_" + endDateStr + ".json";
    const reportPath = join(REPORTS_DIR, filename);
    const tmp = reportPath + "." + Date.now() + ".tmp";
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, reportPath);
    invalidateReportsCache();
    return report;
}

async function generateAISummary(report) {
    // A session is "meaningful" if it has real activity. Sessions that never
    // got a human-readable title (summary === "Untitled Session") can still
    // be meaningful — week 20/2026, for example, has 27 such sessions with
    // hundreds of turns each. We fall back to branch/cwd to label them for
    // the LLM.
    const meaningfulSessions = (report.sessions || []).filter(s => {
        if ((s.turns || 0) === 0 && (s.toolCalls || 0) === 0) return false;
        if (!s.summary && !s.branch && !s.cwd) return false;
        return true;
    });
    if (meaningfulSessions.length === 0) return { error: "No meaningful sessions to summarize" };

    // Build a concise context from the report data
    const repoGroups = {};
    for (const s of meaningfulSessions) {
        const repo = s.repository || s.cwd || "Other";
        if (!repoGroups[repo]) repoGroups[repo] = [];
        let label = (s.summary && s.summary !== "Untitled Session") ? s.summary : null;
        if (!label && s.branch) label = `(branch: ${s.branch})`;
        if (!label) label = "untitled session";
        label += ` [${s.turns || 0} turns, ${s.toolCalls || 0} tools]`;
        repoGroups[repo].push(label);
    }
    const totalTurns = meaningfulSessions.reduce((a, s) => a + (s.turns || 0), 0);
    const totalTools = meaningfulSessions.reduce((a, s) => a + (s.toolCalls || 0), 0);
    const totalCompleted = meaningfulSessions.reduce((a, s) => a + (s.taskCompletes || 0), 0);

    let context = `Period: ${report.startDate} to ${report.endDate}\n`;
    context += `Stats: ${meaningfulSessions.length} sessions, ${totalTurns} turns, ${totalTools} tool calls, ${totalCompleted} tasks completed\n`;
    context += `Repositories: ${(report.repositories || []).join(", ")}\n\n`;
    context += "Sessions by repository (some sessions have no title — branch name is shown instead):\n";
    for (const [repo, summaries] of Object.entries(repoGroups)) {
        const shortName = repo.replace(/\\/g, "/").split("/").slice(-2).join("/");
        context += `\n${shortName}:\n`;
        for (const s of summaries) context += `  - ${s}\n`;
    }

    const systemPrompt = "You write concise activity report summaries for software developers. Write in first person. Focus on key themes, major features/fixes, and which areas saw the most activity. Be specific based on session names. No bullet points — flowing paragraphs only. No markdown headers.";
    const userPrompt = `Based on the following coding session data, write 2-3 concise paragraphs summarizing what was accomplished:\n\n${context}`;

    const result = await callCopilotChat(systemPrompt, userPrompt, { model: "gpt-4.1", maxTokens: 1000 });
    if (result.error) return { error: result.error };
    return { summary: result.content };
}

function findReportFile(type, startDate, endDate) {
    if (!existsSync(REPORTS_DIR)) return null;
    const files = readdirSync(REPORTS_DIR);
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
            const data = JSON.parse(readFileSync(join(REPORTS_DIR, f), "utf-8"));
            if (data.type === type && data.startDate === startDate && data.endDate === endDate) {
                return { path: join(REPORTS_DIR, f), data };
            }
        } catch {}
    }
    return null;
}

async function autoGenerateAISummaries() {
    if (!existsSync(REPORTS_DIR)) return;
    const now = new Date();
    const files = readdirSync(REPORTS_DIR).sort();
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        // Only process completed period reports (weekly/monthly), not range reports
        if (!f.startsWith("weekly-") && !f.startsWith("monthly-")) continue;
        const filePath = join(REPORTS_DIR, f);
        let data;
        try { data = JSON.parse(readFileSync(filePath, "utf-8")); } catch { continue; }
        // Skip if already has AI summary
        if (data.aiSummary) continue;
        // Skip if no sessions (nothing to summarize)
        if (!data.sessionCount || data.sessionCount === 0) continue;
        // Skip if no meaningful sessions (only untitled/empty ones)
        const meaningful = (data.sessions || []).filter(s =>
            s.summary && s.summary !== "Untitled Session" && ((s.turns || 0) > 0 || (s.toolCalls || 0) > 0));
        if (meaningful.length === 0) continue;
        // Skip if zero total activity
        if ((data.totalTurns || 0) === 0 && (data.totalToolCalls || 0) === 0) continue;
        // Skip if the period hasn't completed yet (endDate is in the future)
        if (data.endDate) {
            const endDate = new Date(data.endDate + "T23:59:59.999Z");
            if (endDate >= now) continue;
        }
        // Generate AI summary
        try {
            const result = await generateAISummary(data);
            if (result.summary) {
                data.aiSummary = result.summary;
                data.aiSummaryGeneratedAt = new Date().toISOString();
                const tmp = filePath + "." + Date.now() + ".tmp";
                writeFileSync(tmp, JSON.stringify(data, null, 2));
                renameSync(tmp, filePath);
                invalidateReportsCache();
            }
        } catch {}
    }
}

// --- Warm PowerShell process for fast tab focusing ---
// Pre-loads UIAutomation assemblies so focus commands execute in ~100ms instead of ~1s
let focusWorker = null;
let focusWorkerReady = false;
const focusQueue = []; // callbacks waiting for worker readiness
const focusResultQueue = []; // callbacks waiting for RESULT: lines

function startFocusWorker() {
    const initScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FocusHelper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
function Do-Focus($title, $altTitle, $cwd) {
    $cwdLeaf = if ($cwd) { Split-Path $cwd -Leaf } else { "" }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wtCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
    $wts = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wtCond)
    if ($wts.Count -eq 0) { return "NO_WT" }
    foreach ($wt in $wts) {
        $tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        $tabs = $wt.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
        $i = 0
        foreach ($tab in $tabs) {
            $i++
            $n = $tab.Current.Name
            $matched = $false
            if ($title -and $n -like "*$title*") { $matched = $true }
            elseif ($altTitle -and $n -like "*$altTitle*") { $matched = $true }
            elseif ($cwdLeaf -and $n -like "*$cwdLeaf*") { $matched = $true }
            if ($matched) {
                $h = $wt.Current.NativeWindowHandle
                if ($h -ne 0) { [FocusHelper]::SetForegroundWindow([IntPtr]::new($h)) | Out-Null }
                try { $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return "SELECTED_TAB:$i" } catch {}
                try { $tab.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return "INVOKED_TAB:$i" } catch {}
            }
        }
    }
    $h = $wts[0].Current.NativeWindowHandle
    if ($h -ne 0) { [FocusHelper]::SetForegroundWindow([IntPtr]::new($h)) | Out-Null }
    return "FOCUSED_WINDOW"
}
Write-Host "READY"
while ($true) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { break }
    try {
        $cmd = $line | ConvertFrom-Json
        $result = Do-Focus $cmd.title $cmd.altTitle $cmd.cwd
        Write-Host "RESULT:$result"
    } catch {
        Write-Host "RESULT:ERROR"
    }
}
`.replace(/\r?\n/g, "\n");

    focusWorker = spawn("powershell", ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
    });
    focusWorker.stdin.write(initScript + "\n");

    let buffer = "";
    focusWorker.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "READY" && !focusWorkerReady) {
                focusWorkerReady = true;
                for (const cb of focusQueue) cb();
                focusQueue.length = 0;
            } else if (trimmed.startsWith("RESULT:")) {
                const result = trimmed.slice(7);
                const cb = focusResultQueue.shift();
                if (cb) cb(result);
            }
        }
    });

    focusWorker.on("exit", () => {
        focusWorker = null;
        focusWorkerReady = false;
        // Restart after a delay
        setTimeout(startFocusWorker, 2000);
    });
}

function sendFocusCommand(title, altTitle, cwd, onResult) {
    const doSend = () => {
        if (focusWorker && focusWorker.stdin.writable) {
            const cmd = JSON.stringify({ title: title || "", altTitle: altTitle || "", cwd: cwd || "" });
            if (onResult) focusResultQueue.push(onResult);
            focusWorker.stdin.write(cmd + "\n");
        } else if (onResult) {
            onResult("ERROR");
        }
    };
    if (focusWorkerReady) {
        doSend();
    } else {
        focusQueue.push(doSend);
    }
}

startFocusWorker();

// Fixed port: persist across restarts so the URL doesn't change
const PORT_FILE = join(homedir(), ".copilot", "session-dashboard-port");
const PREFERRED_PORT = (() => {
    try { if (existsSync(PORT_FILE)) return Number(readFileSync(PORT_FILE, "utf-8").trim()); } catch {}
    return 0; // fallback: let OS pick, then save it
})();

// Directories to exclude from session scanning
const EXCLUDED_CWD_PATTERNS = [
    /Documents[\\/]Clawpilot/i,
];

// --- Session scanning ---

function parseYaml(text) {
    // Minimal YAML parser for flat key: value files
    const obj = {};
    for (const line of text.split("\n")) {
        const m = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
        if (m) obj[m[1]] = m[2].trim();
    }
    return obj;
}

// Cache process-alive checks per scan cycle (cleared every 2s with session cache)
let _pidAliveCache = new Map();
let _pidAliveCacheTime = 0;

function isProcessAlive(pid) {
    const now = Date.now();
    if (now - _pidAliveCacheTime > 2000) {
        _pidAliveCache.clear();
        _pidAliveCacheTime = now;
    }
    const key = Number(pid);
    if (_pidAliveCache.has(key)) return _pidAliveCache.get(key);
    let alive;
    try { process.kill(key, 0); alive = true; } catch { alive = false; }
    _pidAliveCache.set(key, alive);
    return alive;
}

function deriveStatus(lastEvents, lockPid, isAlive) {
    if (!isAlive) return { status: "inactive", label: "Inactive", icon: "⏹️" };

    // Check if session is stale — alive process but no recent events (10+ min)
    const STALE_THRESHOLD_MS = 10 * 60 * 1000;
    if (lastEvents.length > 0) {
        const lastTs = lastEvents[lastEvents.length - 1]?.timestamp;
        if (lastTs && (Date.now() - new Date(lastTs).getTime()) > STALE_THRESHOLD_MS) {
            return { status: "idle", label: "Stale — no activity for 10+ min", icon: "💤" };
        }
    }

    // Determine if we're mid-turn: find the last turn_start and turn_end
    let lastTurnStartIdx = -1;
    let lastTurnEndIdx = -1;
    for (let i = lastEvents.length - 1; i >= 0; i--) {
        if (lastTurnStartIdx === -1 && lastEvents[i]?.type === "assistant.turn_start") lastTurnStartIdx = i;
        if (lastTurnEndIdx === -1 && lastEvents[i]?.type === "assistant.turn_end") lastTurnEndIdx = i;
        if (lastTurnStartIdx !== -1 && lastTurnEndIdx !== -1) break;
    }
    const midTurn = lastTurnStartIdx > lastTurnEndIdx;

    // If mid-turn, the session is working — find the best label from recent events
    if (midTurn) {
        // Check for pending ask_user/permission tool (started but not yet completed)
        const completedToolIds = {};
        for (let i = lastEvents.length - 1; i >= 0; i--) {
            const ev = lastEvents[i];
            if (!ev || !ev.type) continue;
            if (ev.type === "tool.execution_complete" && ev.data && ev.data.toolCallId) {
                completedToolIds[ev.data.toolCallId] = true;
            }
            if (ev.type === "tool.execution_start" && ev.data && ev.data.toolCallId) {
                if (!completedToolIds[ev.data.toolCallId]) {
                    const tn = ev.data.toolName || "";
                    if (tn === "ask_user") return { status: "waiting", label: "Waiting for Input", icon: "❓" };
                }
            }
        }

        for (let i = lastEvents.length - 1; i >= 0; i--) {
            const ev = lastEvents[i];
            if (!ev?.type) continue;
            if (ev.type === "permission.requested") return { status: "waiting", label: "Waiting for Permission", icon: "🔐" };
            if (ev.type === "elicitation.requested") return { status: "waiting", label: "Waiting for Input", icon: "❓" };
            if (ev.type === "tool.execution_start") return { status: "working", label: "Running: " + (ev.data?.toolName || "tool"), icon: "⚙️" };
            if (ev.type === "assistant.streaming_delta") return { status: "working", label: "Streaming Response", icon: "✍️" };
            if (ev.type === "tool.execution_complete") return { status: "working", label: "Processing", icon: "🤖" };
            if (ev.type === "assistant.message") return { status: "working", label: "Thinking", icon: "🤖" };
            if (ev.type === "session.info") return { status: "working", label: "Processing", icon: "🤖" };
            if (ev.type === "hook.start" || ev.type === "hook.end") continue;
        }
        return { status: "working", label: "Working", icon: "🤖" };
    }

    // Not mid-turn — check the last meaningful event
    for (let i = lastEvents.length - 1; i >= 0; i--) {
        const ev = lastEvents[i];
        if (!ev?.type) continue;
        if (ev.type === "session.task_complete") return { status: "completed", label: "Task Complete", icon: "✅" };
        if (ev.type === "permission.requested") return { status: "waiting", label: "Waiting for Permission", icon: "🔐" };
        if (ev.type === "elicitation.requested") return { status: "waiting", label: "Waiting for Input", icon: "❓" };
        if (ev.type === "session.idle") return { status: "idle", label: "Idle", icon: "😴" };
        if (ev.type === "session.error") return { status: "error", label: "Error", icon: "🔥" };
        if (ev.type === "assistant.turn_end") {
            // Check if this turn wrote/created plan.md → "Plan Ready for Review"
            // or if the assistant's last message asks for user input (ends with ?)
            let wrotePlan = false;
            let lastAssistContent = "";
            let askedQuestion = false;
            for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
                const prev = lastEvents[j];
                if (!prev?.type) continue;
                // Stop scanning at the previous turn boundary
                if (prev.type === "assistant.turn_start" || prev.type === "assistant.turn_end") break;
                // Detect plan.md creation or edit
                if ((prev.type === "tool.execution_start") && prev.data) {
                    const tn = prev.data.toolName || "";
                    const args = prev.data.arguments || {};
                    const filePath = args.path || args.file_path || "";
                    if ((tn === "create" || tn === "edit") && /plan\.md$/i.test(filePath)) {
                        wrotePlan = true;
                    }
                }
                // Capture last assistant message content
                if (prev.type === "assistant.message" && prev.data?.content && !lastAssistContent) {
                    lastAssistContent = prev.data.content;
                }
            }
            // Check if the assistant's message asks the user something
            if (lastAssistContent) {
                const trimmed = lastAssistContent.trim();
                // Ends with a question mark, or contains common "waiting for you" phrases
                if (/\?\s*$/.test(trimmed)) askedQuestion = true;
                if (/\b(let me know|please (confirm|review|choose|decide|approve)|ready to proceed|what do you think|would you like|shall I)\b/i.test(trimmed)) askedQuestion = true;
            }
            if (wrotePlan) return { status: "waiting", label: "Plan Ready for Review", icon: "📋" };
            if (askedQuestion) return { status: "waiting", label: "Waiting for Response", icon: "💬" };
            return { status: "idle", label: "Turn Complete", icon: "😴" };
        }
        if (ev.type === "user.message") return { status: "working", label: "Processing Message", icon: "🤖" };
    }
    return { status: "active", label: "Active", icon: "🟢" };
}

function getProgressSummary(dir, eventsPath, preReadRaw) {
    // 1. Read plan.md
    let planContent = "";
    let planGoal = "";
    let planApproach = "";
    try {
        const planPath = join(dir, "plan.md");
        if (existsSync(planPath)) {
            planContent = readFileSync(planPath, "utf-8");
            const lines = planContent.split("\n");
            // Extract goal from first heading
            const heading = lines.find(l => /^#+\s/.test(l));
            if (heading) planGoal = heading.replace(/^#+\s*/, "").trim();
            // Extract approach/problem section
            for (let i = 0; i < lines.length && i < 30; i++) {
                if (/^##\s*(Problem|Approach|Overview)/i.test(lines[i])) {
                    const nextLines = [];
                    for (let j = i + 1; j < lines.length && j < i + 5; j++) {
                        if (/^##/.test(lines[j])) break;
                        if (lines[j].trim()) nextLines.push(lines[j].trim());
                    }
                    if (nextLines.length) planApproach = nextLines.join(" ").slice(0, 200);
                    break;
                }
            }
        }
    } catch {}

    // 2. Count events and extract recent conversation
    let userMsgs = 0, assistMsgs = 0, toolCalls = 0, taskCompletes = 0;
    let errors = 0, permissionRequests = 0;
    let firstEventTime = null, lastEventTime = null;
    let recentConversation = "";
    let firstUserMsg = "";
    let lastAssistMsg = "";
    let latestIntent = "";
    let lastTurnEndLine = -1, lastUserMsgLine = -1;
    try {
        let raw;
        if (preReadRaw) {
            raw = preReadRaw;
        } else {
            // For large files, only read the tail to avoid I/O bottlenecks
            const TAIL_BYTES = 256 * 1024;
            try {
                const st = statSync(eventsPath);
                if (st.size > TAIL_BYTES) {
                    const fd = openSync(eventsPath, "r");
                    try {
                        const buf = Buffer.alloc(TAIL_BYTES);
                        readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
                        raw = buf.toString("utf-8");
                    } finally {
                        closeSync(fd);
                    }
                    // Strip partial first line
                    const nlIdx = raw.indexOf("\n");
                    if (nlIdx > 0) raw = raw.slice(nlIdx + 1);
                } else {
                    raw = readFileSync(eventsPath, "utf-8");
                }
            } catch {
                raw = readFileSync(eventsPath, "utf-8");
            }
        }
        const lines = raw.trim().split("\n");
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            if (line.includes('"user.message"')) { userMsgs++; lastUserMsgLine = li; }
            if (line.includes('"assistant.message"')) assistMsgs++;
            if (line.includes('"tool.execution_start"')) {
                toolCalls++;
                if (line.includes('"report_intent"')) {
                    try {
                        const ev = JSON.parse(line);
                        const intent = ev.data?.arguments?.intent;
                        if (intent) latestIntent = intent;
                    } catch {}
                }
            }
            if (line.includes('"session.task_complete"')) { taskCompletes++; lastTurnEndLine = li; }
            if (line.includes('"assistant.turn_end"')) lastTurnEndLine = li;
            if (line.includes('"session.error"')) errors++;
            if (line.includes('"permission.requested"')) permissionRequests++;
        }
        // Extract first/last event timestamps for duration
        if (lines.length > 0) {
            try { const ev = JSON.parse(lines[0]); if (ev.timestamp) firstEventTime = ev.timestamp; } catch {}
            try { const ev = JSON.parse(lines[lines.length - 1]); if (ev.timestamp) lastEventTime = ev.timestamp; } catch {}
        }
        // First user message = original request/goal
        for (const line of lines) {
            if (line.includes('"user.message"')) {
                try {
                    const ev = JSON.parse(line);
                    firstUserMsg = (ev.data?.content || "").slice(0, 300);
                } catch {}
                break;
            }
        }
        // Last assistant message = current state
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes('"assistant.message"')) {
                try {
                    const ev = JSON.parse(lines[i]);
                    lastAssistMsg = (ev.data?.content || "").slice(0, 400);
                } catch {}
                break;
            }
        }
        // Extract last few user + assistant messages for context
        const convLines = [];
        for (let i = lines.length - 1; i >= 0 && convLines.length < 6; i--) {
            try {
                if (lines[i].includes('"user.message"')) {
                    const ev = JSON.parse(lines[i]);
                    const txt = (ev.data?.content || "").slice(0, 300);
                    if (txt) convLines.unshift(`User: ${txt}`);
                } else if (lines[i].includes('"assistant.message"')) {
                    const ev = JSON.parse(lines[i]);
                    const txt = (ev.data?.content || "").slice(0, 300);
                    if (txt) convLines.unshift(`Assistant: ${txt}`);
                }
            } catch {}
        }
        recentConversation = convLines.join("\n");
    } catch {}

    // 3. Build structured Goal/Stage/Progress
    let goal = "";
    if (planGoal) {
        // Strip common prefixes like "Plan: ..."
        goal = planGoal.replace(/^Plan:\s*/i, "").trim();
    }
    if (!goal && firstUserMsg) {
        // Use first user message as goal (first sentence)
        goal = firstUserMsg.split(/[.!?\n]/)[0]?.trim() || firstUserMsg.slice(0, 120);
    }

    let stage = "";
    if (taskCompletes > 0 && userMsgs <= taskCompletes + 1) {
        stage = "Complete";
    } else if (planContent && toolCalls === 0) {
        stage = "Planning";
    } else if (toolCalls > 0 && taskCompletes === 0 && userMsgs <= 2) {
        stage = "Implementing initial request";
    } else if (toolCalls > 0 && taskCompletes === 0) {
        stage = "Iterating (" + userMsgs + " exchanges)";
    } else if (taskCompletes > 0 && userMsgs > taskCompletes + 1) {
        stage = "Working on follow-up #" + (taskCompletes + 1);
    }

    let progressNote = "";
    if (planApproach) {
        progressNote = planApproach;
    } else if (lastAssistMsg) {
        // Extract first meaningful sentence from last assistant response
        const sentences = lastAssistMsg.split(/(?<=[.!?])\s+/);
        const meaningful = sentences.find(s => s.length > 15 && !s.startsWith("I ") && !s.startsWith("Let me"));
        progressNote = meaningful?.slice(0, 150) || sentences[0]?.slice(0, 150) || "";
    }

    // Unseen = turn ended (or task completed) after the last user message
    const unseen = lastTurnEndLine > lastUserMsgLine && lastTurnEndLine >= 0;

    return {
        goal,
        stage,
        progressNote,
        planContent,
        recentConversation,
        latestIntent,
        unseen,
        turns: userMsgs,
        toolCalls,
        taskCompletes,
        errors,
        permissionRequests,
        firstEventTime,
        lastEventTime,
    };
}

function _scanSessionsUncached() {
    const results = [];
    if (!existsSync(SESSION_STATE_DIR)) return results;

    let dirs;
    try { dirs = readdirSync(SESSION_STATE_DIR); } catch { return results; }

    for (const name of dirs) {
        if (name === ".archive") continue;
        const dir = join(SESSION_STATE_DIR, name);
        try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }

        const wsPath = join(dir, "workspace.yaml");
        const eventsPath = join(dir, "events.jsonl");

        // Parse workspace.yaml
        let meta = {};
        try { meta = parseYaml(readFileSync(wsPath, "utf-8")); } catch {}

        // Skip sessions in excluded directories
        const cwdVal = meta.cwd || "";
        if (EXCLUDED_CWD_PATTERNS.some(p => p.test(cwdVal))) continue;

        // Check lock files — session is alive if ANY lock PID is alive
        let lockPid = null;
        let isAlive = false;
        try {
            const files = readdirSync(dir);
            const locks = files.filter(f => f.startsWith("inuse.") && f.endsWith(".lock"));
            for (const lock of locks) {
                const pid = lock.replace("inuse.", "").replace(".lock", "");
                if (isProcessAlive(pid)) {
                    lockPid = pid;
                    isAlive = true;
                    break;
                }
            }
            if (!lockPid && locks.length > 0) {
                lockPid = locks[0].replace("inuse.", "").replace(".lock", "");
            }
        } catch {}

        // Read events file ONCE — share between status derivation and progress summary
        // Use mtime-based caching to avoid re-reading unchanged files
        let rawEvents = "";
        let lastEvents = [];
        let progressInfo;
        let evMtimeMs = 0;
        try { evMtimeMs = statSync(eventsPath).mtimeMs; } catch {}

        const cached = _sessionEventsCache.get(name);
        if (cached && cached.mtimeMs === evMtimeMs && evMtimeMs > 0) {
            // File hasn't changed — reuse cached parse results
            rawEvents = cached.rawEvents;
            lastEvents = cached.lastEvents;
        } else {
            try { rawEvents = readFileSync(eventsPath, "utf-8"); } catch {}
            if (rawEvents) {
                const lines = rawEvents.trimEnd().split("\n").slice(-25);
                lastEvents = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            }
        }

        const statusInfo = deriveStatus(lastEvents, lockPid, isAlive);

        // Get last meaningful event time
        let lastActivity = meta.updated_at || meta.created_at || "";
        if (lastEvents.length > 0) {
            const last = lastEvents[lastEvents.length - 1];
            if (last.timestamp) lastActivity = last.timestamp;
        }

        // For inactive sessions older than 24h, skip expensive progress summary
        const SKIP_PROGRESS_AGE_MS = 24 * 60 * 60 * 1000;
        const isOldInactive = !isAlive && lastActivity &&
            (Date.now() - new Date(lastActivity).getTime()) > SKIP_PROGRESS_AGE_MS;

        if (isOldInactive) {
            progressInfo = {
                goal: "", stage: "", progressNote: "", planContent: "",
                recentConversation: "", latestIntent: "", unseen: false,
                turns: 0, toolCalls: 0, taskCompletes: 0, errors: 0,
                permissionRequests: 0, firstEventTime: null, lastEventTime: lastActivity,
            };
        } else if (cached && cached.mtimeMs === evMtimeMs && evMtimeMs > 0 && cached.progressInfo) {
            // Reuse cached progress info if file hasn't changed
            progressInfo = cached.progressInfo;
        } else {
            progressInfo = getProgressSummary(dir, eventsPath, rawEvents);
        }

        // Update per-session cache
        _sessionEventsCache.set(name, { mtimeMs: evMtimeMs, rawEvents, lastEvents, progressInfo });

        results.push({
            id: name,
            summary: (isAlive && progressInfo.latestIntent) ? progressInfo.latestIntent : (meta.summary || "Untitled Session"),
            baseSummary: meta.summary || "Untitled Session",
            cwd: meta.cwd || "",
            branch: meta.branch || "",
            repository: meta.repository || "",
            createdAt: meta.created_at || "",
            updatedAt: lastActivity,
            pid: lockPid,
            alive: isAlive,
            ...statusInfo,
            ...progressInfo,
        });
    }

    // Sort: alive sessions first, then by updatedAt desc
    results.sort((a, b) => {
        if (a.alive !== b.alive) return b.alive ? 1 : -1;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });

    return results;
}

function scanSessions() {
    return getCachedSessions();
}

// --- Repo scanning ---

const REPO_SCAN_DIRS = (() => {
    const defaults = [
        join(homedir(), "source", "repos"),
        join(homedir(), "source"),
        join(homedir(), "Documents"),
        join(homedir(), "code"),
        join(homedir(), "projects"),
        join(homedir(), "git"),
    ];
    const fromEnv = (process.env.COPILOT_DASHBOARD_REPO_DIRS || "")
        .split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const cfg = loadDashboardConfig();
    const fromConfig = Array.isArray(cfg.repoScanDirs) ? cfg.repoScanDirs.filter(s => typeof s === "string") : [];
    // De-dupe while preserving order; user-supplied entries win on order.
    const seen = new Set();
    const all = [...defaults, ...fromEnv, ...fromConfig].filter(p => {
        if (!p || seen.has(p)) return false;
        seen.add(p); return true;
    });
    return all;
})();

let _repoCache = null;
let _repoCacheTime = 0;
const REPO_CACHE_TTL_MS = 30000; // 30 seconds

function _scanReposUncached() {
    const repos = [];
    const seen = new Set();

    for (const scanDir of REPO_SCAN_DIRS) {
        if (!existsSync(scanDir)) continue;
        let entries;
        try { entries = readdirSync(scanDir); } catch { continue; }

        for (const entry of entries) {
            const fullPath = join(scanDir, entry);
            try { if (!statSync(fullPath).isDirectory()) continue; } catch { continue; }
            const gitPath = join(fullPath, ".git");
            if (!existsSync(gitPath)) continue;
            // Only real repos (.git is a directory), not worktrees (.git is a file)
            try { if (!statSync(gitPath).isDirectory()) continue; } catch { continue; }
            if (seen.has(fullPath)) continue;
            seen.add(fullPath);

            // Get worktrees
            let worktrees = [];
            try {
                const wtOutput = execSync(`git -C "${fullPath}" worktree list --porcelain`, { encoding: "utf-8", timeout: 3000 });
                const blocks = wtOutput.trim().split("\n\n");
                for (const block of blocks) {
                    const wtPath = block.match(/^worktree\s+(.+)/m)?.[1];
                    const wtBranch = block.match(/^branch\s+refs\/heads\/(.+)/m)?.[1] || "detached";
                    if (wtPath) worktrees.push({ path: wtPath, branch: wtBranch });
                }
            } catch {
                worktrees = [{ path: fullPath, branch: "" }];
            }
            if (worktrees.length === 0) worktrees = [{ path: fullPath, branch: "" }];

            repos.push({ name: entry, path: fullPath, worktrees });
        }
    }

    // Also add cwds from active sessions that aren't already listed
    // Skip worktree directories (where .git is a file, not a directory)
    const sessions = scanSessions();
    for (const s of sessions) {
        if (!s.cwd || seen.has(s.cwd) || !existsSync(s.cwd)) continue;
        const gitCheck = join(s.cwd, ".git");
        if (existsSync(gitCheck)) {
            try { if (!statSync(gitCheck).isDirectory()) continue; } catch { continue; }
        }
        seen.add(s.cwd);
        const name = basename(s.cwd);
        repos.push({ name, path: s.cwd, worktrees: [{ path: s.cwd, branch: s.branch || "" }] });
    }

    repos.sort((a, b) => a.name.localeCompare(b.name));
    return repos;
}

function scanRepos() {
    const now = Date.now();
    if (_repoCache && (now - _repoCacheTime) < REPO_CACHE_TTL_MS) {
        return _repoCache;
    }
    _repoCache = _scanReposUncached();
    _repoCacheTime = now;
    return _repoCache;
}

// --- Notes helpers ---
let _notesCache = null;
let _notesCacheTime = 0;
const NOTES_CACHE_TTL_MS = 5000;

function loadNotes() {
    const now = Date.now();
    if (_notesCache && (now - _notesCacheTime) < NOTES_CACHE_TTL_MS) return _notesCache;
    try {
        if (existsSync(NOTES_FILE)) {
            _notesCache = JSON.parse(readFileSync(NOTES_FILE, "utf-8"));
            _notesCacheTime = now;
            return _notesCache;
        }
    } catch {}
    _notesCache = {};
    _notesCacheTime = now;
    return _notesCache;
}
function saveNotes(notes) {
    try { writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2)); } catch {}
    _notesCache = notes;
    _notesCacheTime = Date.now();
}

// --- Analytics data computation ---
let _analyticsCache = null;
let _analyticsCacheTime = 0;
const ANALYTICS_CACHE_TTL_MS = 10000; // 10 seconds

function computeAnalyticsData() {
    const now = Date.now();
    if (_analyticsCache && (now - _analyticsCacheTime) < ANALYTICS_CACHE_TTL_MS) {
        return _analyticsCache;
    }
    const sessions = scanSessions();
    // Sessions per day (last 14 days)
    const perDay = {};
    const nowDate = new Date();
    for (let i = 13; i >= 0; i--) {
        const d = new Date(nowDate); d.setDate(d.getDate() - i);
        perDay[d.toISOString().slice(0, 10)] = 0;
    }
    let totalTurns = 0, totalTools = 0, totalDuration = 0, durationCount = 0;
    const repoCount = {};
    for (const s of sessions) {
        const dateKey = (s.createdAt || s.updatedAt || "").slice(0, 10);
        if (dateKey && perDay.hasOwnProperty(dateKey)) perDay[dateKey]++;
        totalTurns += s.turns || 0;
        totalTools += s.toolCalls || 0;
        const repo = s.repository || s.cwd || "Unknown";
        repoCount[repo] = (repoCount[repo] || 0) + 1;
        if (s.firstEventTime && s.lastEventTime) {
            const dur = new Date(s.lastEventTime).getTime() - new Date(s.firstEventTime).getTime();
            if (dur > 0) { totalDuration += dur; durationCount++; }
        }
    }
    const topRepos = Object.entries(repoCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount / 60000) : 0;
    _analyticsCache = { perDay, topRepos, totalSessions: sessions.length, totalTurns, totalTools, avgDuration };
    _analyticsCacheTime = now;
    return _analyticsCache;
}

// --- HTML Dashboard ---
function dashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copilot Sessions Monitor</title>
<style>
  :root, [data-theme="dark"] {
    --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3;
    --dim: #8b949e; --green: #3fb950; --blue: #58a6ff; --orange: #d29922;
    --red: #f85149; --purple: #bc8cff; --yellow: #e3b341;
    --attention-bg: #2a1f00; --attention-border: #e3b341;
    --working-bg: #0c2d6b; --working-border: #58a6ff;
    --idle-bg: #161b22; --idle-border: #30363d;
    --inactive-bg: #0d1117; --inactive-border: #21262d;
  }
  [data-theme="light"] {
    --bg: #f6f8fa; --card: #ffffff; --border: #d0d7de; --text: #1f2328;
    --dim: #656d76; --green: #1a7f37; --blue: #0969da; --orange: #bf8700;
    --red: #cf222e; --purple: #8250df; --yellow: #9a6700;
    --attention-bg: #fff8c5; --attention-border: #9a6700;
    --working-bg: #ddf4ff; --working-border: #0969da;
    --idle-bg: #ffffff; --idle-border: #d0d7de;
    --inactive-bg: #f6f8fa; --inactive-border: #d8dee4;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', -apple-system, sans-serif; background: var(--bg);
         color: var(--text); min-height: 100vh; }

  /* Header */
  .header { background: var(--card); border-bottom: 1px solid var(--border);
            padding: 18px 28px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green);
                 animation: pulse 2s infinite; }
  .header .refresh { font-size: 12px; color: var(--dim); margin-left: auto; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

  /* ===== GROUP SECTIONS ===== */
  .group { margin: 0 24px 28px; }
  .group-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
                  padding-bottom: 10px; border-bottom: 2px solid var(--border); }
  .group-header .group-icon { font-size: 22px; }
  .group-header .group-title { font-size: 15px; font-weight: 700; text-transform: uppercase;
                                letter-spacing: 1px; }
  .group-header .group-count { font-size: 13px; color: var(--dim); margin-left: 4px; }

  /* Attention group — warm amber theme */
  .group-attention .group-header { border-bottom-color: var(--yellow); }
  .group-attention .group-title { color: var(--yellow); }

  /* Unseen group — cyan/teal theme */
  .group-unseen .group-header { border-bottom-color: #79c0ff; }
  .group-unseen .group-title { color: #79c0ff; }

  /* Working group — blue theme */
  .group-working .group-header { border-bottom-color: var(--blue); }
  .group-working .group-title { color: var(--blue); }

  /* Idle group — muted */
  .group-idle .group-header { border-bottom-color: var(--dim); }
  .group-idle .group-title { color: var(--dim); }

  /* Recent group — subtle purple tint */
  .group-recent .group-header { border-bottom-color: var(--purple); }
  .group-recent .group-title { color: var(--purple); }

  /* Recent cards — slightly more visible than inactive */
  .card-recent { background: #1a1525; border: 1px solid #2d2640; opacity: 0.75; }
  .card-recent .badge { background: rgba(188,140,255,0.12); color: var(--purple); }
  .card-recent .name { color: #b0a0c8; }
  .card-recent .time .ago { color: var(--purple); }
  .card-recent:hover { opacity: 0.95; }

  /* Inactive group — very muted */
  .group-inactive .group-header { border-bottom-color: #21262d; }
  .group-inactive .group-title { color: #484f58; }

  /* Completed group — green theme */
  .group-completed .group-header { border-bottom-color: var(--green); }
  .group-completed .group-title { color: var(--green); }

  /* ===== SESSION CARDS ===== */
  .session { border-radius: 10px; padding: 16px 20px; margin-bottom: 10px;
             display: grid; grid-template-columns: 48px 1fr auto;
             grid-template-rows: auto auto; position: relative;
             gap: 4px 16px; align-items: start; transition: all 0.25s ease; }
  .session:hover { transform: translateX(4px); }

  .session .icon { font-size: 30px; grid-row: 1; grid-column: 1; text-align: center;
                   align-self: center; }
  .session .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                        grid-row: 1; grid-column: 2; }
  .session .name { font-weight: 600; font-size: 15px; }
  .base-summary { font-size: 11px; color: var(--dim); font-weight: 400; opacity: 0.7; }
  .session .badge { display: inline-block; padding: 3px 12px; border-radius: 12px;
                    font-size: 11px; font-weight: 700; letter-spacing: 0.3px; }
  .session .time { font-size: 12px; text-align: right; grid-row: 1; grid-column: 3;
                   display: flex; flex-direction: column; justify-content: center; gap: 2px; }
  .session .time .ago { font-size: 14px; font-weight: 600; }

  /* Detail area spans full width below the title row */
  .session .card-detail { grid-row: 2; grid-column: 1 / -1; padding-left: 64px; }
  .session .meta { font-size: 12px; color: var(--dim); display: flex; gap: 16px; flex-wrap: wrap; }
  .session .meta span { display: flex; align-items: center; gap: 4px; }
  .cwd-link { display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--blue);
              text-decoration: none; border-radius: 4px; padding: 1px 4px; margin: -1px -4px;
              transition: background 0.15s; }
  .cwd-link:hover { background: rgba(88,166,255,0.15); text-decoration: underline; }

  /* --- ATTENTION cards --- hard flash to demand attention */
  .card-waiting { background: var(--attention-bg); border: 2px solid var(--attention-border);
                  animation: attention-flash 1.2s ease-in-out infinite; }
  .card-waiting .name { color: var(--yellow); }
  .card-waiting .badge { background: var(--yellow); color: #1c1500;
                         animation: badge-throb 1.2s ease-in-out infinite; }
  .card-waiting .time .ago { color: var(--yellow); }
  .card-waiting .meta { color: #a08c5a; }
  .card-waiting .icon { animation: shake 0.6s ease-in-out infinite; }
  @keyframes attention-flash {
    0%,100% { background: var(--attention-bg);
              box-shadow: 0 0 20px rgba(227,179,65,0.15), inset 0 0 30px rgba(227,179,65,0.04);
              border-color: var(--attention-border); }
    50% { background: #3d2e00;
          box-shadow: 0 0 40px rgba(227,179,65,0.35), inset 0 0 50px rgba(227,179,65,0.1);
          border-color: #f0d060; }
  }
  @keyframes badge-throb {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    20% { transform: translateX(-3px); }
    40% { transform: translateX(3px); }
    60% { transform: translateX(-2px); }
    80% { transform: translateX(2px); }
  }

  /* --- WORKING cards --- */
  .card-working { background: var(--working-bg); border: 1px solid var(--working-border);
                  box-shadow: 0 0 12px rgba(88,166,255,0.08); }
  .card-working .name { color: #a5d6ff; }
  .card-working .badge { background: rgba(88,166,255,0.2); color: var(--blue); }
  .card-working .time .ago { color: var(--blue); }
  .card-working .meta { color: #6d8eb5; }

  /* Spinner animation for working cards */
  .card-working .icon { animation: spin-slow 3s linear infinite; }
  @keyframes spin-slow { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  /* --- IDLE cards --- */
  .card-idle { background: var(--idle-bg); border: 1px solid var(--idle-border); }
  .card-idle .badge { background: rgba(139,148,158,0.15); color: var(--dim); }
  .card-idle .time .ago { color: var(--dim); }

  /* --- COMPLETED cards --- celebratory green */
  .card-completed { background: #0d2818; border: 2px solid #1a7f37;
                    box-shadow: 0 0 12px rgba(63,185,80,0.1); }
  .card-completed .name { color: var(--green); }
  .card-completed .badge { background: var(--green); color: #0d1117; font-weight: 800; }
  .card-completed .time .ago { color: var(--green); }

  /* --- UNSEEN cards --- soft cyan glow to draw the eye */
  .card-unseen { background: #0d1f2d; border: 2px solid #1f6feb;
                 box-shadow: 0 0 10px rgba(31,111,235,0.12); }
  .card-unseen .name { color: #79c0ff; }
  .card-unseen .badge { background: rgba(121,192,255,0.15); color: #79c0ff; }
  .card-unseen .time .ago { color: #79c0ff; }
  .card-unseen::before { content: "👀"; position: absolute; top: 8px; right: 10px; font-size: 14px; opacity: 0.6; }

  /* --- ERROR cards --- */
  .card-error { background: #2d0a0a; border: 1px solid var(--red); }
  .card-error .badge { background: rgba(248,81,73,0.2); color: var(--red); }
  .card-error .time .ago { color: var(--red); }

  /* --- INACTIVE cards --- */
  .card-inactive { background: var(--inactive-bg); border: 1px solid var(--inactive-border);
                   opacity: 0.5; }
  .card-inactive .badge { background: rgba(139,148,158,0.08); color: #484f58; }
  .card-inactive .name { color: #6e7681; }
  .card-inactive .time .ago { color: #484f58; }
  .card-inactive:hover { opacity: 0.8; }

  /* Banner for attention — aggressive flash */
  .attention-banner { margin: 16px 24px; padding: 14px 20px;
                      border: 2px solid var(--yellow); border-radius: 10px;
                      display: flex; align-items: center; gap: 12px; font-size: 14px;
                      font-weight: 700; color: var(--yellow);
                      animation: banner-strobe 1s ease-in-out infinite; }
  .attention-banner .count { font-size: 32px; font-weight: 800; }
  @keyframes banner-strobe {
    0%,100% { background: rgba(227,179,65,0.08); border-color: var(--yellow); }
    50% { background: rgba(227,179,65,0.25); border-color: #f0d060; }
  }
  .attention-banner.hidden { display: none; }

  /* Intrusion alert banner */
  .intrusion-banner { margin: 16px 24px; padding: 18px 24px;
                      border: 2px solid #f85149; border-radius: 10px;
                      font-size: 15px; font-weight: 700; color: #f85149;
                      animation: intrusion-strobe 0.7s ease-in-out infinite; }
  .intrusion-banner .intrusion-header { display: flex; align-items: center; gap: 14px; }
  .intrusion-banner .intrusion-icon { font-size: 36px; }
  .intrusion-banner .intrusion-text { flex: 1; }
  .intrusion-banner .intrusion-time { font-size: 12px; color: var(--dim); font-weight: 400; margin-top: 4px; }
  .intrusion-banner .intrusion-actions { display: flex; gap: 8px; align-items: center; }
  .intrusion-banner .intrusion-btn { background: none; border: 1px solid #f85149; color: #f85149;
                      border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; font-weight: 600; }
  .intrusion-banner .intrusion-btn:hover { background: rgba(248,81,73,0.15); }
  .intrusion-banner .intrusion-btn.dismiss { border-color: var(--dim); color: var(--dim); }
  .intrusion-banner .intrusion-btn.dismiss:hover { background: rgba(139,148,158,0.15); }
  .intrusion-photo-panel { margin-top: 14px; text-align: center; display: none; }
  .intrusion-photo-panel img { max-width: 480px; max-height: 360px; border-radius: 10px;
                                border: 2px solid #f85149; box-shadow: 0 4px 24px rgba(248,81,73,0.3); }
  .intrusion-photo-panel .no-photo { font-size: 13px; color: var(--dim); font-weight: 400; padding: 20px; }
  @keyframes intrusion-strobe {
    0%,100% { background: rgba(248,81,73,0.08); border-color: #f85149; }
    50% { background: rgba(248,81,73,0.30); border-color: #ff6e6a; }
  }
  .intrusion-banner.hidden { display: none; }

  .empty { text-align: center; padding: 60px 20px; color: var(--dim); }
  .empty .big { font-size: 48px; margin-bottom: 12px; }
  .group.hidden { display: none; }

  /* Progress & stats on cards */
  .card-detail { display: flex; flex-direction: column; gap: 4px; }
  .progress { font-size: 12px; color: var(--text); opacity: 0.85; line-height: 1.4;
              padding: 6px 10px; background: rgba(255,255,255,0.04); border-radius: 6px;
              border-left: 3px solid rgba(255,255,255,0.1); margin-top: 2px; }
  .card-waiting .progress { border-left-color: var(--yellow); background: rgba(227,179,65,0.06); }
  .card-working .progress { border-left-color: var(--blue); background: rgba(88,166,255,0.06); }

  .ai-summary { font-size: 12px; line-height: 1.5; padding: 8px 12px; margin-top: 4px;
                 background: rgba(188,140,255,0.05); border: 1px solid rgba(188,140,255,0.12);
                 border-radius: 8px; color: #c9d1d9; }
  .ai-summary strong { color: var(--purple); font-size: 11px; text-transform: uppercase;
                        letter-spacing: 0.3px; }
  .ai-summary .ai-line { margin: 2px 0; }

  .card-stats { font-size: 11px; color: var(--dim); display: flex; gap: 14px; margin-top: 4px; }
  .card-stats span { display: flex; align-items: center; gap: 3px; }

  /* Copy session ID button */
  .copy-id-btn { background: rgba(255,255,255,0.06); color: var(--dim); border: 1px solid var(--border);
                 border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
                 display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
                 font-family: 'Segoe UI', -apple-system, sans-serif; }
  .copy-id-btn:hover { background: rgba(88,166,255,0.15); border-color: var(--blue); color: var(--blue); }
  .copy-id-btn.copied { background: rgba(63,185,80,0.15); border-color: var(--green); color: var(--green); }

  .copy-cwd-btn { background: rgba(255,255,255,0.06); color: var(--dim); border: 1px solid var(--border);
                  border-radius: 6px; padding: 3px 6px; font-size: 11px; cursor: pointer;
                  display: inline-flex; align-items: center; transition: all 0.2s;
                  font-family: 'Segoe UI', -apple-system, sans-serif; margin-left: -4px; }
  .copy-cwd-btn:hover { background: rgba(88,166,255,0.15); border-color: var(--blue); color: var(--blue); }
  .copy-cwd-btn.copied { background: rgba(63,185,80,0.15); border-color: var(--green); color: var(--green); }

  .resume-btn { background: rgba(63,185,80,0.1); color: var(--green); border: 1px solid var(--green);
                border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
                display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
                font-family: 'Segoe UI', -apple-system, sans-serif; font-weight: 600; }
  .resume-btn:hover { background: rgba(63,185,80,0.25); }
  .resume-btn.launched { background: rgba(63,185,80,0.2); color: var(--green); }
  [data-theme="light"] .resume-btn { background: rgba(26,127,55,0.08); }

  /* Repo opener toolbar */
  .repo-bar { background: var(--card); border-bottom: 1px solid var(--border);
              padding: 10px 24px; display: flex; align-items: center; gap: 12px; }
  .repo-bar label { font-size: 12px; color: var(--dim); font-weight: 600;
                    text-transform: uppercase; letter-spacing: 0.5px; }
  .repo-select { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                 border-radius: 6px; padding: 6px 12px; font-size: 13px;
                 min-width: 350px; cursor: pointer; }
  .repo-select:hover { border-color: var(--blue); }
  .repo-select option { background: var(--card); color: var(--text); padding: 4px 8px; }
  .repo-select option.repo-parent { font-weight: 700; color: var(--text); }
  .repo-select option.worktree-child { padding-left: 20px; color: var(--dim); }
  .repo-select optgroup { font-weight: 700; color: var(--dim); font-size: 12px; }
  .repo-btn { background: var(--blue); color: #fff; border: none; border-radius: 6px;
              padding: 6px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
              transition: background 0.2s; }
  .repo-btn:hover { background: #79c0ff; }
  .repo-btn:disabled { opacity: 0.4; cursor: default; }
  .editor-select { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                   border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .editor-select:hover { border-color: var(--blue); }

  /* Search bar */
  .search-bar { background: var(--card); border-bottom: 1px solid var(--border);
                padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
  .search-bar label { font-size: 12px; color: var(--dim); font-weight: 600;
                      text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .search-input { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                  border-radius: 6px; padding: 8px 14px; font-size: 14px; flex: 1;
                  outline: none; transition: border-color 0.2s; }
  .search-input:focus { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(88,166,255,0.15); }
  .search-input::placeholder { color: #484f58; }
  .search-count { font-size: 12px; color: var(--dim); white-space: nowrap; min-width: 80px; text-align: right; }
  .search-clear { background: none; border: 1px solid var(--border); color: var(--dim);
                  border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer;
                  transition: all 0.2s; }
  .search-clear:hover { border-color: var(--red); color: var(--red); }
  .search-clear.hidden { display: none; }

  /* Theme toggle button */
  .theme-toggle { background: var(--bg); color: var(--dim); border: 1px solid var(--border);
                  border-radius: 6px; padding: 5px 12px; font-size: 16px; cursor: pointer;
                  transition: all 0.2s; line-height: 1; }
  .theme-toggle:hover { border-color: var(--blue); color: var(--blue); }

  /* Light theme overrides for hardcoded colors */
  [data-theme="light"] .card-waiting { background: var(--attention-bg); border-color: var(--attention-border); }
  [data-theme="light"] .card-waiting .name { color: var(--yellow); }
  [data-theme="light"] .card-waiting .badge { background: var(--yellow); color: #fff; }
  [data-theme="light"] .card-waiting .meta { color: #7a6524; }
  [data-theme="light"] .card-working { background: var(--working-bg); border-color: var(--working-border); }
  [data-theme="light"] .card-working .name { color: #0550ae; }
  [data-theme="light"] .card-working .badge { background: rgba(9,105,218,0.15); color: var(--blue); }
  [data-theme="light"] .card-working .meta { color: #57606a; }
  [data-theme="light"] .card-completed { background: #dafbe1; border-color: var(--green); box-shadow: none; }
  [data-theme="light"] .card-completed .name { color: var(--green); }
  [data-theme="light"] .card-completed .badge { background: var(--green); color: #fff; }
  [data-theme="light"] .card-unseen { background: #ddf4ff; border-color: #1f6feb; box-shadow: none; }
  [data-theme="light"] .card-unseen .name { color: #0550ae; }
  [data-theme="light"] .card-unseen .badge { background: rgba(31,111,235,0.12); color: #0550ae; }
  [data-theme="light"] .group-unseen .group-header { border-bottom-color: #0550ae; }
  [data-theme="light"] .group-unseen .group-title { color: #0550ae; }
  [data-theme="light"] .card-error { background: #ffebe9; border-color: var(--red); }
  [data-theme="light"] .card-error .badge { background: rgba(207,34,46,0.12); color: var(--red); }
  [data-theme="light"] .card-inactive { background: var(--inactive-bg); border-color: var(--inactive-border); }
  [data-theme="light"] .card-inactive .name { color: #656d76; }
  [data-theme="light"] .card-inactive .badge { background: rgba(101,109,118,0.1); color: #656d76; }
  [data-theme="light"] .card-recent { background: #fbefff; border-color: #d3b8e8; }
  [data-theme="light"] .card-recent .name { color: #6e4a8e; }
  [data-theme="light"] .card-recent .badge { background: rgba(130,80,223,0.1); color: var(--purple); }
  [data-theme="light"] .progress { background: rgba(0,0,0,0.03); border-left-color: rgba(0,0,0,0.12); }
  [data-theme="light"] .card-waiting .progress { background: rgba(154,103,0,0.06); border-left-color: var(--yellow); }
  [data-theme="light"] .card-working .progress { background: rgba(9,105,218,0.06); border-left-color: var(--blue); }
  [data-theme="light"] .ai-summary { background: rgba(130,80,223,0.05); border-color: rgba(130,80,223,0.15); color: var(--text); }
  [data-theme="light"] .copy-id-btn { background: rgba(0,0,0,0.04); }
  [data-theme="light"] .copy-id-btn:hover { background: rgba(9,105,218,0.1); }
  [data-theme="light"] .copy-cwd-btn { background: rgba(0,0,0,0.04); }
  [data-theme="light"] .copy-cwd-btn:hover { background: rgba(9,105,218,0.1); }
  [data-theme="light"] .attention-banner { color: var(--yellow); }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f6f8fa; --card: #ffffff; --border: #d0d7de; --text: #1f2328;
      --dim: #656d76; --green: #1a7f37; --blue: #0969da; --orange: #bf8700;
      --red: #cf222e; --purple: #8250df; --yellow: #9a6700;
      --attention-bg: #fff8c5; --attention-border: #9a6700;
      --working-bg: #ddf4ff; --working-border: #0969da;
      --idle-bg: #ffffff; --idle-border: #d0d7de;
      --inactive-bg: #f6f8fa; --inactive-border: #d8dee4;
    }
  }

  /* Kill button */
  .kill-btn { background: rgba(248,81,73,0.1); color: var(--red); border: 1px solid var(--red);
              border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
              display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
              font-family: 'Segoe UI', -apple-system, sans-serif; font-weight: 600; }
  .kill-btn:hover { background: rgba(248,81,73,0.25); }

  /* Timeline */
  .timeline { max-height: 300px; overflow-y: auto; margin-top: 6px; padding: 6px 10px;
              background: rgba(0,0,0,0.15); border-radius: 8px; border: 1px solid var(--border);
              font-size: 11px; font-family: 'Cascadia Code', 'Consolas', monospace; }
  [data-theme="light"] .timeline { background: rgba(0,0,0,0.04); }
  .timeline-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); display: flex; gap: 8px; }
  .timeline-entry:last-child { border-bottom: none; }
  .timeline-ts { color: var(--dim); white-space: nowrap; min-width: 60px; }
  .timeline-icon { min-width: 16px; text-align: center; }
  .timeline-desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-green { color: var(--green); }
  .tl-purple { color: var(--purple); }
  .tl-blue { color: var(--blue); }
  .tl-blue-dim { color: #4a8ab5; }
  .tl-red { color: var(--red); }
  .tl-yellow { color: var(--yellow); }
  .tl-gray { color: var(--dim); }

  /* Notes */
  .notes-area { margin-top: 6px; }
  .notes-textarea { width: 100%; min-height: 60px; max-height: 150px; background: var(--bg);
                    color: var(--text); border: 1px solid var(--border); border-radius: 6px;
                    padding: 8px; font-size: 12px; font-family: 'Segoe UI', sans-serif;
                    resize: vertical; outline: none; }
  .notes-textarea:focus { border-color: var(--blue); }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px;
         font-weight: 600; margin: 0 2px; }
  .tag-important { background: rgba(248,81,73,0.15); color: var(--red); }
  .tag-blocked { background: rgba(210,153,34,0.15); color: var(--orange); }
  .tag-wip { background: rgba(88,166,255,0.15); color: var(--blue); }
  .tag-default { background: rgba(188,140,255,0.15); color: var(--purple); }

  /* Pin */
  .pin-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 4px;
             opacity: 0.4; transition: opacity 0.2s; }
  .pin-btn:hover, .pin-btn.pinned { opacity: 1; }
  .pinned-section { position: sticky; top: 0; z-index: 10; background: var(--bg);
                    border-bottom: 2px solid var(--yellow); padding: 8px 24px 12px;
                    margin-bottom: 8px; }
  .pinned-section .group-header { border-bottom-color: var(--yellow); }
  .pinned-section .group-title { color: var(--yellow); }

  /* Header buttons (sound, cleanup, analytics) */
  .header-btn { background: var(--bg); color: var(--dim); border: 1px solid var(--border);
                border-radius: 6px; padding: 5px 12px; font-size: 14px; cursor: pointer;
                transition: all 0.2s; line-height: 1; position: relative; }
  .header-btn:hover { border-color: var(--blue); color: var(--blue); }
  .header-badge { position: absolute; top: -5px; right: -5px; background: var(--red);
                  color: #fff; font-size: 9px; font-weight: 700; padding: 1px 5px;
                  border-radius: 8px; min-width: 14px; text-align: center; }

  /* Stats bar */
  .stats-bar { background: var(--card); border-bottom: 1px solid var(--border);
               padding: 10px 24px; font-size: 13px; color: var(--text);
               display: flex; align-items: center; gap: 16px; font-weight: 600; }
  .stats-bar span { display: flex; align-items: center; gap: 4px; }

  /* Group-by dropdown */
  .group-by-select { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                     border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .group-by-select:hover { border-color: var(--blue); }

  /* Focus button */
  .focus-btn { background: rgba(188,140,255,0.1); color: var(--purple); border: 1px solid var(--purple);
               border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
               display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
               font-family: 'Segoe UI', -apple-system, sans-serif; }
  .focus-btn:hover { background: rgba(188,140,255,0.25); }

  /* Workspace save/restore toast */
  .ws-toast { position: fixed; top: 20px; right: 20px; z-index: 9999; background: var(--card);
              border: 1px solid var(--border); border-radius: 10px; padding: 14px 20px;
              box-shadow: 0 8px 24px rgba(0,0,0,0.4); font-size: 13px; color: var(--text);
              animation: toast-in 0.3s ease; max-width: 360px; }
  .ws-toast.success { border-color: var(--green); }
  .ws-toast.error { border-color: var(--red); }
  .ws-toast .toast-title { font-weight: 700; margin-bottom: 4px; }
  .ws-toast .toast-detail { color: var(--dim); font-size: 12px; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  .ws-restore-badge { background: var(--green); color: #fff; font-size: 9px; font-weight: 700;
                      padding: 1px 5px; border-radius: 8px; min-width: 14px; text-align: center;
                      position: absolute; top: -5px; right: -5px; }

  /* Workspace backups modal */
  .ws-modal-overlay { position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,0.55);
                      display: none; align-items: flex-start; justify-content: center; padding: 60px 16px 16px; }
  .ws-modal-overlay.open { display: flex; }
  .ws-modal { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
              width: 100%; max-width: 720px; max-height: 80vh; display: flex; flex-direction: column;
              box-shadow: 0 12px 32px rgba(0,0,0,0.5); overflow: hidden; }
  .ws-modal-header { display: flex; align-items: center; justify-content: space-between;
                     padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .ws-modal-header h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
  .ws-modal-close { background: transparent; border: none; color: var(--dim); font-size: 20px;
                    cursor: pointer; padding: 0 4px; }
  .ws-modal-close:hover { color: var(--text); }
  .ws-modal-body { padding: 12px 18px; overflow-y: auto; }
  .ws-modal-empty { color: var(--dim); padding: 28px 0; text-align: center; font-size: 13px; }
  .ws-backup-row { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
                   margin-bottom: 10px; background: rgba(255,255,255,0.02); }
  .ws-backup-row.active { border-color: var(--green); background: rgba(76,175,80,0.06); }
  .ws-backup-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ws-backup-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ws-backup-slot { font-weight: 700; color: var(--text); font-size: 13px; }
  .ws-backup-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px;
                   background: rgba(88,166,255,0.18); color: var(--blue); font-weight: 600; }
  .ws-backup-tag.current { background: rgba(76,175,80,0.18); color: var(--green); }
  .ws-backup-time { color: var(--dim); font-size: 11px; }
  .ws-backup-count { color: var(--text); font-size: 12px; }
  .ws-backup-actions { display: flex; gap: 6px; }
  .ws-backup-btn { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border);
                   border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer;
                   font-family: 'Segoe UI', -apple-system, sans-serif; }
  .ws-backup-btn:hover { background: rgba(88,166,255,0.15); border-color: var(--blue); color: var(--blue); }
  .ws-backup-btn.primary { background: rgba(76,175,80,0.15); border-color: var(--green); color: var(--green); }
  .ws-backup-btn.primary:hover { background: rgba(76,175,80,0.28); }
  .ws-backup-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
  .ws-backup-sessions { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border);
                        display: none; }
  .ws-backup-sessions.open { display: block; }
  .ws-backup-sess { font-size: 11px; color: var(--dim); padding: 3px 0;
                    display: flex; gap: 6px; align-items: baseline; }
  .ws-backup-sess code { font-family: 'Cascadia Code', Consolas, monospace; color: var(--blue);
                         font-size: 10px; }
  .ws-backup-sess .sess-summary { color: var(--text); font-weight: 500; }

  /* Timeline/notes toggle buttons */
  .meta-btn { background: rgba(255,255,255,0.06); color: var(--dim); border: 1px solid var(--border);
              border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
              display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
              font-family: 'Segoe UI', -apple-system, sans-serif; }
  .meta-btn:hover { background: rgba(88,166,255,0.15); border-color: var(--blue); color: var(--blue); }

  /* Quick respond tooltip */
  .respond-tip { font-size: 11px; color: var(--yellow); font-style: italic; display: flex;
                 align-items: center; gap: 4px; margin-top: 4px; }
</style>
</head>
<body>
<div class="header">
  <div class="dot"></div>
  <h1>Copilot Sessions Monitor</h1>
  <div class="refresh">Live • auto-refreshing</div>
  <button class="theme-toggle" id="themeToggle" title="Toggle light/dark mode">🌙</button>
  <button class="header-btn" id="soundToggle" title="Toggle sound alerts for attention items">🔔</button>
  <button class="header-btn" id="saveWorkspaceBtn" title="Save all active sessions for later restore">💾</button>
  <button class="header-btn" id="restoreWorkspaceBtn" title="Restore previously saved sessions" style="display:none;">🔄</button>
  <button class="header-btn" id="workspaceBackupsBtn" title="Browse workspace snapshots and promote one to active">📜</button>
  <button class="header-btn" id="screenBlankBtn" title="Blank all screens (click/key/mouse to dismiss)">&#x1f5a5;&#xfe0f;</button>
  <button class="header-btn" id="cancelLockBtn" title="Cancel computer lock" style="display:none;background:#b62324;color:#fff;border-color:#b62324;font-weight:700;min-width:90px;">🔓 3s</button>
  <button class="header-btn" id="cleanupBtn" title="Clean up stale sessions">🧹</button>
  <a href="/analytics" class="header-btn" title="Session analytics" style="text-decoration:none;">📊</a>
  <a href="/todos" class="header-btn" title="Todos — AI-organized task list with worktree launcher" style="text-decoration:none;">📝</a>
  <a href="/reports" class="header-btn" title="Weekly &amp; monthly activity reports" style="text-decoration:none;">📋</a>
</div>

<div class="repo-bar">
  <label>📂 Open Repo</label>
  <select class="repo-select" id="repoSelect">
    <option value="">Loading repos…</option>
  </select>
  <select class="editor-select" id="editorSelect">
    <option value="code">VS Code</option>
    <option value="vs">Visual Studio</option>
  </select>
  <button class="repo-btn" id="repoOpenBtn" disabled>Open</button>
</div>

<div class="search-bar">
  <label>🔍 Search</label>
  <input class="search-input" id="searchInput" type="text" placeholder="Filter by title, goal, repo, branch…" autocomplete="off" />
  <span class="search-count" id="searchCount"></span>
  <button class="search-clear hidden" id="searchClear">✕ Clear</button>
  <select class="group-by-select" id="groupBySelect" title="Group sessions by">
    <option value="status">Group by: Status</option>
    <option value="repository">Group by: Repository</option>
    <option value="branch">Group by: Branch</option>
  </select>
</div>

<div class="stats-bar" id="statsBar"></div>

<div id="pinnedSection" class="pinned-section" style="display:none;"></div>

<div class="attention-banner hidden" id="banner">
  <span class="count" id="bannerCount">0</span>
  <span>🚨 session(s) BLOCKED — waiting for your input or permission!</span>
</div>

<div class="intrusion-banner hidden" id="intrusionBanner">
  <div class="intrusion-header">
    <span class="intrusion-icon">🚫</span>
    <div class="intrusion-text">
      Someone tried to use your computer while it was locked!
      <div class="intrusion-time" id="intrusionTime"></div>
    </div>
    <div class="intrusion-actions">
      <button class="intrusion-btn" id="intrusionTogglePhoto">📷 View Photo ▼</button>
      <button class="intrusion-btn dismiss" id="intrusionDismiss">✕ Dismiss</button>
    </div>
  </div>
  <div class="intrusion-photo-panel" id="intrusionPhotoPanel">
    <img id="intrusionPhoto" src="" alt="Intruder photo" style="display:none;" />
    <div class="no-photo" id="intrusionNoPhoto">Capturing photo…</div>
  </div>
</div>

<div id="content"></div>

<div class="ws-modal-overlay" id="wsBackupsModal">
  <div class="ws-modal">
    <div class="ws-modal-header">
      <h2>📜 Workspace Snapshots</h2>
      <button class="ws-modal-close" id="wsBackupsClose" title="Close">✕</button>
    </div>
    <div class="ws-modal-body" id="wsBackupsBody">
      <div class="ws-modal-empty">Loading…</div>
    </div>
  </div>
</div>

<script>
let latestSessions = [];
let sessionNotes = {};
let pinnedSessions = new Set(JSON.parse(localStorage.getItem('dashboard-pinned') || '[]'));
let groupByMode = localStorage.getItem('dashboard-group-by') || 'status';
let soundMuted = localStorage.getItem('dashboard-sound-muted') === 'true';
let alertedSessionIds = new Set();
let openTimelines = new Set();
let openNotes = new Set();
let timelineCache = {}; // sessionId -> events array

// Init group-by dropdown
document.getElementById('groupBySelect').value = groupByMode;
document.getElementById('groupBySelect').addEventListener('change', (e) => {
  groupByMode = e.target.value;
  localStorage.setItem('dashboard-group-by', groupByMode);
  displaySessions();
});

// Sound toggle
(function initSound() {
  const btn = document.getElementById('soundToggle');
  btn.textContent = soundMuted ? '🔇' : '🔔';
  btn.addEventListener('click', () => {
    soundMuted = !soundMuted;
    localStorage.setItem('dashboard-sound-muted', soundMuted);
    btn.textContent = soundMuted ? '🔇' : '🔔';
  });
})();

function playChime() {
  if (soundMuted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc1 = ctx.createOscillator(); const gain1 = ctx.createGain();
    osc1.type = 'sine'; osc1.frequency.value = 880;
    gain1.gain.setValueAtTime(0.3, ctx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc1.connect(gain1); gain1.connect(ctx.destination);
    osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 0.3);
    const osc2 = ctx.createOscillator(); const gain2 = ctx.createGain();
    osc2.type = 'sine'; osc2.frequency.value = 1174;
    gain2.gain.setValueAtTime(0.3, ctx.currentTime + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
    osc2.connect(gain2); gain2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.15); osc2.stop(ctx.currentTime + 0.45);
    setTimeout(() => ctx.close(), 1000);
  } catch {}
}

// Load notes
fetch('/api/notes').then(r => r.json()).then(n => { sessionNotes = n || {}; }).catch(() => {});

// Cleanup button
(function initCleanup() {
  const btn = document.getElementById('cleanupBtn');
  btn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/stale-sessions');
      const stale = await resp.json();
      if (!stale || stale.length === 0) { alert('No stale sessions to clean up.'); return; }
      if (!confirm('Move ' + stale.length + ' stale session(s) (30+ days old) to archive?')) return;
      await fetch('/api/cleanup', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionIds: stale.map(s => s.id) })
      });
      alert('Cleaned up ' + stale.length + ' session(s).');
      fetch('/api/sessions').then(r => r.json()).then(render);
    } catch { alert('Cleanup failed.'); }
  });
  // Check stale count on load
  fetch('/api/stale-sessions').then(r => r.json()).then(stale => {
    if (stale && stale.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'header-badge';
      badge.textContent = stale.length;
      btn.appendChild(badge);
    }
  }).catch(() => {});
})();

// Theme toggle with localStorage persistence
(function initTheme() {
  const saved = localStorage.getItem('dashboard-theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
})();
document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dashboard-theme', next);
  document.getElementById('themeToggle').textContent = next === 'light' ? '☀️' : '🌙';
});
let notifiedWaiting = false;
let searchQuery = '';

function matchesSearch(s, query) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const noteText = sessionNotes[s.id] || '';
  const haystack = [
    s.summary, s.goal, s.stage, s.progressNote,
    s.cwd, s.branch, s.repository, s.label, s.id, noteText
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => haystack.includes(t));
}

function getFilteredSessions() {
  if (!searchQuery) return latestSessions;
  return latestSessions.filter(s => matchesSearch(s, searchQuery));
}

function copySessionId(btn) {
  const id = btn.getAttribute('data-session-id');
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋 Copy ID'; }, 1500);
  });
}

function copyCwd(btn) {
  const cwd = btn.getAttribute('data-cwd');
  if (!cwd) return;
  navigator.clipboard.writeText(cwd).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✅';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋'; }, 1500);
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-id-btn');
  if (btn) copySessionId(btn);
  const resumeBtn = e.target.closest('.resume-btn');
  if (resumeBtn) resumeSession(resumeBtn);
  const killBtn = e.target.closest('.kill-btn');
  if (killBtn) killSession(killBtn);
  const tlBtn = e.target.closest('.timeline-btn');
  if (tlBtn) toggleTimeline(tlBtn);
  const notesBtn = e.target.closest('.notes-btn');
  if (notesBtn) toggleNotes(notesBtn);
  const pinBtn = e.target.closest('.pin-btn');
  if (pinBtn) togglePin(pinBtn);
  const copyCwdBtn = e.target.closest('.copy-cwd-btn');
  if (copyCwdBtn) copyCwd(copyCwdBtn);
  const cwdLink = e.target.closest('.cwd-link');
  if (cwdLink) openCwdInCode(cwdLink);
});

async function killSession(btn) {
  const pid = btn.dataset.pid;
  if (!confirm('Kill session process (PID ' + pid + ')?')) return;
  btn.textContent = '⏳ Killing…';
  try {
    await fetch('/api/kill', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pid }) });
    btn.textContent = '☠️ Killed';
    setTimeout(() => { fetch('/api/sessions').then(r => r.json()).then(render); }, 1000);
  } catch { btn.textContent = '❌ Failed'; }
}

function openCwdInCode(link) {
  const cwd = link.dataset.cwd;
  if (!cwd) return;
  link.style.opacity = '0.5';
  fetch('/api/open', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: cwd, editor: 'code' }) })
    .then(() => { link.style.opacity = ''; })
    .catch(() => { link.style.opacity = ''; });
}

async function toggleTimeline(btn) {
  const sid = btn.dataset.sessionId;
  if (openTimelines.has(sid)) { openTimelines.delete(sid); delete timelineCache[sid]; displaySessions(); return; }
  openTimelines.add(sid);
  btn.textContent = '⏳ Loading…';
  try {
    const resp = await fetch('/api/events?id=' + encodeURIComponent(sid));
    timelineCache[sid] = await resp.json();
  } catch { timelineCache[sid] = []; }
  displaySessions();
}

function toggleNotes(btn) {
  const sid = btn.dataset.sessionId;
  if (openNotes.has(sid)) { openNotes.delete(sid); } else { openNotes.add(sid); }
  displaySessions();
}

// After re-render, re-attach note textareas with event listeners
function attachNoteListeners() {
  for (const sid of openNotes) {
    const ta = document.getElementById('note-ta-' + sid);
    if (!ta || ta.dataset.bound) continue;
    ta.dataset.bound = '1';
    let saveTimer = null;
    ta.addEventListener('input', () => {
      sessionNotes[sid] = ta.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        fetch('/api/notes', { method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ sessionId: sid, note: ta.value }) });
      }, 800);
    });
  }
}

function togglePin(btn) {
  const sid = btn.dataset.sessionId;
  if (pinnedSessions.has(sid)) { pinnedSessions.delete(sid); } else { pinnedSessions.add(sid); }
  localStorage.setItem('dashboard-pinned', JSON.stringify([...pinnedSessions]));
  displaySessions();
}

async function resumeSession(btn) {
  const sid = btn.dataset.sessionId;
  btn.textContent = '⏳…';
  const session = latestSessions.find(s => s.id === sid);
  const title = session?.baseSummary || session?.summary || '';
  const altTitle = session?.latestIntent || session?.summary || '';
  const pid = session?.pid || '';
  const cwd = session?.cwd || btn.dataset.cwd || '';
  try {
    const resp = await fetch('/api/focus-tab', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title, altTitle, pid, cwd, sessionId: sid }) });
    const data = await resp.json();
    if (data.action === 'launched') {
      btn.textContent = '🚀 Launched';
    } else {
      btn.textContent = '✅ Focused';
    }
  } catch { btn.textContent = '❌ Failed'; }
  setTimeout(() => { btn.textContent = '▶️ Resume'; }, 2000);
}

// --- Workspace save/restore ---
function showToast(title, detail, type) {
  const t = document.createElement('div');
  t.className = 'ws-toast ' + (type || '');
  t.innerHTML = '<div class="toast-title">' + title + '</div><div class="toast-detail">' + (detail || '') + '</div>';
  document.body.appendChild(t);
  setTimeout(() => { t.remove(); }, 4000);
}

async function checkWorkspaceStatus() {
  try {
    const resp = await fetch('/api/workspace-status');
    const data = await resp.json();
    const btn = document.getElementById('restoreWorkspaceBtn');
    if (data.hasSaved && data.count > 0) {
      btn.style.display = '';
      let badge = btn.querySelector('.ws-restore-badge');
      if (!badge) { badge = document.createElement('span'); badge.className = 'ws-restore-badge'; btn.appendChild(badge); }
      badge.textContent = data.count;
      btn.title = 'Restore ' + data.count + ' saved sessions (saved ' + timeAgo(data.savedAt) + ')';
    } else {
      btn.style.display = 'none';
    }
  } catch {}
}

document.getElementById('screenBlankBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/screen-blank', { method: 'POST' });
  } catch {}
});

// Lock countdown UI
let lockCountdownInterval = null;
document.getElementById('cancelLockBtn').addEventListener('click', async () => {
  try { await fetch('/api/cancel-lock', { method: 'POST' }); } catch {}
  const btn = document.getElementById('cancelLockBtn');
  btn.style.display = 'none';
  if (lockCountdownInterval) { clearInterval(lockCountdownInterval); lockCountdownInterval = null; }
});

// Listen for lock-countdown and intrusion SSE events (reuse main EventSource)
const lockEs = new EventSource('/api/stream');
lockEs.addEventListener('lockCountdown', (e) => {
  try {
    const d = JSON.parse(e.data);
    const btn = document.getElementById('cancelLockBtn');
    if (d.remaining <= 0 || d.cancelled) {
      btn.style.display = 'none';
      if (lockCountdownInterval) { clearInterval(lockCountdownInterval); lockCountdownInterval = null; }
    } else {
      btn.style.display = '';
      btn.textContent = '\u{1F513} ' + d.remaining + 's';
      // Local countdown so the number ticks every second between SSE pushes
      if (lockCountdownInterval) clearInterval(lockCountdownInterval);
      let rem = d.remaining;
      lockCountdownInterval = setInterval(() => {
        rem--;
        if (rem <= 0) { btn.style.display = 'none'; clearInterval(lockCountdownInterval); lockCountdownInterval = null; return; }
        btn.textContent = '\u{1F513} ' + rem + 's';
      }, 1000);
    }
  } catch {}
});

function showIntrusionBanner(timestamp) {
  const ib = document.getElementById('intrusionBanner');
  ib.classList.remove('hidden');
  const t = new Date(timestamp);
  document.getElementById('intrusionTime').textContent = 'Detected at ' + t.toLocaleString();
  // Load photo once
  const img = document.getElementById('intrusionPhoto');
  const testImg = new Image();
  testImg.onload = () => {
    img.src = testImg.src;
    img.style.display = '';
    document.getElementById('intrusionNoPhoto').style.display = 'none';
  };
  testImg.onerror = () => {
    document.getElementById('intrusionNoPhoto').textContent = 'No photo captured';
  };
  testImg.src = '/api/intrusion-photo?t=' + Date.now();
}

// Toggle photo dropdown
document.getElementById('intrusionTogglePhoto').addEventListener('click', () => {
  const panel = document.getElementById('intrusionPhotoPanel');
  const btn = document.getElementById('intrusionTogglePhoto');
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'block';
    btn.textContent = '\u{1F4F7} Hide Photo \u25B2';
  } else {
    panel.style.display = 'none';
    btn.textContent = '\u{1F4F7} View Photo \u25BC';
  }
});

lockEs.addEventListener('intrusion', (e) => {
  try {
    const d = JSON.parse(e.data);
    if (d.intrusion) showIntrusionBanner(d.timestamp);
  } catch {}
});

// Intrusion alert — also check on page load
(async () => {
  try {
    const resp = await fetch('/api/intrusion-status');
    const d = await resp.json();
    if (d.intrusion) showIntrusionBanner(d.timestamp);
  } catch {}
})();
document.getElementById('intrusionDismiss').addEventListener('click', async () => {
  try { await fetch('/api/dismiss-intrusion', { method: 'POST' }); } catch {}
  document.getElementById('intrusionBanner').classList.add('hidden');
});

document.getElementById('saveWorkspaceBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveWorkspaceBtn');
  const orig = btn.textContent;
  btn.textContent = '⏳';
  try {
    const resp = await fetch('/api/save-workspace', { method: 'POST' });
    const data = await resp.json();
    if (data.count > 0) {
      showToast('💾 Workspace Saved', data.count + ' active session(s) saved. Restore after restart with 🔄.', 'success');
    } else {
      showToast('💾 No Sessions', 'No active sessions to save.', '');
    }
    checkWorkspaceStatus();
  } catch { showToast('❌ Save Failed', 'Could not save workspace.', 'error'); }
  btn.textContent = orig;
});

document.getElementById('restoreWorkspaceBtn').addEventListener('click', async () => {
  const btn = document.getElementById('restoreWorkspaceBtn');
  // Fetch status first for confirmation
  try {
    const st = await fetch('/api/workspace-status').then(r => r.json());
    if (!st.hasSaved || st.count === 0) { showToast('No Saved Workspace', '', ''); return; }
    if (!confirm('Restore ' + st.count + ' session(s) saved ' + timeAgo(st.savedAt) + '?')) return;
  } catch { return; }
  const orig = btn.textContent;
  btn.textContent = '⏳';
  try {
    const resp = await fetch('/api/restore-workspace', { method: 'POST' });
    const data = await resp.json();
    let msg = '';
    if (data.restored > 0) msg += data.restored + ' restored. ';
    if (data.skippedAlive > 0) msg += data.skippedAlive + ' already running. ';
    if (data.skippedMissing > 0) msg += data.skippedMissing + ' missing. ';
    if (data.failed > 0) msg += data.failed + ' failed. ';
    showToast('🔄 Workspace Restored', msg.trim(), data.restored > 0 ? 'success' : 'error');
    checkWorkspaceStatus();
  } catch { showToast('❌ Restore Failed', '', 'error'); }
  btn.textContent = orig;
});

// --- Workspace backups browser ---
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function openWorkspaceBackups() {
  const overlay = document.getElementById('wsBackupsModal');
  const body = document.getElementById('wsBackupsBody');
  overlay.classList.add('open');
  body.innerHTML = '<div class="ws-modal-empty">Loading snapshots…</div>';
  try {
    const data = await fetch('/api/workspace-backups').then(r => r.json());
    const snaps = data.snapshots || [];
    if (snaps.length === 0) {
      body.innerHTML = '<div class="ws-modal-empty">No workspace snapshots found.</div>';
      return;
    }
    const html = snaps.map((snap, idx) => {
      const isCurrent = snap.slot === 'current';
      const label = isCurrent ? 'Active (saved-workspace.json)' : 'Backup .' + snap.slot;
      const tagClass = isCurrent ? 'current' : '';
      const tagText = isCurrent ? 'ACTIVE' : '#' + snap.slot;
      const sessHtml = (snap.sessions || []).map(s => {
        const idShort = (s.sessionId || '').slice(0, 8);
        const summary = escapeHtml(s.summary || 'Untitled');
        const cwd = escapeHtml(s.cwd || '');
        const branch = s.branch ? ' · ' + escapeHtml(s.branch) : '';
        return '<div class="ws-backup-sess"><code>' + idShort + '</code>' +
               '<span class="sess-summary">' + summary + '</span>' +
               '<span>— ' + cwd + branch + '</span></div>';
      }).join('');
      const promoteBtn = isCurrent
        ? ''
        : '<button class="ws-backup-btn primary" data-slot="' + snap.slot + '" data-action="promote">⬆️ Make active</button>';
      return '<div class="ws-backup-row ' + (isCurrent ? 'active' : '') + '" data-idx="' + idx + '">' +
        '<div class="ws-backup-head">' +
          '<div class="ws-backup-meta">' +
            '<span class="ws-backup-slot">' + escapeHtml(label) + '</span>' +
            '<span class="ws-backup-tag ' + tagClass + '">' + tagText + '</span>' +
            '<span class="ws-backup-count">' + (snap.count || 0) + ' session' + (snap.count === 1 ? '' : 's') + '</span>' +
            '<span class="ws-backup-time">' + (snap.savedAt ? timeAgo(snap.savedAt) + ' (' + new Date(snap.savedAt).toLocaleString() + ')' : 'unknown time') + '</span>' +
          '</div>' +
          '<div class="ws-backup-actions">' +
            '<button class="ws-backup-btn" data-idx="' + idx + '" data-action="toggle">👁️ Sessions</button>' +
            promoteBtn +
          '</div>' +
        '</div>' +
        '<div class="ws-backup-sessions" id="wsBackupSess-' + idx + '">' + (sessHtml || '<div class="ws-backup-sess">(none)</div>') + '</div>' +
      '</div>';
    }).join('');
    body.innerHTML = html;
    body.querySelectorAll('button[data-action="toggle"]').forEach(b => {
      b.addEventListener('click', () => {
        const el = document.getElementById('wsBackupSess-' + b.dataset.idx);
        if (el) el.classList.toggle('open');
      });
    });
    body.querySelectorAll('button[data-action="promote"]').forEach(b => {
      b.addEventListener('click', async () => {
        const slot = b.dataset.slot;
        if (!confirm('Promote backup .' + slot + ' to the active saved workspace?\\n\\nThe current active file will be rotated into the backup chain (becoming .1).')) return;
        b.disabled = true;
        b.textContent = '⏳ Promoting…';
        try {
          const resp = await fetch('/api/workspace-promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slot: Number(slot) }),
          });
          const data = await resp.json();
          if (data.ok) {
            showToast('⬆️ Snapshot Promoted', 'Backup .' + slot + ' is now active (' + data.count + ' sessions). Click 🔄 to restore.', 'success');
            checkWorkspaceStatus();
            openWorkspaceBackups(); // refresh list
          } else {
            showToast('❌ Promote Failed', data.error || '', 'error');
            b.disabled = false;
            b.textContent = '⬆️ Make active';
          }
        } catch (e) {
          showToast('❌ Promote Failed', String(e), 'error');
          b.disabled = false;
          b.textContent = '⬆️ Make active';
        }
      });
    });
  } catch (e) {
    body.innerHTML = '<div class="ws-modal-empty">Failed to load snapshots: ' + escapeHtml(String(e)) + '</div>';
  }
}

document.getElementById('workspaceBackupsBtn').addEventListener('click', openWorkspaceBackups);
document.getElementById('wsBackupsClose').addEventListener('click', () => {
  document.getElementById('wsBackupsModal').classList.remove('open');
});
document.getElementById('wsBackupsModal').addEventListener('click', (e) => {
  if (e.target.id === 'wsBackupsModal') {
    document.getElementById('wsBackupsModal').classList.remove('open');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('wsBackupsModal').classList.remove('open');
  }
});

checkWorkspaceStatus();

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

function cardClass(status, group) {
  if (group === "unseen") return "card-unseen";
  if (group === "recent") return "card-recent";
  if (status === "waiting") return "card-waiting";
  if (status === "working") return "card-working";
  if (status === "idle") return "card-idle";
  if (status === "completed") return "card-completed";
  if (status === "error") return "card-error";
  if (status === "active") return "card-working";
  return "card-inactive";
}

function getStartOfPreviousWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceThisMonday = (day === 0 ? 6 : day - 1);
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceThisMonday);
  const prevMonday = new Date(thisMonday);
  prevMonday.setDate(prevMonday.getDate() - 7);
  prevMonday.setHours(0, 0, 0, 0);
  return prevMonday;
}

function groupFor(s) {
  if (s.status === "waiting") return "attention";
  // Unseen: alive, turn done, not yet seen by user, not stale (stale = idle 10+ min, likely not an open tab)
  if (s.alive && s.unseen && (s.status === "completed" || s.status === "idle") && !/Stale/i.test(s.label)) {
    return "unseen";
  }
  if (s.status === "working" || s.status === "active") return "working";
  if (s.alive && s.status === "completed") return "completed";
  if (s.alive && s.status === "idle") return "idle";
  return "inactive";
}

function renderCard(s, group) {
  let summaryHtml = '';
  if (s.goal || s.stage || s.progressNote) {
    summaryHtml = '<div class="ai-summary">';
    if (s.goal) summaryHtml += '<div class="ai-line"><strong>Goal:</strong> ' + esc(s.goal) + '</div>';
    if (s.stage) summaryHtml += '<div class="ai-line"><strong>Stage:</strong> ' + esc(s.stage) + '</div>';
    if (s.progressNote) summaryHtml += '<div class="ai-line"><strong>Progress:</strong> ' + esc(s.progressNote) + '</div>';
    summaryHtml += '</div>';
  }

  // Duration calculation
  let durationStr = '';
  if (s.firstEventTime && s.lastEventTime) {
    const dur = new Date(s.lastEventTime).getTime() - new Date(s.firstEventTime).getTime();
    if (dur > 0) {
      const mins = Math.floor(dur / 60000);
      if (mins < 60) durationStr = mins + 'm';
      else { const hrs = Math.floor(mins / 60); durationStr = hrs + 'h ' + (mins % 60) + 'm'; }
    }
  }

  // Notes tags rendering
  let noteTagsHtml = '';
  const noteText = sessionNotes[s.id] || '';
  if (noteText) {
    const tags = noteText.match(/#\\w+/g) || [];
    for (const tag of tags) {
      const word = tag.slice(1).toLowerCase();
      let cls = 'tag-default';
      if (word === 'important') cls = 'tag-important';
      else if (word === 'blocked') cls = 'tag-blocked';
      else if (word === 'wip') cls = 'tag-wip';
      noteTagsHtml += '<span class="tag ' + cls + '">' + esc(tag) + '</span>';
    }
  }

  const isPinned = pinnedSessions.has(s.id);
  const statsHtml = '<div class="card-stats">'
    + '<span>💬 ' + s.turns + ' turns</span>'
    + '<span>🔧 ' + s.toolCalls + ' tools</span>'
    + (s.taskCompletes > 0 ? '<span>✅ ' + s.taskCompletes + ' completed</span>' : '')
    + ((s.errors || 0) > 0 ? '<span>🔥 ' + s.errors + ' errors</span>' : '')
    + (durationStr ? '<span>⏱ ' + durationStr + '</span>' : '')
    + '</div>';

  // Quick respond tooltip for waiting cards (feature 11)
  let respondHtml = '';
  if (s.status === 'waiting') {
    respondHtml = '<div class="respond-tip">💡 Switch to terminal to respond'
      + (s.alive ? ' <button class="focus-btn" data-session-id="' + esc(s.id) + '">▶️ Go to Terminal</button>' : '')
      + '</div>';
  }

  // Inline timeline HTML if open
  let timelineHtml = '';
  if (openTimelines.has(s.id) && timelineCache[s.id]) {
    const events = timelineCache[s.id];
    timelineHtml = '<div class="timeline">' + events.map(ev => {
      const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
      const t = ev.type || '';
      let cls = 'tl-gray', icon = '•', desc = t;
      if (t.startsWith('user.message')) { cls = 'tl-green'; icon = '👤'; desc = (ev.data?.content || '').slice(0, 100) || 'User message'; }
      else if (t.startsWith('assistant.message')) { cls = 'tl-purple'; icon = '🤖'; desc = (ev.data?.content || '').slice(0, 100) || 'Assistant message'; }
      else if (t === 'tool.execution_start') { cls = 'tl-blue'; icon = '🔧'; desc = 'Start: ' + (ev.data?.toolName || 'tool'); }
      else if (t === 'tool.execution_complete') { cls = 'tl-blue-dim'; icon = '✔'; desc = 'Done: ' + (ev.data?.toolName || 'tool'); }
      else if (t === 'session.error') { cls = 'tl-red'; icon = '🔥'; desc = (ev.data?.message || ev.data?.content || 'Error').slice(0, 100); }
      else if (t === 'permission.requested') { cls = 'tl-yellow'; icon = '🔐'; desc = 'Permission requested'; }
      else if (t.includes('turn_start')) { cls = 'tl-gray'; icon = '▶'; desc = 'Turn start'; }
      else if (t.includes('turn_end')) { cls = 'tl-gray'; icon = '⏹'; desc = 'Turn end'; }
      else if (t === 'session.task_complete') { cls = 'tl-green'; icon = '✅'; desc = 'Task complete'; }
      return '<div class="timeline-entry"><span class="timeline-ts">' + esc(ts) + '</span><span class="timeline-icon ' + cls + '">' + icon + '</span><span class="timeline-desc ' + cls + '">' + esc(desc) + '</span></div>';
    }).join('') + '</div>';
  }

  // Inline notes textarea if open
  let notesHtml = '';
  if (openNotes.has(s.id)) {
    notesHtml = '<div class="notes-area"><textarea id="note-ta-' + esc(s.id) + '" class="notes-textarea" placeholder="Add notes, use #tags…">' + esc(sessionNotes[s.id] || '') + '</textarea></div>';
  }

  return '<div class="session ' + cardClass(s.status, group) + '">'
    + '<div class="icon">' + s.icon + '</div>'
    + '<div class="title-row">'
    + '  <span class="name">' + esc(s.summary) + '</span>'
    + (s.baseSummary && s.baseSummary !== s.summary ? '  <span class="base-summary">' + esc(s.baseSummary) + '</span>' : '')
    + '  <span class="badge">' + esc(s.label) + '</span>'
    + '  <button class="pin-btn' + (isPinned ? ' pinned' : '') + '" data-session-id="' + esc(s.id) + '" title="' + (isPinned ? 'Unpin' : 'Pin') + '">' + (isPinned ? '📌' : '📍') + '</button>'
    + noteTagsHtml
    + '</div>'
    + '<div class="time"><span class="ago">' + timeAgo(s.updatedAt) + '</span>'
    + '<span>' + fmtTime(s.updatedAt) + '</span></div>'
    + '<div class="card-detail">'
    + summaryHtml
    + statsHtml
    + respondHtml
    + '<div class="meta">'
    + '<button class="copy-id-btn" data-session-id="' + esc(s.id) + '" title="Copy session ID to clipboard">📋 Copy ID</button>'
    + '<button class="resume-btn" data-session-id="' + esc(s.id) + '" data-cwd="' + esc(s.cwd || '') + '" title="Focus existing tab or launch new one">▶️ Resume</button>'
    + (s.pid && s.alive ? '<button class="kill-btn" data-pid="' + esc(s.pid) + '" title="Kill this session process">🛑 Kill</button>' : '')
    + '<button class="meta-btn timeline-btn" data-session-id="' + esc(s.id) + '">' + (openTimelines.has(s.id) ? '📜 Hide' : '📜 Timeline') + '</button>'
    + '<button class="meta-btn notes-btn" data-session-id="' + esc(s.id) + '">' + (openNotes.has(s.id) ? '📝 Hide' : '📝 Notes') + '</button>'
    + (s.cwd ? '<a class="cwd-link" data-cwd="' + esc(s.cwd) + '" title="Open in VS Code: ' + esc(s.cwd) + '">📂 ' + esc(shortPath(s.cwd)) + '</a>' + '<button class="copy-cwd-btn" data-cwd="' + esc(s.cwd) + '" title="Copy directory path to clipboard">📋</button>' : '')
    + (s.branch ? '<span>🌿 ' + esc(s.branch) + '</span>' : '')
    + (s.pid && s.alive ? '<span>⚡ PID ' + s.pid + '</span>' : '')
    + '</div>'
    + timelineHtml
    + notesHtml
    + '</div>'
    + '</div>';
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}

function render(sessions) {
  // Sound alerts for new attention items
  for (const s of sessions) {
    if (groupFor(s) === 'attention' && !alertedSessionIds.has(s.id)) {
      alertedSessionIds.add(s.id);
      playChime();
    }
  }
  // Remove IDs that are no longer in attention
  for (const id of alertedSessionIds) {
    if (!sessions.find(s => s.id === id && groupFor(s) === 'attention')) alertedSessionIds.delete(id);
  }
  latestSessions = sessions;
  updateStatsBar(sessions);
  displaySessions();
}

function updateStatsBar(sessions) {
  const active = sessions.filter(s => s.alive);
  const totalTurns = sessions.reduce((a, s) => a + (s.turns || 0), 0);
  const totalTools = sessions.reduce((a, s) => a + (s.toolCalls || 0), 0);
  const totalErrors = sessions.reduce((a, s) => a + (s.errors || 0), 0);
  const bar = document.getElementById('statsBar');
  bar.innerHTML = '<span>📊 Active: ' + active.length + ' sessions</span>'
    + '<span>· 💬 ' + totalTurns + ' turns</span>'
    + '<span>· 🔧 ' + totalTools + ' tools</span>'
    + (totalErrors > 0 ? '<span>· 🔥 ' + totalErrors + ' errors</span>' : '');
}

function statusPriority(s) {
  const order = { waiting: 0, working: 1, active: 2, idle: 3, completed: 4, error: 5, inactive: 6 };
  return order[s.status] !== undefined ? order[s.status] : 7;
}

function displaySessions() {
  const filtered = getFilteredSessions();
  const content = document.getElementById("content");
  const banner = document.getElementById("banner");
  const searchCountEl = document.getElementById("searchCount");
  const pinnedSection = document.getElementById("pinnedSection");

  // Update search count
  if (searchQuery) {
    searchCountEl.textContent = filtered.length + ' of ' + latestSessions.length;
  } else {
    searchCountEl.textContent = '';
  }

  // Banner — more urgent (always based on ALL sessions, not filtered)
  const allGroups = { attention: [] };
  for (const s of latestSessions) { if (groupFor(s) === 'attention') allGroups.attention.push(s); }
  const needsMe = allGroups.attention.length;
  if (needsMe > 0) {
    banner.classList.remove("hidden");
    document.getElementById("bannerCount").textContent = needsMe;
    document.title = "\\u26a0\\ufe0f (" + needsMe + ") NEEDS INPUT — Copilot Sessions";
    if (!notifiedWaiting && Notification.permission === "granted") {
      new Notification("\\u26a0\\ufe0f Copilot needs your input!", {
        body: needsMe + " session(s) are BLOCKED waiting for you",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚨</text></svg>",
        requireInteraction: true,
      });
    }
    notifiedWaiting = needsMe > 0;
  } else {
    banner.classList.add("hidden");
    const completedAll = latestSessions.filter(s => groupFor(s) === 'completed').length;
    document.title = completedAll > 0
      ? "\\u2705 (" + completedAll + ") Done — Copilot Sessions"
      : "Copilot Sessions Monitor";
    notifiedWaiting = false;
  }

  // Pinned sessions
  const pinned = filtered.filter(s => pinnedSessions.has(s.id));
  if (pinned.length > 0) {
    let pinHtml = '<div class="group-header"><span class="group-icon">📌</span>'
      + '<span class="group-title">Pinned</span>'
      + '<span class="group-count">(' + pinned.length + ')</span></div>';
    for (const s of pinned) pinHtml += renderCard(s, groupFor(s));
    pinnedSection.innerHTML = pinHtml;
    pinnedSection.style.display = '';
  } else {
    pinnedSection.style.display = 'none';
    pinnedSection.innerHTML = '';
  }

  // Exclude pinned from main groups (they show in pinned section)
  const unpinned = filtered.filter(s => !pinnedSessions.has(s.id));

  if (filtered.length === 0) {
    content.innerHTML = searchQuery
      ? '<div class="empty"><div class="big">🔍</div>No sessions match &ldquo;' + esc(searchQuery) + '&rdquo;</div>'
      : '<div class="empty"><div class="big">📭</div>No sessions found</div>';
    return;
  }

  let html = "";

  if (groupByMode === 'repository' || groupByMode === 'branch') {
    // Group by repository or branch
    const groupMap = {};
    for (const s of unpinned) {
      let key;
      if (groupByMode === 'repository') {
        key = s.repository || s.cwd || 'No Repository';
      } else {
        key = s.branch || 'No Branch';
      }
      if (!groupMap[key]) groupMap[key] = [];
      groupMap[key].push(s);
    }
    // Sort groups alphabetically, sort sessions within by status priority
    const sortedKeys = Object.keys(groupMap).sort();
    for (const key of sortedKeys) {
      const items = groupMap[key].sort((a, b) => statusPriority(a) - statusPriority(b));
      const icon = groupByMode === 'repository' ? '📂' : '🌿';
      const shortKey = groupByMode === 'repository' ? key.replace(/\\\\/g, '/').split('/').slice(-2).join('/') : key;
      html += '<div class="group">'
        + '<div class="group-header"><span class="group-icon">' + icon + '</span>'
        + '<span class="group-title">' + esc(shortKey) + '</span>'
        + '<span class="group-count">(' + items.length + ')</span></div>';
      for (const s of items) html += renderCard(s, groupFor(s));
      html += '</div>';
    }
  } else {
    // Default: group by status
    const groups = { attention: [], unseen: [], working: [], completed: [], idle: [], inactive: [] };
    for (const s of unpinned) groups[groupFor(s)].push(s);

    if (groups.attention.length > 0) {
      html += '<div class="group group-attention">'
        + '<div class="group-header"><span class="group-icon">🔔</span>'
        + '<span class="group-title">Needs Your Attention</span>'
        + '<span class="group-count">(' + groups.attention.length + ')</span></div>';
      for (const s of groups.attention) html += renderCard(s, "attention");
      html += '</div>';
    }
    if (groups.unseen.length > 0) {
      html += '<div class="group group-unseen">'
        + '<div class="group-header"><span class="group-icon">👀</span>'
        + '<span class="group-title">Unseen Responses</span>'
        + '<span class="group-count">(' + groups.unseen.length + ')</span></div>';
      for (const s of groups.unseen) html += renderCard(s, "unseen");
      html += '</div>';
    }
    if (groups.working.length > 0) {
      html += '<div class="group group-working">'
        + '<div class="group-header"><span class="group-icon">⚡</span>'
        + '<span class="group-title">Actively Working</span>'
        + '<span class="group-count">(' + groups.working.length + ')</span></div>';
      for (const s of groups.working) html += renderCard(s, "working");
      html += '</div>';
    }
    if (groups.completed.length > 0) {
      html += '<div class="group group-completed">'
        + '<div class="group-header"><span class="group-icon">✅</span>'
        + '<span class="group-title">Task Complete</span>'
        + '<span class="group-count">(' + groups.completed.length + ')</span></div>';
      for (const s of groups.completed) html += renderCard(s, "completed");
      html += '</div>';
    }
    if (groups.idle.length > 0) {
      html += '<div class="group group-idle">'
        + '<div class="group-header"><span class="group-icon">💤</span>'
        + '<span class="group-title">Idle</span>'
        + '<span class="group-count">(' + groups.idle.length + ')</span></div>';
      for (const s of groups.idle) html += renderCard(s, "idle");
      html += '</div>';
    }
    if (groups.inactive.length > 0) {
      html += '<div class="group group-inactive">'
        + '<div class="group-header"><span class="group-icon">📁</span>'
        + '<span class="group-title">Past Sessions</span>'
        + '<span class="group-count">(' + groups.inactive.length + ')</span></div>';
      for (const s of groups.inactive) html += renderCard(s, "inactive");
      html += '</div>';
    }
  }

  content.innerHTML = html;
  attachNoteListeners();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// Request notification permission
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

// --- Search ---
const searchInput = document.getElementById("searchInput");
const searchClear = document.getElementById("searchClear");

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim();
  searchClear.classList.toggle("hidden", !searchQuery);
  displaySessions();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchQuery = "";
  searchClear.classList.add("hidden");
  displaySessions();
  searchInput.focus();
});

// Ctrl+K / Cmd+K to focus search
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === "Escape" && document.activeElement === searchInput) {
    searchInput.value = "";
    searchQuery = "";
    searchClear.classList.add("hidden");
    displaySessions();
    searchInput.blur();
  }
});

// --- Repo opener ---
const repoSelect = document.getElementById("repoSelect");
const repoOpenBtn = document.getElementById("repoOpenBtn");

function loadRepos() {
  fetch("/api/repos").then(r => r.json()).then(repos => {
    let html = '<option value="">— Select a repo / worktree —</option>';
    for (const repo of repos) {
      // Repo itself is always selectable (opens main repo path)
      html += '<option value="' + esc(repo.path) + '" class="repo-parent">📁 ' + esc(repo.name) + '</option>';
      // Worktrees listed hierarchically beneath — use folder name, not branch
      if (repo.worktrees.length > 1) {
        for (const wt of repo.worktrees) {
          const folderName = wt.path.split(/[\\\\/]/).pop();
          const isMain = wt.path === repo.path;
          if (isMain) continue; // skip the main repo — already listed above
          html += '<option value="' + esc(wt.path) + '" class="worktree-child">'
            + '    └─ ' + esc(folderName) + '</option>';
        }
      }
    }
    repoSelect.innerHTML = html;
    repoOpenBtn.disabled = true;
  });
}

repoSelect.addEventListener("change", () => {
  repoOpenBtn.disabled = !repoSelect.value;
});

const editorSelect = document.getElementById("editorSelect");
repoOpenBtn.addEventListener("click", () => {
  const path = repoSelect.value;
  if (!path) return;
  const editor = editorSelect.value;
  repoOpenBtn.textContent = "Opening…";
  repoOpenBtn.disabled = true;
  fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, editor }),
  }).then(() => {
    repoOpenBtn.textContent = "✓ Opened";
    setTimeout(() => { repoOpenBtn.textContent = "Open"; repoOpenBtn.disabled = false; }, 2000);
  }).catch(() => {
    repoOpenBtn.textContent = "Failed";
    setTimeout(() => { repoOpenBtn.textContent = "Open"; repoOpenBtn.disabled = false; }, 2000);
  });
});

loadRepos();
// Refresh repo list every 30s
setInterval(loadRepos, 30000);

// SSE for live updates
const es = new EventSource("/api/stream");
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };

// Initial load
fetch("/api/sessions").then(r => r.json()).then(render);
</script>
</body>
</html>`;
}

// --- Todos backend ---
function uuid() {
    return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

let _todosCache = null;
let _todosCacheTime = 0;
const TODOS_CACHE_TTL_MS = 5000;

function loadTodos() {
    const now = Date.now();
    if (_todosCache && (now - _todosCacheTime) < TODOS_CACHE_TTL_MS) return _todosCache;
    try {
        if (existsSync(TODOS_FILE)) {
            const data = JSON.parse(readFileSync(TODOS_FILE, "utf-8"));
            if (data && Array.isArray(data.categories)) {
                _todosCache = data;
                _todosCacheTime = now;
                return data;
            }
        }
    } catch {}
    _todosCache = { version: 1, categories: [] };
    _todosCacheTime = now;
    return _todosCache;
}

function saveTodos(data) {
    try {
        const tmp = TODOS_FILE + ".tmp";
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, TODOS_FILE);
        _todosCache = data;
        _todosCacheTime = Date.now();
        return true;
    } catch { return false; }
}

function slugify(s) {
    if (!s) return "todo-" + Date.now().toString(36);
    return String(s).toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "todo-" + Date.now().toString(36);
}

function findTodo(data, todoId, subtodoId) {
    for (const cat of data.categories) {
        for (const t of (cat.todos || [])) {
            if (t.id === todoId) {
                if (!subtodoId) return { category: cat, todo: t, sub: null };
                const sub = (t.subtodos || []).find(x => x.id === subtodoId);
                if (sub) return { category: cat, todo: t, sub };
                return null;
            }
        }
    }
    return null;
}

async function callCopilotChatOnce(systemPrompt, userPrompt, { json, maxTokens, model }) {
    const token = await new Promise((resolve, reject) => {
        exec("gh auth token", { timeout: 5000 }, (err, stdout) => {
            if (err) reject(err); else resolve(stdout.trim());
        });
    });
    const payload = JSON.stringify({
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
        ...(json ? { response_format: { type: "json_object" } } : {}),
    });
    return await new Promise((resolve) => {
        const url = new URL("https://api.githubcopilot.com/chat/completions");
        const req = httpsRequest({
            hostname: url.hostname,
            path: url.pathname,
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "Editor-Version": "copilot-cli/1.0",
                "Copilot-Integration-Id": "copilot-cli",
                "Content-Length": Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = "";
            res.on("data", c => body += c);
            res.on("end", () => {
                const status = res.statusCode || 0;
                if (status < 200 || status >= 300) {
                    resolve({ error: `HTTP ${status} from ${model}: ${body.slice(0, 400).replace(/\s+/g, " ").trim()}`, status });
                    return;
                }
                try {
                    const data = JSON.parse(body);
                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        const finish = data.choices[0].finish_reason || "";
                        resolve({ content: data.choices[0].message.content, model, finishReason: finish, truncated: finish === "length" });
                    } else {
                        resolve({ error: `Unexpected response from ${model}: ${body.slice(0, 400)}`, status });
                    }
                } catch (e) { resolve({ error: `Parse error (${model}): ${body.slice(0, 400)}`, status }); }
            });
        });
        req.on("error", e => resolve({ error: `Network error (${model}): ${e.message}` }));
        req.setTimeout(180000, () => { req.destroy(); resolve({ error: `Request timeout (${model})` }); });
        req.write(payload); req.end();
    });
}

async function callCopilotChat(systemPrompt, userPrompt, { json = false, maxTokens = 2000, model = "gpt-4.1" } = {}) {
    // Try requested model; on failure, try a sensible fallback chain.
    // Models verified accessible: gpt-4.1, gpt-4o-mini, claude-haiku-4.5, claude-sonnet-4.6.
    const fallbacks = [model];
    for (const m of ["gpt-4o-mini", "claude-haiku-4.5", "claude-sonnet-4.6"]) if (!fallbacks.includes(m)) fallbacks.push(m);

    let lastErr = null;
    for (const m of fallbacks) {
        const result = await callCopilotChatOnce(systemPrompt, userPrompt, { json, maxTokens, model: m });
        if (result.content) {
            if (m !== model) result.fallbackUsed = m;
            return result;
        }
        lastErr = result;
        const eligible = [400, 403, 404, 408, 429, 500, 502, 503, 504];
        // Fall back on auth/policy/availability/bad-request/timeout failures.
        // result.status is undefined for network errors and our own timeout — those should also fall back.
        const shouldFallback = !result.status || eligible.includes(result.status);
        if (!shouldFallback) break;
    }
    return lastErr || { error: "Unknown error" };
}

async function parseTodosWithAI(rawText, existingCategories) {
    const repos = scanRepos().map(r => r.path);
    const reposHint = repos.slice(0, 50).map(p => "  - " + p).join("\n");
    const catNames = (existingCategories || []).map(c => c.name).filter(Boolean);
    const catHint = catNames.length ? `Existing category names (reuse when applicable): ${catNames.join(", ")}` : "No existing categories yet.";

    const systemPrompt = [
        "You organize free-form developer todo notes into a structured JSON plan.",
        "Output STRICT JSON only (no markdown). Schema:",
        '{ "categories": [ { "name": string, "todos": [ { "title": string, "context": string, "repo": string|null, "branchSuffix": string|null, "subtodos": [ { "title": string, "context": string, "branchSuffix": string|null } ] } ] } ] }',
        "Rules:",
        "- Group related todos under sensible category names (e.g., 'Dashboard', 'Refactoring', 'Bugs', or repo-specific names).",
        "- Reuse existing category names verbatim where applicable.",
        "- 'repo' is an absolute path; if you can confidently infer it from the user's text or the known repo list, set it. Otherwise null.",
        "- 'branchSuffix' is a short kebab-case slug (no leading user/) describing the work; it will be prefixed with '" + USER_ALIAS + "/' automatically. Use null if unclear.",
        "- 'context' captures additional details, acceptance criteria, or constraints from the user's text. Keep concise but include important specifics.",
        "- Split work into subtodos ONLY when it is clearly multi-step from the user's text.",
        "- Never invent work the user didn't mention.",
    ].join("\n");

    // Chunk large inputs: start with conservative ~3500 chars per chunk so output stays well under cap.
    const INITIAL_CHUNK_BUDGET = 3500;
    const MIN_CHUNK_BUDGET = 500;
    const initialChunks = chunkTextForLLM(rawText, INITIAL_CHUNK_BUDGET);
    const partResults = [];
    let modelUsed = null, fallbackUsed = null, anyTruncated = false;
    let totalChunks = 0;

    // Process queue (allows recursive subdivision on truncation)
    const queue = initialChunks.map((c, i) => ({ text: c, label: `${i + 1}` }));
    while (queue.length > 0) {
        const chunk = queue.shift();
        totalChunks++;
        const userPrompt = [
            catHint,
            "",
            "Known repositories on disk:",
            reposHint || "  (none discovered)",
            "",
            queue.length > 0 || totalChunks > 1
                ? `User notes (chunk ${chunk.label} — group similar items across chunks under the same category names):`
                : "User notes:",
            "---",
            chunk.text,
            "---",
            "Return JSON only.",
        ].join("\n");

        const result = await callCopilotChat(systemPrompt, userPrompt, { json: true, maxTokens: 16000 });
        if (result.error) return { error: `Chunk ${chunk.label} failed: ${result.error}` };
        modelUsed = modelUsed || result.model;
        fallbackUsed = fallbackUsed || result.fallbackUsed || null;

        // If the response was truncated AND the chunk is splittable, subdivide and retry both halves.
        if (result.truncated && chunk.text.length > MIN_CHUNK_BUDGET) {
            const half = Math.floor(chunk.text.length / 2);
            // Split at a line boundary near the midpoint
            let splitAt = chunk.text.lastIndexOf("\n", half);
            if (splitAt < MIN_CHUNK_BUDGET) splitAt = half;
            queue.unshift(
                { text: chunk.text.slice(0, splitAt), label: `${chunk.label}a` },
                { text: chunk.text.slice(splitAt).replace(/^\n/, ""), label: `${chunk.label}b` },
            );
            continue;
        }

        if (result.truncated) anyTruncated = true;

        const parsed = parseModelJson(result.content || "");
        if (!parsed) {
            // Last-ditch: subdivide if possible
            if (chunk.text.length > MIN_CHUNK_BUDGET) {
                const half = Math.floor(chunk.text.length / 2);
                let splitAt = chunk.text.lastIndexOf("\n", half);
                if (splitAt < MIN_CHUNK_BUDGET) splitAt = half;
                queue.unshift(
                    { text: chunk.text.slice(0, splitAt), label: `${chunk.label}a` },
                    { text: chunk.text.slice(splitAt).replace(/^\n/, ""), label: `${chunk.label}b` },
                );
                continue;
            }
            return { error: `Could not parse JSON from chunk ${chunk.label}. First 300 chars: ${(result.content || "").slice(0, 300)}` };
        }
        partResults.push(parsed);
    }

    // Merge categories across chunks by name (case-insensitive).
    const mergedByName = new Map();
    for (const part of partResults) {
        for (const c of (part.categories || [])) {
            const key = String(c.name || "Uncategorized").toLowerCase();
            if (!mergedByName.has(key)) mergedByName.set(key, { name: c.name || "Uncategorized", todos: [] });
            const bucket = mergedByName.get(key);
            for (const t of (c.todos || [])) bucket.todos.push(t);
        }
    }
    const merged = { categories: [...mergedByName.values()] };

    const nowIso = new Date().toISOString();
    const cats = (merged.categories || []).map(c => ({
        id: uuid(),
        name: String(c.name || "Uncategorized").slice(0, 80),
        todos: (c.todos || []).map(t => ({
            id: uuid(),
            title: String(t.title || "Untitled").slice(0, 200),
            context: String(t.context || ""),
            repo: t.repo || "",
            branchSuffix: t.branchSuffix || "",
            status: "pending",
            createdAt: nowIso,
            updatedAt: nowIso,
            subtodos: (t.subtodos || []).map(s => ({
                id: uuid(),
                title: String(s.title || "Untitled").slice(0, 200),
                context: String(s.context || ""),
                branchSuffix: s.branchSuffix || "",
                status: "pending",
            })),
        })),
    }));
    return { categories: cats, model: modelUsed, fallbackUsed, truncated: anyTruncated, chunks: totalChunks };
}

function chunkTextForLLM(text, charBudget) {
    if (!text) return [""];
    if (text.length <= charBudget) return [text];
    const lines = text.split(/\r?\n/);
    const chunks = [];
    let current = "";
    for (const line of lines) {
        if (current.length + line.length + 1 > charBudget && current.length > 0) {
            chunks.push(current);
            current = "";
        }
        current += (current ? "\n" : "") + line;
        // Hard split for a single huge line
        while (current.length > charBudget) {
            chunks.push(current.slice(0, charBudget));
            current = current.slice(charBudget);
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function parseModelJson(raw) {
    if (!raw) return null;
    let parsed = tryParseJson(raw);
    if (parsed) return parsed;
    const stripped = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = tryParseJson(stripped);
    if (parsed) return parsed;
    const repaired = repairTruncatedJson(raw);
    if (repaired) parsed = tryParseJson(repaired);
    return parsed;
}

function tryParseJson(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
    }

function repairTruncatedJson(text) {
    if (!text) return null;
    const start = text.indexOf("{");
    if (start < 0) return null;
    const s = text.slice(start);
    // Walk and track positions where the parser is "between elements" at each depth.
    // safeEnd = position (exclusive) where everything up to that index is a valid prefix
    // that can be closed by appending close-brackets. This is right after any complete value.
    const stack = []; // entries: { open: '{'|'[' }
    let inStr = false, escape = false;
    let safeEnd = -1;
    let expectingValue = true; // true at start, after '[', after ':', after ','
    let i = 0;
    for (; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (escape) { escape = false; continue; }
            if (ch === "\\") { escape = true; continue; }
            if (ch === '"') {
                inStr = false;
                // String just closed. If we were expecting a value (i.e., it's a value not a key),
                // mark this as a safe end. Inside an object, strings can be either keys or values.
                // We approximate: if the parent is '[', it's a value; if '{', we need the next non-ws char
                // to disambiguate. We'll set safeEnd later when we see ',' or close.
            }
            continue;
        }
        if (/\s/.test(ch)) continue;
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") { stack.push({ open: "{" }); expectingValue = false; continue; }
        if (ch === "[") { stack.push({ open: "[" }); expectingValue = true; continue; }
        if (ch === "}" || ch === "]") {
            stack.pop();
            // After closing, we're after a value at the parent level
            safeEnd = i + 1;
            if (stack.length === 0) {
                // Top-level closed cleanly
                return s.slice(0, i + 1);
            }
            continue;
        }
        if (ch === ",") {
            // Just finished a value; safe to truncate up to and INCLUDING the previous value
            // (i.e., position of the comma). Backing up to before the comma drops the next pending element.
            safeEnd = i; // exclusive: keep up to but not including the comma
            expectingValue = true;
            continue;
        }
        if (ch === ":") {
            expectingValue = true;
            continue;
        }
        // Literal value (number/true/false/null) — find its end
        if (/[-0-9tfn]/.test(ch)) {
            let j = i + 1;
            while (j < s.length && /[-+0-9.eEtruefalsn]/.test(s[j])) j++;
            i = j - 1;
            // Value just ended; will become safe at the next ',' or close
            continue;
        }
    }
    // Reached end of string (truncated). Use safeEnd to back up to a clean cut point.
    let out;
    if (safeEnd > 0) {
        out = s.slice(0, safeEnd);
    } else {
        // Couldn't find any safe truncation point — give up
        return null;
    }
    // Strip trailing whitespace and trailing commas
    out = out.replace(/[\s,]+$/, "");
    // Close any remaining open structures (in reverse stack order — but we need to recompute
    // the stack on the truncated buffer since safeEnd may have undone some opens)
    const finalStack = [];
    let inS = false, esc = false;
    for (let k = 0; k < out.length; k++) {
        const c = out[k];
        if (inS) {
            if (esc) { esc = false; continue; }
            if (c === "\\") { esc = true; continue; }
            if (c === '"') inS = false;
            continue;
        }
        if (c === '"') inS = true;
        else if (c === "{" || c === "[") finalStack.push(c);
        else if (c === "}" && finalStack[finalStack.length - 1] === "{") finalStack.pop();
        else if (c === "]" && finalStack[finalStack.length - 1] === "[") finalStack.pop();
    }
    while (finalStack.length) {
        const open = finalStack.pop();
        out += open === "{" ? "}" : "]";
    }
    return out;
}

function execAsync(cmd, opts = {}) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err ? (err.code ?? 1) : 0,
                stdout: String(stdout || ""),
                stderr: String(stderr || ""),
                killed: err ? !!err.killed : false,
                signal: err ? (err.signal || null) : null,
            });
        });
    });
}

async function detectDefaultBranch(repo) {
    let r = await execAsync(`git -C "${repo}" symbolic-ref --short refs/remotes/origin/HEAD`);
    if (r.ok) {
        const out = r.stdout.trim();
        const m = out.match(/^origin\/(.+)$/);
        if (m) return m[1];
    }
    // Try setting it from remote
    r = await execAsync(`git -C "${repo}" remote set-head origin --auto`);
    r = await execAsync(`git -C "${repo}" symbolic-ref --short refs/remotes/origin/HEAD`);
    if (r.ok) {
        const m = r.stdout.trim().match(/^origin\/(.+)$/);
        if (m) return m[1];
    }
    // Fallback: try main then master
    for (const cand of ["main", "master"]) {
        const c = await execAsync(`git -C "${repo}" rev-parse --verify origin/${cand}`);
        if (c.ok) return cand;
    }
    return "main";
}

async function launchTodoWorktree({ repo, branchSlug, tabTitle, todoMdPath, todoMdContent }) {
    if (!repo || !existsSync(repo)) return { error: "Repo path does not exist: " + repo };
    const gitDir = join(repo, ".git");
    if (!existsSync(gitDir)) return { error: "Not a git repo: " + repo };

    const branch = `${USER_ALIAS}/${branchSlug}`;
    const defaultBranch = await detectDefaultBranch(repo);

    // Prune stale worktree registrations up front, then check if this branch
    // is already attached to a live worktree (e.g., a prior attempt that
    // succeeded but was killed mid-checkout before launching the terminal).
    await execAsync(`git -C "${repo}" worktree prune`, { timeout: 30000 });
    let existingWtPath = null;
    {
        const list = await execAsync(`git -C "${repo}" worktree list --porcelain`, { timeout: 30000 });
        if (list.ok) {
            // Walk line-by-line; each "worktree <path>" begins a record and
            // "branch refs/heads/<name>" inside that record identifies its branch.
            // Don't depend on blank-line separation between records.
            const lines = list.stdout.split(/\r?\n/);
            let curPath = null;
            for (const line of lines) {
                const pm = line.match(/^worktree (.+)$/);
                if (pm) { curPath = pm[1]; continue; }
                const bm = line.match(/^branch refs\/heads\/(.+)$/);
                if (bm && bm[1] === branch && curPath) { existingWtPath = curPath; break; }
            }
        }
    }

    // Pick a worktree path: sibling to repo, "<repoName>--<slug>"
    const repoName = basename(repo);
    const parent = join(repo, "..");
    let wtPath;
    if (existingWtPath && existsSync(existingWtPath)) {
        wtPath = existingWtPath;
    } else {
        wtPath = join(parent, `${repoName}--${branchSlug}`);
        let n = 2;
        while (existsSync(wtPath)) { wtPath = join(parent, `${repoName}--${branchSlug}-${n}`); n++; }
    }

    const steps = [];
    const run = async (cmd, opts) => {
        const r = await execAsync(cmd, opts);
        const step = { cmd, ok: r.ok, stderr: r.stderr.slice(0, 2000) };
        if (r.killed) step.killed = true;
        if (r.signal) step.signal = r.signal;
        steps.push(step);
        return r;
    };

    // Long-running git ops on large repos (e.g., 45k+ file checkouts) need
    // generous timeout + buffer. exec() with timeout: 0 disables the timer.
    const longGit = { timeout: 0, maxBuffer: 50 * 1024 * 1024 };

    // Fetch latest (large repos can take >30s)
    await run(`git -C "${repo}" fetch origin --prune`, { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

    if (existingWtPath) {
        steps.push({ cmd: `reuse existing worktree at ${existingWtPath}`, ok: true, stderr: "" });
    } else {
        // Check if branch already exists locally or remotely
        const localExists = (await execAsync(`git -C "${repo}" rev-parse --verify "refs/heads/${branch}"`)).ok;
        const remoteExists = (await execAsync(`git -C "${repo}" rev-parse --verify "refs/remotes/origin/${branch}"`)).ok;

        let wtRes;
        if (localExists) {
            wtRes = await run(`git -C "${repo}" worktree add "${wtPath}" "${branch}"`, longGit);
        } else if (remoteExists) {
            wtRes = await run(`git -C "${repo}" worktree add --track -b "${branch}" "${wtPath}" "origin/${branch}"`, longGit);
        } else {
            wtRes = await run(`git -C "${repo}" worktree add -b "${branch}" "${wtPath}" "origin/${defaultBranch}"`, longGit);
        }
        if (!wtRes.ok) {
            // Clean up partial worktree so the next attempt doesn't trip on
            // "path already exists" or a corrupt registration in .git/worktrees.
            try { await execAsync(`git -C "${repo}" worktree remove --force "${wtPath}"`, { timeout: 60000 }); } catch {}
            if (existsSync(wtPath)) {
                try { rmSync(wtPath, { recursive: true, force: true, maxRetries: 3 }); } catch {}
            }
            try { await execAsync(`git -C "${repo}" worktree prune`, { timeout: 30000 }); } catch {}
            return { error: "git worktree add failed", steps };
        }
    }

    // Write the context file
    try {
        writeFileSync(join(wtPath, todoMdPath), todoMdContent);
    } catch (e) {
        steps.push({ cmd: "write " + todoMdPath, ok: false, stderr: String(e.message || e) });
    }

    // Launch Windows Terminal tab
    const title = (tabTitle || `Todo: ${branchSlug}`).replace(/"/g, "'");
    const wtCmd = `wt -w 0 new-tab --title "${title}" -d "${wtPath}" cmd /k "${COPILOT_CMD}"`;
    exec(wtCmd, () => {});
    steps.push({ cmd: wtCmd, ok: true, stderr: "" });

    return { ok: true, worktreePath: wtPath, branch, defaultBranch, steps };
}

// --- Analytics HTML page ---
function analyticsHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Analytics — Copilot</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3;
          --dim: #8b949e; --green: #3fb950; --blue: #58a6ff; --purple: #bc8cff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text);
         min-height: 100vh; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .back { color: var(--blue); text-decoration: none; font-size: 13px; }
  .back:hover { text-decoration: underline; }
  .stats-cards { display: flex; gap: 16px; margin: 20px 0; flex-wrap: wrap; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
               padding: 16px 24px; min-width: 150px; }
  .stat-card .val { font-size: 28px; font-weight: 700; color: var(--blue); }
  .stat-card .lbl { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .chart-section { margin: 24px 0; }
  .chart-section h2 { font-size: 16px; margin-bottom: 12px; color: var(--dim); }
  .bar-chart { display: flex; align-items: flex-end; gap: 6px; height: 240px;
               border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  .bar-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; justify-content: flex-end; }
  .bar-col .bar { background: var(--blue); border-radius: 3px 3px 0 0; width: 100%;
                  min-height: 2px; transition: height 0.3s; }
  .bar-col .bar-label { font-size: 10px; color: var(--dim); margin-top: 4px; writing-mode: vertical-rl;
                        text-orientation: mixed; height: 50px; flex: 0 0 50px;
                        display: flex; align-items: flex-start; justify-content: center; }
  .bar-col .bar-val { font-size: 10px; color: var(--text); margin-bottom: 2px; }
  .h-bar { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .h-bar .h-bar-label { font-size: 12px; color: var(--dim); min-width: 200px;
                        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  .h-bar .h-bar-fill { background: var(--purple); height: 18px; border-radius: 4px;
                       min-width: 4px; transition: width 0.3s; }
  .h-bar .h-bar-val { font-size: 11px; color: var(--text); min-width: 30px; }
</style>
</head>
<body>
<a href="/" class="back">← Back to Dashboard</a>
<h1>📊 Session Analytics</h1>
<div id="analytics">Loading…</div>
<script>
fetch('/api/analytics-data').then(r => r.json()).then(data => {
  let html = '';
  // Summary cards
  html += '<div class="stats-cards">';
  html += '<div class="stat-card"><div class="val">' + data.totalSessions + '</div><div class="lbl">Total Sessions</div></div>';
  html += '<div class="stat-card"><div class="val">' + data.totalTurns + '</div><div class="lbl">Total Turns</div></div>';
  html += '<div class="stat-card"><div class="val">' + data.totalTools + '</div><div class="lbl">Total Tool Calls</div></div>';
  html += '<div class="stat-card"><div class="val">' + data.avgDuration + 'm</div><div class="lbl">Avg Duration</div></div>';
  html += '</div>';

  // Sessions per day chart
  const days = Object.entries(data.perDay);
  const maxDay = Math.max(...days.map(d => d[1]), 1);
  // Reserve vertical space for the longest (vertically-rotated) label so every bar shares a baseline.
  const labels = days.map(d => d[0].slice(5));
  const maxLabelChars = Math.max(...labels.map(l => l.length), 1);
  const labelPx = Math.max(50, maxLabelChars * 7 + 8);
  html += '<div class="chart-section"><h2>Sessions per Day (Last 14 Days)</h2>';
  html += '<div class="bar-chart">';
  for (const [date, count] of days) {
    const pct = Math.round((count / maxDay) * 160);
    const label = date.slice(5);
    html += '<div class="bar-col"><span class="bar-val">' + count + '</span>'
      + '<div class="bar" style="height:' + pct + 'px"></div>'
      + '<span class="bar-label" style="height:' + labelPx + 'px;flex:0 0 ' + labelPx + 'px">' + label + '</span></div>';
  }
  html += '</div></div>';

  // Top repos chart
  if (data.topRepos.length > 0) {
    const maxRepo = data.topRepos[0][1] || 1;
    html += '<div class="chart-section"><h2>Top Repositories</h2>';
    for (const [repo, count] of data.topRepos) {
      const pct = Math.round((count / maxRepo) * 300);
      const short = repo.replace(/\\\\/g, '/').split('/').slice(-2).join('/');
      html += '<div class="h-bar"><span class="h-bar-label" title="' + repo.replace(/"/g,'&quot;') + '">' + short + '</span>'
        + '<div class="h-bar-fill" style="width:' + pct + 'px"></div>'
        + '<span class="h-bar-val">' + count + '</span></div>';
    }
    html += '</div>';
  }

  document.getElementById('analytics').innerHTML = html;
});
<\/script>
</body></html>`;
}

// --- Todos HTML page ---
function todosHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Todos — Copilot</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3;
          --dim: #8b949e; --green: #3fb950; --blue: #58a6ff; --purple: #bc8cff;
          --yellow: #d29922; --red: #f85149; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text);
         min-height: 100vh; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .back { color: var(--blue); text-decoration: none; font-size: 13px; }
  .back:hover { text-decoration: underline; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  textarea, input[type="text"], select { background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: inherit;
    font-size: 13px; }
  textarea { width: 100%; resize: vertical; }
  button { background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
    transition: all 0.15s; font-family: inherit; }
  button:hover { border-color: var(--blue); color: var(--blue); }
  button.primary { background: var(--blue); color: #fff; border-color: var(--blue); }
  button.primary:hover { background: #4593e6; }
  button.danger { color: var(--red); border-color: var(--red); }
  button.danger:hover { background: rgba(248,81,73,0.1); }
  button.success { color: var(--green); border-color: var(--green); }
  button.launch { color: var(--purple); border-color: var(--purple); font-weight: 600; }
  button.launch:hover { background: rgba(188,140,255,0.15); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; margin: 16px 0; }
  .panel h2 { font-size: 15px; margin-bottom: 10px; color: var(--dim); }
  .category { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    margin: 12px 0; overflow: hidden; }
  .cat-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    background: rgba(88,166,255,0.06); border-bottom: 1px solid var(--border); }
  .cat-header .cat-name { font-weight: 700; font-size: 14px; flex: 1; }
  .cat-header .cat-name input { background: transparent; border: none; color: var(--text);
    font-weight: 700; font-size: 14px; width: 100%; padding: 2px 4px; }
  .cat-header .cat-name input:focus { outline: 1px solid var(--blue); border-radius: 4px; }
  .cat-count { color: var(--dim); font-size: 12px; }
  .todo-list { padding: 4px 8px 8px; }
  .todo { border: 1px solid var(--border); border-radius: 8px; margin: 6px 0;
    background: var(--bg); transition: border-color 0.15s; }
  .todo.expanded { border-color: var(--blue); }
  .todo.status-done { opacity: 0.6; }
  .todo.status-done .todo-title { text-decoration: line-through; }
  .todo-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
  .todo-row:hover { background: rgba(88,166,255,0.06); }
  .todo-status { font-size: 16px; cursor: pointer; user-select: none; }
  .todo-title { flex: 1; font-size: 13px; }
  .todo-title-edit { flex: 1; }
  .todo-title-edit input { width: 100%; font-size: 13px; }
  .todo-meta { font-size: 11px; color: var(--dim); }
  .todo-actions { display: flex; gap: 4px; }
  .todo-actions button { padding: 3px 8px; font-size: 11px; }
  .todo-detail { padding: 8px 14px 12px; border-top: 1px solid var(--border);
    display: none; flex-direction: column; gap: 8px; }
  .todo.expanded .todo-detail { display: flex; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: var(--dim); }
  .field input, .field select, .field textarea { font-size: 13px; }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  .branch-preview { font-family: monospace; font-size: 11px; color: var(--purple); margin-top: 2px; }
  .subtodos { margin-left: 20px; border-left: 2px solid var(--border); padding: 4px 0 4px 12px; }
  /* Drag and drop */
  .drag-handle { cursor: grab; color: var(--dim); font-size: 14px; user-select: none;
    padding: 0 4px; line-height: 1; }
  .drag-handle:hover { color: var(--blue); }
  .drag-handle:active { cursor: grabbing; }
  .dragging { opacity: 0.4; }
  .drop-before { box-shadow: 0 -3px 0 0 var(--blue) inset, 0 -3px 0 0 var(--blue); position: relative; }
  .drop-before::before { content: ''; position: absolute; left: 0; right: 0; top: -2px; height: 3px; background: var(--blue); border-radius: 2px; z-index: 10; }
  .drop-after { position: relative; }
  .drop-after::after { content: ''; position: absolute; left: 0; right: 0; bottom: -2px; height: 3px; background: var(--blue); border-radius: 2px; z-index: 10; }
  .drop-into { outline: 2px dashed var(--blue); outline-offset: -2px; }
  /* New-from-AI highlight */
  .category.new-from-ai { box-shadow: 0 0 0 2px var(--purple); animation: ai-pulse 1.5s ease-out 1; }
  .todo.new-from-ai { box-shadow: 0 0 0 2px var(--purple); background: rgba(188,140,255,0.07); }
  @keyframes ai-pulse { 0% { box-shadow: 0 0 0 4px rgba(188,140,255,0.6); } 100% { box-shadow: 0 0 0 2px var(--purple); } }
  .merge-banner { position: sticky; top: 0; z-index: 50; margin: 12px 0; }
  .merge-banner-inner { background: rgba(188,140,255,0.12); border: 1px solid var(--purple); border-radius: 10px;
    padding: 10px 14px; display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .merge-banner-inner span { flex: 1; }
  .merge-banner-inner strong { color: var(--purple); }
  .subtodo { background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 6px;
    margin: 4px 0; }
  .preview-cat { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; margin: 4px 0; }
  .preview-cat-name { font-weight: 700; font-size: 13px; color: var(--blue); margin-bottom: 4px; }
  .preview-todo { font-size: 12px; padding: 4px 0; border-top: 1px dashed var(--border); }
  .preview-todo:first-of-type { border-top: none; }
  .preview-sub { font-size: 11px; color: var(--dim); margin-left: 16px; }
  .toast { position: fixed; top: 20px; right: 20px; background: var(--card);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4); font-size: 13px; z-index: 9999;
    max-width: 480px; }
  .toast.success { border-color: var(--green); }
  .toast.error { border-color: var(--red); }
  .toast.info { border-color: var(--blue); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--dim);
    border-top-color: var(--blue); border-radius: 50%; animation: spin 0.8s linear infinite;
    vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--dim); font-style: italic; padding: 16px; text-align: center; }
  .header-actions { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
  .header-actions .grow { flex: 1; }
  .hint { color: var(--dim); font-size: 11px; }
</style>
</head>
<body>
<a href="/" class="back">← Back to Dashboard</a>
<h1>📝 Todos</h1>
<div class="hint">Free-form notes → AI-organized, persisted todo list. Click a todo's 🚀 to spin up a worktree + Copilot session.</div>

<div class="panel">
  <h2>1. Drop in free-form notes</h2>
  <textarea id="rawNotes" rows="6" placeholder="e.g. Fix the bar chart alignment in session dashboard. Add a button to copy session IDs. In the ghcp-cli repo, refactor the prompt loader to use async/await..."></textarea>
  <div class="header-actions" style="margin-top:8px;">
    <button id="parseBtn" class="primary">✨ Parse with AI</button>
    <span id="parseStatus" class="hint"></span>
  </div>
  <div id="preview"></div>
</div>

<div class="panel">
  <h2>2. Your todo list</h2>
  <div class="header-actions">
    <button id="addCatBtn">+ Category</button>
    <div class="grow"></div>
    <span id="dirtyIndicator" class="hint"></span>
    <button id="saveBtn" class="success">💾 Save All</button>
  </div>
  <div id="todoTree"></div>
</div>

<script>
const USER_ALIAS = ${JSON.stringify(USER_ALIAS)};
let state = { version: 1, categories: [] };
let repos = [];
let dirty = false;
const expanded = new Set();

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function toast(msg, type='info') {
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}
function markDirty() { dirty = true; document.getElementById('dirtyIndicator').textContent = '● unsaved changes'; }
function clearDirty() { dirty = false; document.getElementById('dirtyIndicator').textContent = ''; }

function uid() { return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10); }

async function load() {
  const [t, r] = await Promise.all([
    fetch('/api/todos').then(x => x.json()),
    fetch('/api/repos').then(x => x.json()).catch(() => []),
  ]);
  state = t && t.categories ? t : { version: 1, categories: [] };
  repos = r || [];
  render();
}

function repoOptions(selected) {
  let html = '<option value="">— (no repo)</option>';
  for (const r of repos) {
    html += '<option value="' + esc(r.path) + '"' + (r.path === selected ? ' selected' : '') + '>' + esc(r.name) + '</option>';
  }
  // Allow custom value not in the list
  if (selected && !repos.some(r => r.path === selected)) {
    html += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (custom)</option>';
  }
  return html;
}

function slugify(s) {
  return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
}

function branchFor(todo) {
  const slug = todo.branchSuffix || slugify(todo.title) || 'todo';
  return USER_ALIAS + '/' + slug;
}

function statusIcon(s) {
  if (s === 'done') return '✅';
  if (s === 'in_progress') return '🟡';
  return '⬜';
}

function cycleStatus(s) {
  if (s === 'pending' || !s) return 'in_progress';
  if (s === 'in_progress') return 'done';
  return 'pending';
}

function render() {
  const root = document.getElementById('todoTree');
  if (state.categories.length === 0) {
    root.innerHTML = '<div class="empty">No todos yet. Drop notes above and click "Parse with AI", or add a category manually.</div>';
    return;
  }
  let html = '';
  for (const cat of state.categories) {
    const newCat = newItemIds.has(cat.id) ? ' new-from-ai' : '';
    html += '<div class="category' + newCat + '" data-cat="' + cat.id + '" data-drop="category" data-drop-id="' + cat.id + '">';
    html += '<div class="cat-header">';
    html += '<span class="drag-handle" draggable="true" data-drag="category" data-drag-id="' + cat.id + '" title="Drag to reorder category">⋮⋮</span>';
    html += '<div class="cat-name"><input type="text" value="' + esc(cat.name) + '" data-cat-name="' + cat.id + '"></div>';
    html += '<span class="cat-count">' + (cat.todos||[]).length + ' todo' + ((cat.todos||[]).length === 1 ? '' : 's') + '</span>';
    html += '<button data-add-todo="' + cat.id + '">+ Todo</button>';
    html += '<button class="danger" data-del-cat="' + cat.id + '" title="Delete category">🗑</button>';
    html += '</div>';
    html += '<div class="todo-list" data-drop="todo-list" data-drop-id="' + cat.id + '">';
    for (const t of (cat.todos || [])) {
      html += renderTodo(t, cat.id, false);
    }
    html += '</div>';
    html += '</div>';
  }
  root.innerHTML = html;
  attachListeners();
  attachDnD();
}

function renderTodo(t, catId, isSub, parentTodoId) {
  const isExp = expanded.has(t.id);
  const isNew = newItemIds.has(t.id);
  const cls = 'todo status-' + (t.status||'pending') + (isExp ? ' expanded' : '') + (isSub ? ' subtodo' : '') + (isNew ? ' new-from-ai' : '');
  const dropType = isSub ? 'subtodo' : 'todo';
  let html = '<div class="' + cls + '" data-todo="' + t.id + '" data-cat="' + catId + '"'
    + ' data-drop="' + dropType + '" data-drop-id="' + t.id + '"'
    + (isSub ? ' data-parent-todo="' + parentTodoId + '"' : '')
    + '>';
  html += '<div class="todo-row" data-toggle="' + t.id + '">';
  html += '<span class="drag-handle" draggable="true" data-drag="' + dropType + '" data-drag-id="' + t.id + '"'
    + (isSub ? ' data-drag-parent="' + parentTodoId + '"' : '')
    + ' data-drag-cat="' + catId + '" title="Drag to reorder">⋮⋮</span>';
  html += '<span class="todo-status" data-status="' + t.id + '" title="Click to toggle">' + statusIcon(t.status) + '</span>';
  html += '<span class="todo-title">' + esc(t.title) + '</span>';
  if (!isSub) {
    const repoShort = t.repo ? t.repo.split(/[\\\\/]/).pop() : '';
    if (repoShort) html += '<span class="todo-meta">📁 ' + esc(repoShort) + '</span>';
    if ((t.subtodos||[]).length) html += '<span class="todo-meta">' + t.subtodos.length + ' sub</span>';
  }
  html += '<div class="todo-actions" onclick="event.stopPropagation()">';
  html += '<button class="launch" data-launch="' + t.id + '"' + (isSub ? ' data-sub="1"' : '') + ' title="Create worktree + open Copilot tab">🚀</button>';
  html += '<button class="danger" data-del="' + t.id + '"' + (isSub ? ' data-sub="1"' : '') + '>🗑</button>';
  html += '</div>';
  html += '</div>';
  // Detail panel
  html += '<div class="todo-detail">';
  html += '<div class="field"><label>Title</label><input type="text" value="' + esc(t.title) + '" data-field="title" data-id="' + t.id + '"></div>';
  if (!isSub) {
    html += '<div class="field-row">';
    html += '<div class="field"><label>Repo</label><select data-field="repo" data-id="' + t.id + '">' + repoOptions(t.repo) + '</select></div>';
    html += '<div class="field"><label>Branch suffix (final: ' + esc(USER_ALIAS) + '/&lt;suffix&gt;)</label><input type="text" value="' + esc(t.branchSuffix||'') + '" placeholder="' + esc(slugify(t.title)) + '" data-field="branchSuffix" data-id="' + t.id + '"></div>';
    html += '</div>';
    html += '<div class="branch-preview">Branch: ' + esc(branchFor(t)) + '</div>';
  } else {
    html += '<div class="field"><label>Branch suffix override (optional)</label><input type="text" value="' + esc(t.branchSuffix||'') + '" data-field="branchSuffix" data-id="' + t.id + '"></div>';
  }
  html += '<div class="field"><label>Context / Notes</label><textarea rows="4" data-field="context" data-id="' + t.id + '" placeholder="Acceptance criteria, links, constraints…">' + esc(t.context||'') + '</textarea></div>';
  html += '<div class="field"><label>Status</label><select data-field="status" data-id="' + t.id + '">';
  for (const opt of ['pending','in_progress','done']) {
    html += '<option value="' + opt + '"' + (t.status===opt?' selected':'') + '>' + opt + '</option>';
  }
  html += '</select></div>';
  // Subtodos
  if (!isSub) {
    html += '<div><label class="hint">Subtodos</label>';
    html += '<div class="subtodos" data-drop="subtodo-list" data-drop-id="' + t.id + '">';
    for (const st of (t.subtodos||[])) {
      html += renderTodo(st, catId, true, t.id);
    }
    html += '<button data-add-sub="' + t.id + '" style="margin-top:6px;">+ Subtodo</button>';
    html += '</div>';
    html += '</div>';
  }
  html += '</div>'; // detail
  html += '</div>'; // todo
  return html;
}

function findTodoLocal(id) {
  for (const cat of state.categories) {
    for (const t of (cat.todos||[])) {
      if (t.id === id) return { cat, todo: t, parent: null };
      for (const st of (t.subtodos||[])) {
        if (st.id === id) return { cat, todo: st, parent: t };
      }
    }
  }
  return null;
}

function attachListeners() {
  document.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.todo-actions') || e.target.closest('input') || e.target.closest('select') || e.target.closest('textarea')) return;
      const id = el.dataset.toggle;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
    });
  });
  document.querySelectorAll('[data-status]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const f = findTodoLocal(el.dataset.status); if (!f) return;
      f.todo.status = cycleStatus(f.todo.status);
      f.todo.updatedAt = new Date().toISOString();
      markDirty(); render();
    });
  });
  document.querySelectorAll('[data-cat-name]').forEach(el => {
    el.addEventListener('input', () => {
      const cat = state.categories.find(c => c.id === el.dataset.catName); if (!cat) return;
      cat.name = el.value; markDirty();
    });
  });
  document.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('input', () => {
      const f = findTodoLocal(el.dataset.id); if (!f) return;
      f.todo[el.dataset.field] = el.value;
      f.todo.updatedAt = new Date().toISOString();
      markDirty();
      // Update branch preview if relevant
      if (!f.parent && (el.dataset.field === 'branchSuffix' || el.dataset.field === 'title')) {
        const prev = el.closest('.todo-detail')?.querySelector('.branch-preview');
        if (prev) prev.textContent = 'Branch: ' + branchFor(f.todo);
      }
    });
  });
  document.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete this todo?')) return;
      const id = el.dataset.del;
      for (const cat of state.categories) {
        const idx = (cat.todos||[]).findIndex(t => t.id === id);
        if (idx >= 0) { cat.todos.splice(idx, 1); markDirty(); render(); return; }
        for (const t of (cat.todos||[])) {
          const si = (t.subtodos||[]).findIndex(s => s.id === id);
          if (si >= 0) { t.subtodos.splice(si, 1); markDirty(); render(); return; }
        }
      }
    });
  });
  document.querySelectorAll('[data-del-cat]').forEach(el => {
    el.addEventListener('click', () => {
      if (!confirm('Delete category and all its todos?')) return;
      state.categories = state.categories.filter(c => c.id !== el.dataset.delCat);
      markDirty(); render();
    });
  });
  document.querySelectorAll('[data-add-todo]').forEach(el => {
    el.addEventListener('click', () => {
      const cat = state.categories.find(c => c.id === el.dataset.addTodo); if (!cat) return;
      const t = { id: uid(), title: 'New todo', context: '', repo: '', branchSuffix: '', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), subtodos: [] };
      cat.todos = cat.todos || []; cat.todos.push(t);
      expanded.add(t.id); markDirty(); render();
    });
  });
  document.querySelectorAll('[data-add-sub]').forEach(el => {
    el.addEventListener('click', () => {
      const f = findTodoLocal(el.dataset.addSub); if (!f) return;
      const t = f.todo;
      const s = { id: uid(), title: 'New subtodo', context: '', branchSuffix: '', status: 'pending' };
      t.subtodos = t.subtodos || []; t.subtodos.push(s);
      expanded.add(s.id); markDirty(); render();
    });
  });
  document.querySelectorAll('[data-launch]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.launch;
      const isSub = el.dataset.sub === '1';
      const f = findTodoLocal(id); if (!f) return;
      const parent = f.parent || f.todo;
      const repo = parent.repo;
      if (!repo) { toast('Set a repo on this todo first.', 'error'); return; }
      if (dirty && !confirm('You have unsaved changes. Launch anyway?')) return;
      const slug = (f.todo.branchSuffix || slugify(f.todo.title) || 'todo').replace(/^-+|-+$/g, '');
      el.disabled = true; el.innerHTML = '<span class="spinner"></span>';
      const callLaunch = async (force) => fetch('/api/todos/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoId: isSub ? parent.id : id, subtodoId: isSub ? id : null, force: !!force }),
      }).then(r => r.json());
      try {
        let res = await callLaunch(false);
        if (res.alreadyLaunched) {
          const ok = confirm('This todo was already launched on ' + new Date(res.launchedAt).toLocaleString() +
            ' at ' + res.worktreePath + '.\n\nOpen another terminal tab for it?');
          if (!ok) { toast('No new terminal opened.', 'info'); return; }
          res = await callLaunch(true);
        }
        if (res.error) { toast('Launch failed: ' + res.error, 'error'); }
        else { toast('🚀 Launched: ' + res.branch + ' @ ' + res.worktreePath, 'success'); await load(); }
      } catch (err) { toast('Launch failed: ' + err.message, 'error'); }
      finally { el.disabled = false; el.innerHTML = '🚀'; }
    });
  });
}

// --- Drag and drop ---
let dragSrc = null; // { type, id, catId?, parentTodoId? }

function clearDropHints() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

function getDropPosition(target, clientY) {
  const rect = target.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  return clientY < mid ? 'before' : 'after';
}

function findCategoryById(id) { return state.categories.find(c => c.id === id); }

function removeTodoFromCategory(catId, todoId) {
  const cat = findCategoryById(catId); if (!cat) return null;
  const idx = (cat.todos || []).findIndex(t => t.id === todoId);
  if (idx < 0) return null;
  return cat.todos.splice(idx, 1)[0];
}

function removeSubtodo(parentTodoId, subId) {
  for (const cat of state.categories) {
    for (const t of (cat.todos || [])) {
      if (t.id !== parentTodoId) continue;
      const idx = (t.subtodos || []).findIndex(s => s.id === subId);
      if (idx < 0) return null;
      return t.subtodos.splice(idx, 1)[0];
    }
  }
  return null;
}

function removeCategoryById(catId) {
  const idx = state.categories.findIndex(c => c.id === catId);
  if (idx < 0) return null;
  return state.categories.splice(idx, 1)[0];
}

function performDrop(src, dropInfo) {
  // dropInfo: { dropType, dropId, position: 'before'|'after'|'into' }
  if (!src) return false;
  // CATEGORY moves
  if (src.type === 'category') {
    if (dropInfo.dropType !== 'category') return false;
    if (src.id === dropInfo.dropId) return false;
    const moved = removeCategoryById(src.id); if (!moved) return false;
    let targetIdx = state.categories.findIndex(c => c.id === dropInfo.dropId);
    if (targetIdx < 0) { state.categories.push(moved); return true; }
    if (dropInfo.position === 'after') targetIdx++;
    state.categories.splice(targetIdx, 0, moved);
    return true;
  }
  // TODO moves
  if (src.type === 'todo') {
    const moved = removeTodoFromCategory(src.catId, src.id);
    if (!moved) return false;
    if (dropInfo.dropType === 'category') {
      // Drop on category header → append to that category's end
      const cat = findCategoryById(dropInfo.dropId);
      if (!cat) return false;
      (cat.todos = cat.todos || []).push(moved);
      return true;
    }
    if (dropInfo.dropType === 'todo-list') {
      const cat = findCategoryById(dropInfo.dropId);
      if (!cat) return false;
      (cat.todos = cat.todos || []).push(moved);
      return true;
    }
    if (dropInfo.dropType === 'todo') {
      // Find target todo's category
      let targetCat = null, targetIdx = -1;
      for (const cat of state.categories) {
        const i = (cat.todos || []).findIndex(t => t.id === dropInfo.dropId);
        if (i >= 0) { targetCat = cat; targetIdx = i; break; }
      }
      if (!targetCat) return false;
      if (dropInfo.position === 'after') targetIdx++;
      targetCat.todos.splice(targetIdx, 0, moved);
      return true;
    }
    return false;
  }
  // SUBTODO moves
  if (src.type === 'subtodo') {
    const moved = removeSubtodo(src.parentTodoId, src.id);
    if (!moved) return false;
    if (dropInfo.dropType === 'subtodo-list') {
      // Append to the subtodos list of dropId
      for (const cat of state.categories) {
        for (const t of (cat.todos || [])) {
          if (t.id !== dropInfo.dropId) continue;
          (t.subtodos = t.subtodos || []).push(moved);
          return true;
        }
      }
      return false;
    }
    if (dropInfo.dropType === 'subtodo') {
      // Find parent of target sub
      for (const cat of state.categories) {
        for (const t of (cat.todos || [])) {
          const i = (t.subtodos || []).findIndex(s => s.id === dropInfo.dropId);
          if (i < 0) continue;
          let idx = i;
          if (dropInfo.position === 'after') idx++;
          t.subtodos.splice(idx, 0, moved);
          return true;
        }
      }
      return false;
    }
    return false;
  }
  return false;
}

function attachDnD() {
  // Drag handles
  document.querySelectorAll('[data-drag]').forEach(handle => {
    handle.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      dragSrc = {
        type: handle.dataset.drag,
        id: handle.dataset.dragId,
        catId: handle.dataset.dragCat || null,
        parentTodoId: handle.dataset.dragParent || null,
      };
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragSrc.id); } catch {}
      const container = handle.closest('[data-drop]');
      if (container) container.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      clearDropHints();
      document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
      dragSrc = null;
    });
  });

  // Drop targets
  document.querySelectorAll('[data-drop]').forEach(target => {
    target.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      const dropType = target.dataset.drop;
      const dropId = target.dataset.dropId;
      const ok = isDropCompatible(dragSrc, dropType, target);
      if (!ok) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      clearDropHints();
      const visual = dropVisualFor(dragSrc, dropType);
      if (visual === 'position') {
        const pos = getDropPosition(target, e.clientY);
        target.classList.add(pos === 'before' ? 'drop-before' : 'drop-after');
      } else {
        target.classList.add('drop-into');
      }
    });
    target.addEventListener('dragleave', (e) => {
      if (!target.contains(e.relatedTarget)) {
        target.classList.remove('drop-before', 'drop-after', 'drop-into');
      }
    });
    target.addEventListener('drop', (e) => {
      if (!dragSrc) return;
      const dropType = target.dataset.drop;
      const dropId = target.dataset.dropId;
      if (!isDropCompatible(dragSrc, dropType, target)) return;
      e.preventDefault();
      e.stopPropagation();
      const visual = dropVisualFor(dragSrc, dropType);
      const position = visual === 'position' ? getDropPosition(target, e.clientY) : 'into';
      const src = dragSrc;
      clearDropHints();
      dragSrc = null;
      if (performDrop(src, { dropType, dropId, position })) {
        markDirty();
        render();
      }
    });
  });
}

function dropVisualFor(src, dropType) {
  // Position-based (before/after) when both source and target are the same kind of orderable item.
  if (src.type === 'category' && dropType === 'category') return 'position';
  if (src.type === 'todo' && dropType === 'todo') return 'position';
  if (src.type === 'subtodo' && dropType === 'subtodo') return 'position';
  // Otherwise: "drop into" container semantics.
  return 'into';
}

function isDropCompatible(src, dropType, target) {
  if (!src) return false;
  // Categories only drop on other categories
  if (src.type === 'category') return dropType === 'category';
  // Todos drop on todos, todo-lists, or categories (append). Not on subtodo containers.
  if (src.type === 'todo') {
    if (dropType === 'todo' || dropType === 'todo-list' || dropType === 'category') {
      // Don't drop onto itself
      if (target.dataset.dropId === src.id) return false;
      return true;
    }
    return false;
  }
  // Subtodos drop on subtodos or subtodo-lists
  if (src.type === 'subtodo') {
    if (dropType === 'subtodo' || dropType === 'subtodo-list') {
      if (target.dataset.dropId === src.id) return false;
      return true;
    }
    return false;
  }
  return false;
}

document.getElementById('addCatBtn').addEventListener('click', () => {
  const name = prompt('Category name?'); if (!name) return;
  state.categories.push({ id: uid(), name, todos: [] });
  markDirty(); render();
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/todos/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).then(r => r.json());
    if (res.ok) { clearDirty(); toast('Saved.', 'success'); }
    else toast('Save failed: ' + (res.error || 'unknown'), 'error');
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '💾 Save All'; }
});

document.getElementById('parseBtn').addEventListener('click', async () => {
  const text = document.getElementById('rawNotes').value.trim();
  if (!text) { toast('Add some notes first.', 'error'); return; }
  const btn = document.getElementById('parseBtn');
  const status = document.getElementById('parseStatus');
  btn.disabled = true; status.innerHTML = '<span class="spinner"></span> Thinking…';
  try {
    const res = await fetch('/api/todos/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, existingCategories: state.categories.map(c => ({ name: c.name })) }),
    }).then(r => r.json());
    if (res.error) { toast('Parse failed: ' + res.error, 'error'); status.textContent = ''; return; }
    mergeProposedIntoState(res.categories || []);
    const chunkSuffix = res.chunks > 1 ? ' (' + res.chunks + ' chunks)' : '';
    if (res.fallbackUsed) {
      status.textContent = '⚠️ Used fallback model: ' + res.fallbackUsed + chunkSuffix;
      toast('Primary model failed; used fallback: ' + res.fallbackUsed, 'info');
    } else if (res.truncated) {
      status.textContent = '⚠️ Output truncated — review carefully (' + (res.model || '') + ')' + chunkSuffix;
      toast('AI response was truncated by token limit; some todos may be missing.', 'info');
    } else if (res.model) {
      status.textContent = '✓ ' + res.model + chunkSuffix;
    } else {
      status.textContent = '';
    }
  } catch (e) { toast('Parse failed: ' + e.message, 'error'); status.textContent = ''; }
  finally { btn.disabled = false; }
});

// Snapshot stored before each AI merge, so user can Undo back to that state.
let preMergeSnapshot = null;
const newItemIds = new Set(); // ids freshly added by AI (highlighted until Accept/Undo)

function mergeProposedIntoState(proposed) {
  if (!proposed || !proposed.length) {
    toast('AI returned no categories.', 'info');
    return;
  }
  // Snapshot for undo
  preMergeSnapshot = JSON.parse(JSON.stringify(state));
  newItemIds.clear();
  for (const pc of proposed) {
    let existing = state.categories.find(c => c.name && c.name.toLowerCase() === pc.name.toLowerCase());
    if (!existing) {
      // The whole category is new
      newItemIds.add(pc.id);
      for (const t of (pc.todos||[])) {
        newItemIds.add(t.id);
        for (const s of (t.subtodos||[])) newItemIds.add(s.id);
      }
      state.categories.push(pc);
    } else {
      for (const t of (pc.todos||[])) {
        newItemIds.add(t.id);
        for (const s of (t.subtodos||[])) newItemIds.add(s.id);
      }
      existing.todos = (existing.todos||[]).concat(pc.todos||[]);
    }
  }
  markDirty();
  showMergeBanner(proposed);
  render();
  // Scroll to the first newly-added item
  setTimeout(() => {
    const first = document.querySelector('.todo.new-from-ai, .category.new-from-ai');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 60);
  // Clear the input
  document.getElementById('rawNotes').value = '';
}

function showMergeBanner(proposed) {
  // Count
  let nCats = 0, nTodos = 0, nSubs = 0;
  for (const pc of proposed) {
    const existing = state.categories.find(c => c.name && c.name.toLowerCase() === pc.name.toLowerCase());
    if (!existing) nCats++; // new category counted
    for (const t of (pc.todos||[])) { nTodos++; nSubs += (t.subtodos||[]).length; }
  }
  let banner = document.getElementById('mergeBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mergeBanner';
    banner.className = 'merge-banner';
    document.getElementById('preview').appendChild(banner);
  }
  const parts = [];
  if (nCats) parts.push(nCats + ' new categor' + (nCats === 1 ? 'y' : 'ies'));
  parts.push(nTodos + ' todo' + (nTodos === 1 ? '' : 's'));
  if (nSubs) parts.push(nSubs + ' subtodo' + (nSubs === 1 ? '' : 's'));
  banner.innerHTML = '<div class="merge-banner-inner">'
    + '<span>✨ AI added <strong>' + parts.join(', ') + '</strong> (highlighted below). Drag/edit them, then:</span>'
    + '<button id="acceptMergeBtn" class="success">✓ Keep</button>'
    + '<button id="undoMergeBtn" class="danger">↶ Undo</button>'
    + '</div>';
  document.getElementById('acceptMergeBtn').addEventListener('click', () => {
    preMergeSnapshot = null;
    newItemIds.clear();
    banner.remove();
    render();
    toast('Kept. Click Save All to persist.', 'success');
  });
  document.getElementById('undoMergeBtn').addEventListener('click', () => {
    if (!preMergeSnapshot) { banner.remove(); return; }
    if (!confirm('Undo the AI merge? All edits since parse will be lost.')) return;
    state.categories = preMergeSnapshot.categories;
    preMergeSnapshot = null;
    newItemIds.clear();
    banner.remove();
    render();
    toast('Reverted to pre-merge state.', 'info');
  });
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

load();
<\/script>
</body></html>`;
}

// --- Auto-save workspace helper ---
//
// Safety design (see AGENTS.md / 2026-05-18 update):
//  1. Refuse to shrink the saved session set during the startup grace window.
//     This prevents a fresh terminal (which may briefly see 0 or 1 sessions
//     before discovery completes) from clobbering a healthy saved state.
//  2. Keep rolling numbered backups (saved-workspace.json.1 .. .N) so a bad
//     save can be recovered by copying the appropriate backup over the
//     primary file. Rotation only runs when the session list actually
//     changes, to avoid churning identical snapshots.
function rotateWorkspaceBackups() {
    try {
        if (!existsSync(WORKSPACE_FILE)) return;
        const oldest = `${WORKSPACE_FILE}.${WORKSPACE_BACKUP_COUNT}`;
        if (existsSync(oldest)) { try { unlinkSync(oldest); } catch {} }
        for (let i = WORKSPACE_BACKUP_COUNT - 1; i >= 1; i--) {
            const src = `${WORKSPACE_FILE}.${i}`;
            const dst = `${WORKSPACE_FILE}.${i + 1}`;
            if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
        }
        try {
            renameSync(WORKSPACE_FILE, `${WORKSPACE_FILE}.1`);
        } catch {
            try { writeFileSync(`${WORKSPACE_FILE}.1`, readFileSync(WORKSPACE_FILE)); } catch {}
        }
    } catch {}
}

function autoSaveWorkspace() {
    try {
        const sessions = scanSessions();
        const alive = sessions.filter(s => s.alive);
        if (alive.length === 0) return; // never persist an empty state

        // Read previous saved state to compare against.
        let prevSessions = null;
        let prevContent = null;
        if (existsSync(WORKSPACE_FILE)) {
            try {
                prevContent = readFileSync(WORKSPACE_FILE, "utf-8");
                const prev = JSON.parse(prevContent);
                if (Array.isArray(prev.sessions)) prevSessions = prev.sessions;
            } catch {}
        }
        const prevCount = prevSessions ? prevSessions.length : 0;

        // Guard #1: during the startup grace window, refuse to shrink the
        // saved set. A new terminal opening shouldn't be able to delete
        // previously-tracked sessions just because it can't see them yet.
        const sinceStart = Date.now() - WORKSPACE_STARTUP_TIME;
        if (sinceStart < WORKSPACE_STARTUP_GRACE_MS && prevCount > 0 && alive.length < prevCount) {
            return;
        }

        const saved = alive.map(s => ({
            sessionId: s.id,
            cwd: s.cwd || "",
            summary: s.summary || "",
            branch: s.branch || "",
            repository: s.repository || "",
        }));
        const payload = { version: 1, savedAt: new Date().toISOString(), sessions: saved };
        const newJson = JSON.stringify(payload, null, 2);

        // Guard #3: only rotate backups when the session list actually
        // changes; otherwise we'd churn 10 identical snapshots per 10 minutes.
        let sameSessions = false;
        if (prevSessions && prevSessions.length === saved.length) {
            // Quick comparison: check if session IDs are identical (ordered)
            sameSessions = prevSessions.every((ps, i) => ps.sessionId === saved[i]?.sessionId);
        }
        if (!sameSessions) rotateWorkspaceBackups();

        const tmpFile = WORKSPACE_FILE + ".tmp";
        writeFileSync(tmpFile, newJson);
        renameSync(tmpFile, WORKSPACE_FILE);
    } catch {}
}

// --- Reports HTML page ---
function reportsHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activity Reports — Copilot</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3;
          --dim: #8b949e; --green: #3fb950; --blue: #58a6ff; --purple: #bc8cff;
          --yellow: #e3b341; --red: #f85149; --orange: #d29922; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text);
         min-height: 100vh; padding: 24px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .back { color: var(--blue); text-decoration: none; font-size: 13px; }
  .back:hover { text-decoration: underline; }
  .section { margin: 28px 0; }
  .section h2 { font-size: 17px; color: var(--dim); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .section h2 .badge { background: var(--blue); color: #000; font-size: 11px; font-weight: 700;
                        padding: 2px 8px; border-radius: 10px; }
  .report-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
                 margin-bottom: 10px; overflow: hidden; }
  .report-header { padding: 14px 18px; cursor: pointer; display: flex; align-items: center; gap: 12px;
                   transition: background 0.2s; }
  .report-header:hover { background: rgba(88,166,255,0.06); }
  .report-header .label { flex: 1; font-weight: 600; font-size: 14px; }
  .report-header .dates { font-size: 12px; color: var(--dim); }
  .report-header .arrow { color: var(--dim); font-size: 12px; transition: transform 0.2s; }
  .report-header .arrow.open { transform: rotate(90deg); }
  .report-stats { display: flex; gap: 16px; font-size: 12px; color: var(--dim); }
  .report-stats .stat { display: flex; align-items: center; gap: 4px; }
  .report-stats .stat .val { color: var(--blue); font-weight: 700; }
  .report-body { display: none; padding: 0 18px 16px; border-top: 1px solid var(--border); }
  .report-body.open { display: block; }
  .report-body h3 { font-size: 13px; color: var(--dim); margin: 14px 0 8px; }
  .repo-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .repo-tag { background: rgba(188,140,255,0.1); color: var(--purple); font-size: 11px;
              padding: 3px 10px; border-radius: 12px; border: 1px solid rgba(188,140,255,0.3); }
  .session-row { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px;
                 display: flex; align-items: center; gap: 12px; }
  .session-row:last-child { border-bottom: none; }
  .session-row .s-summary { flex: 1; }
  .session-row .s-stats { font-size: 11px; color: var(--dim); display: flex; gap: 10px; }
  .session-row .s-stats span { white-space: nowrap; }
  .empty-msg { text-align: center; padding: 40px; color: var(--dim); font-size: 14px; }
  .empty-msg .big { font-size: 40px; margin-bottom: 10px; }
  .gen-btn { background: var(--blue); color: #000; border: none; border-radius: 6px;
             padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight: 600; }
  .gen-btn:hover { opacity: 0.85; }
  .gen-btn:disabled { opacity: 0.5; cursor: default; }
  .gen-btn.small { padding: 4px 12px; font-size: 11px; }
  .gen-btn.regen { background: var(--green); }

  /* Date range picker area */
  .range-bar { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
               padding: 16px 20px; margin: 20px 0; display: flex; align-items: center;
               gap: 12px; flex-wrap: wrap; }
  .range-bar label { font-size: 13px; color: var(--dim); font-weight: 600; }
  .range-bar input[type="date"] { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                                   border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .range-bar input[type="date"]:focus { border-color: var(--blue); outline: none; }
  .range-bar .range-sep { color: var(--dim); font-size: 14px; }
  .range-status { font-size: 12px; color: var(--dim); margin-left: auto; }

  /* Range result card */
  .range-result { background: #0d1f2d; border: 2px solid var(--blue); border-radius: 10px;
                  margin: 16px 0; overflow: hidden; animation: range-in 0.3s ease; }
  .range-result .range-result-header { padding: 14px 18px; display: flex; align-items: center; gap: 12px; }
  .range-result .range-result-header .label { font-weight: 700; font-size: 15px; color: var(--blue); flex: 1; }
  .range-result .range-result-header .dismiss-btn { background: none; border: 1px solid var(--dim);
                  color: var(--dim); border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .range-result .range-result-header .dismiss-btn:hover { border-color: var(--red); color: var(--red); }
  @keyframes range-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

  /* Card action bar at bottom of report body */
  .card-actions { display: flex; gap: 8px; margin-top: 12px; padding-top: 10px;
                  border-top: 1px solid var(--border); }

  /* Report document view */
  .report-doc { margin-top: 12px; padding: 16px; background: rgba(255,255,255,0.03);
                border: 1px solid var(--border); border-radius: 8px; font-size: 13px;
                line-height: 1.7; white-space: pre-wrap; font-family: 'Segoe UI', sans-serif;
                color: var(--text); max-height: 500px; overflow-y: auto; }
  .report-doc h4 { font-size: 14px; color: var(--blue); margin: 12px 0 6px; font-weight: 700; }
  .report-doc h4:first-child { margin-top: 0; }
  .report-doc .doc-title { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
  .report-doc .doc-meta { font-size: 12px; color: var(--dim); margin-bottom: 12px;
                           padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .report-doc ul { margin: 4px 0 8px 20px; padding: 0; }
  .report-doc li { margin: 2px 0; }
  .report-doc .doc-repo-group { margin: 8px 0; }
  .report-doc .doc-repo-name { font-weight: 600; color: var(--purple); font-size: 13px; }
  .copy-doc-btn { background: var(--blue); color: #000; border: none; border-radius: 6px;
                  padding: 4px 12px; font-size: 11px; cursor: pointer; font-weight: 600; }
  .copy-doc-btn:hover { opacity: 0.85; }
  .copy-doc-btn.copied { background: var(--green); }

  /* AI summary styles */
  .ai-report-summary { margin-bottom: 8px; }
  .ai-report-summary:empty { display: none; }
  .ai-content { font-size: 13px; line-height: 1.7; padding: 14px 16px; background: rgba(188,140,255,0.06);
                border: 1px solid rgba(188,140,255,0.2); border-radius: 8px; color: var(--text);
                white-space: pre-wrap; }
  .ai-meta { font-size: 11px; color: var(--dim); margin-top: 4px; padding-left: 2px; }
  .ai-loading { font-size: 13px; color: var(--purple); padding: 12px 16px;
                background: rgba(188,140,255,0.06); border: 1px dashed rgba(188,140,255,0.3);
                border-radius: 8px; animation: ai-pulse 1.5s ease-in-out infinite; }
  .ai-error { font-size: 12px; color: var(--red); padding: 8px 12px; }
  .ai-badge { background: rgba(188,140,255,0.15); color: var(--purple); font-size: 10px; font-weight: 700;
              padding: 2px 8px; border-radius: 10px; }
  .ai-gen-btn { background: rgba(188,140,255,0.2) !important; color: var(--purple) !important; }
  .ai-gen-btn:hover { background: rgba(188,140,255,0.35) !important; }
  @keyframes ai-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head>
<body>
<a href="/" class="back">← Back to Dashboard</a>
<h1>📋 Activity Reports</h1>
<p style="color:var(--dim);font-size:13px;margin:4px 0 16px;">Weekly and monthly summaries of your Copilot sessions.</p>

<div class="range-bar">
  <label>📊 Generate Report</label>
  <input type="date" id="rangeStart" />
  <span class="range-sep">→</span>
  <input type="date" id="rangeEnd" />
  <button class="gen-btn" id="rangeGenBtn">Generate Range Report</button>
  <button class="gen-btn" id="genAllBtn" style="background:var(--dim);">🔄 Regenerate All Periods</button>
  <span class="range-status" id="rangeStatus"></span>
</div>

<div id="rangeResult" style="display:none;"></div>

<div class="section" id="monthlySection">
  <h2>📅 Monthly Reports <span class="badge" id="monthlyCount">0</span></h2>
  <div id="monthlyList"></div>
</div>

<div class="section" id="weeklySection">
  <h2>📆 Weekly Reports <span class="badge" id="weeklyCount">0</span></h2>
  <div id="weeklyList"></div>
</div>

<div class="section" id="rangeSection" style="display:none;">
  <h2>📊 Saved Range Reports <span class="badge" id="rangeCount">0</span></h2>
  <div id="rangeList"></div>
</div>

<script>
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function shortRepo(r) { if (!r) return ''; const parts = r.split('/'); return parts[parts.length - 1] || r; }

function buildReportText(report) {
  const lines = [];
  lines.push(report.label || 'Activity Report');
  lines.push('Period: ' + report.startDate + ' → ' + report.endDate);
  lines.push('Generated: ' + (report.generatedAt ? new Date(report.generatedAt).toLocaleString() : 'N/A'));
  lines.push('');
  lines.push('Summary');
  lines.push('- ' + report.sessionCount + ' sessions');
  lines.push('- ' + report.totalTurns + ' conversation turns');
  lines.push('- ' + report.totalToolCalls + ' tool calls');
  lines.push('- ' + report.totalTaskCompletes + ' tasks completed');
  if (report.repositories && report.repositories.length) {
    lines.push('- ' + report.repositories.length + ' repositories');
  }
  lines.push('');

  // AI summary if available
  if (report.aiSummary) {
    lines.push('Overview');
    lines.push('');
    lines.push(report.aiSummary);
    lines.push('');
  }

  // Group sessions by repository
  const byRepo = {};
  for (const s of (report.sessions || [])) {
    const repo = s.repository || s.cwd || 'Other';
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(s);
  }
  const repoKeys = Object.keys(byRepo).sort();
  if (repoKeys.length > 0) {
    lines.push('Work by Repository');
    lines.push('');
    for (const repo of repoKeys) {
      const sessions = byRepo[repo];
      const repoName = repo.replace(/\\\\/g, '/').split('/').slice(-2).join('/');
      lines.push('  ' + repoName + ' (' + sessions.length + ' sessions)');
      for (const s of sessions) {
        const summary = s.summary || s.id;
        const parts = [];
        if (s.turns) parts.push(s.turns + ' turns');
        if (s.toolCalls) parts.push(s.toolCalls + ' tools');
        if (s.taskCompletes) parts.push(s.taskCompletes + ' completed');
        lines.push('    - ' + summary + (parts.length ? ' (' + parts.join(', ') + ')' : ''));
      }
      lines.push('');
    }
  }
  return lines.join('\\n');
}

function buildReportHtml(report) {
  let html = '<div class="doc-title">' + esc(report.label || 'Activity Report') + '</div>';
  html += '<div class="doc-meta">Period: ' + esc(report.startDate) + ' → ' + esc(report.endDate);
  if (report.generatedAt) html += ' · Generated: ' + new Date(report.generatedAt).toLocaleString();
  html += '</div>';

  html += '<h4>📊 Summary</h4><ul>';
  html += '<li>' + report.sessionCount + ' sessions</li>';
  html += '<li>' + report.totalTurns + ' conversation turns</li>';
  html += '<li>' + report.totalToolCalls + ' tool calls</li>';
  html += '<li>' + report.totalTaskCompletes + ' tasks completed</li>';
  if (report.repositories && report.repositories.length) {
    html += '<li>' + report.repositories.length + ' repositories</li>';
  }
  html += '</ul>';

  // AI summary if available
  if (report.aiSummary) {
    html += '<h4>✨ Overview</h4><div style="white-space:pre-wrap;line-height:1.7;">' + esc(report.aiSummary).replace(/\\n/g, '<br>') + '</div>';
  }

  // Group sessions by repo
  const byRepo = {};
  for (const s of (report.sessions || [])) {
    const repo = s.repository || s.cwd || 'Other';
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(s);
  }
  const repoKeys = Object.keys(byRepo).sort();
  if (repoKeys.length > 0) {
    html += '<h4>📂 Work by Repository</h4>';
    for (const repo of repoKeys) {
      const sessions = byRepo[repo];
      const repoName = repo.replace(/\\\\/g, '/').split('/').slice(-2).join('/');
      html += '<div class="doc-repo-group"><span class="doc-repo-name">' + esc(repoName) + '</span> (' + sessions.length + ' sessions)<ul>';
      for (const s of sessions) {
        const summary = s.summary || s.id;
        const parts = [];
        if (s.turns) parts.push(s.turns + ' turns');
        if (s.toolCalls) parts.push(s.toolCalls + ' tools');
        if (s.taskCompletes) parts.push(s.taskCompletes + ' completed');
        html += '<li>' + esc(summary) + (parts.length ? ' <span style="color:var(--dim);">(' + parts.join(', ') + ')</span>' : '') + '</li>';
      }
      html += '</ul></div>';
    }
  }
  return html;
}

let openDocs = new Set();
let reportDataMap = {}; // id -> report object

function renderReport(report, opts) {
  opts = opts || {};
  const id = 'rpt-' + Math.random().toString(36).slice(2, 8);
  reportDataMap[id] = report;
  const repos = (report.repositories || []).map(r => '<span class="repo-tag">' + esc(shortRepo(r)) + '</span>').join('');
  const sessions = (report.sessions || []).map(s =>
    '<div class="session-row">'
    + '<div class="s-summary">' + esc(s.summary || s.id) + '</div>'
    + '<div class="s-stats">'
    + '<span>💬 ' + (s.turns || 0) + '</span>'
    + '<span>🔧 ' + (s.toolCalls || 0) + '</span>'
    + '<span>✅ ' + (s.taskCompletes || 0) + '</span>'
    + '</div></div>'
  ).join('');
  // AI summary display (show if already generated)
  let aiHtml = '<div class="ai-report-summary" id="ai-' + id + '">';
  if (report.aiSummary) {
    aiHtml += '<div class="ai-content">' + esc(report.aiSummary).replace(/\\n/g, '<br>') + '</div>'
      + '<div class="ai-meta">Generated ' + (report.aiSummaryGeneratedAt ? new Date(report.aiSummaryGeneratedAt).toLocaleString() : '') + '</div>';
  }
  aiHtml += '</div>';
  // Action buttons
  let actionsHtml = '<div class="card-actions">'
    + '<button class="gen-btn small" onclick="toggleDoc(event, \\'' + id + '\\')">📄 View Report</button>'
    + '<button class="copy-doc-btn" onclick="copyDoc(event, \\'' + id + '\\')">📋 Copy Report</button>';
  if (report.type && report.startDate && report.endDate) {
    actionsHtml += '<button class="gen-btn small ai-gen-btn" data-type="' + esc(report.type) + '" data-start="' + esc(report.startDate)
      + '" data-end="' + esc(report.endDate) + '" data-card-id="' + id + '" onclick="genAISummary(event)">'
      + (report.aiSummary ? '🔄 Regenerate AI Summary' : '✨ Generate AI Summary') + '</button>';
  }
  if (opts.showGenerate && report.type && report.startDate && report.endDate) {
    actionsHtml += '<button class="gen-btn small regen" data-type="' + esc(report.type) + '" data-start="' + esc(report.startDate)
      + '" data-end="' + esc(report.endDate) + '" data-label="' + esc(report.label || '') + '" onclick="regenReport(event)">🔄 Regenerate Data</button>';
  }
  actionsHtml += '</div>';
  // Doc area (hidden by default)
  const docHtml = '<div class="report-doc" id="doc-' + id + '" style="display:none;"></div>';

  return '<div class="report-card">'
    + '<div class="report-header" onclick="toggleReport(\\'' + id + '\\')">'
    + '<span class="arrow" id="arrow-' + id + '">▶</span>'
    + '<span class="label">' + esc(report.label || report.type) + '</span>'
    + (report.aiSummary ? '<span class="ai-badge">✨ AI</span>' : '')
    + '<span class="dates">' + esc(report.startDate) + ' → ' + esc(report.endDate) + '</span>'
    + '<div class="report-stats">'
    + '<div class="stat">📊 <span class="val">' + report.sessionCount + '</span> sessions</div>'
    + '<div class="stat">💬 <span class="val">' + report.totalTurns + '</span> turns</div>'
    + '<div class="stat">🔧 <span class="val">' + report.totalToolCalls + '</span> tools</div>'
    + '<div class="stat">✅ <span class="val">' + report.totalTaskCompletes + '</span> tasks</div>'
    + '</div></div>'
    + '<div class="report-body" id="body-' + id + '">'
    + aiHtml
    + actionsHtml
    + docHtml
    + (repos ? '<h3>Repositories</h3><div class="repo-tags">' + repos + '</div>' : '')
    + '<h3>Sessions</h3>' + (sessions || '<div class="empty-msg">No sessions</div>')
    + '</div></div>';
}

function toggleReport(id) {
  const body = document.getElementById('body-' + id);
  const arrow = document.getElementById('arrow-' + id);
  body.classList.toggle('open');
  arrow.classList.toggle('open');
}

function toggleDoc(event, id) {
  event.stopPropagation();
  const docEl = document.getElementById('doc-' + id);
  if (!docEl) return;
  if (docEl.style.display === 'none') {
    const report = reportDataMap[id];
    if (report) docEl.innerHTML = buildReportHtml(report);
    docEl.style.display = '';
  } else {
    docEl.style.display = 'none';
  }
}

function copyDoc(event, id) {
  event.stopPropagation();
  const btn = event.target.closest('.copy-doc-btn');
  const report = reportDataMap[id];
  if (!report) return;
  const text = buildReportText(report);
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋 Copy Report'; }, 1500);
  });
}

async function genAISummary(event) {
  event.stopPropagation();
  const btn = event.target.closest('.ai-gen-btn');
  const { type, start, end, cardId } = btn.dataset;
  const orig = btn.textContent;
  btn.textContent = '⏳ Generating AI summary…';
  btn.disabled = true;
  const aiEl = document.getElementById('ai-' + cardId);
  if (aiEl) aiEl.innerHTML = '<div class="ai-loading">✨ Asking AI to summarize this period…</div>';
  try {
    const resp = await fetch('/api/generate-report-summary', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ type, startDate: start, endDate: end })
    });
    const data = await resp.json();
    if (data.error) {
      btn.textContent = '❌ ' + data.error;
      if (aiEl) aiEl.innerHTML = '<div class="ai-error">Failed: ' + esc(data.error) + '</div>';
    } else {
      btn.textContent = '✅ Summary generated!';
      // Update the AI summary display
      if (aiEl) {
        aiEl.innerHTML = '<div class="ai-content">' + esc(data.summary).replace(/\\n/g, '<br>') + '</div>'
          + '<div class="ai-meta">Generated just now</div>';
      }
      // Update in-memory report data so Copy Report includes it
      if (reportDataMap[cardId]) reportDataMap[cardId].aiSummary = data.summary;
    }
  } catch (e) {
    btn.textContent = '❌ Failed';
    if (aiEl) aiEl.innerHTML = '<div class="ai-error">Request failed</div>';
  }
  setTimeout(() => { btn.textContent = orig.includes('Regenerate') ? '🔄 Regenerate AI Summary' : '🔄 Regenerate AI Summary'; btn.disabled = false; }, 3000);
}

async function regenReport(event) {
  event.stopPropagation();
  const btn = event.target.closest('.gen-btn');
  const { type, start, end, label } = btn.dataset;
  const orig = btn.textContent;
  btn.textContent = '⏳…';
  btn.disabled = true;
  try {
    const resp = await fetch('/api/generate-single-report', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ type, startDate: start, endDate: end, label })
    });
    const data = await resp.json();
    if (data.error) { btn.textContent = '❌ ' + data.error; }
    else { btn.textContent = '✅ Regenerated (' + data.sessionCount + ' sessions)'; await loadReports(); }
  } catch { btn.textContent = '❌ Failed'; }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
}

async function loadReports() {
  try {
    const resp = await fetch('/api/reports');
    const data = await resp.json();
    document.getElementById('weeklyCount').textContent = data.weekly.length;
    document.getElementById('monthlyCount').textContent = data.monthly.length;
    document.getElementById('weeklyList').innerHTML = data.weekly.length
      ? data.weekly.map(r => renderReport(r, { showGenerate: true })).join('')
      : '<div class="empty-msg"><div class="big">📭</div>No weekly reports yet.</div>';
    document.getElementById('monthlyList').innerHTML = data.monthly.length
      ? data.monthly.map(r => renderReport(r, { showGenerate: true })).join('')
      : '<div class="empty-msg"><div class="big">📭</div>No monthly reports yet.</div>';
    // Range reports
    if (data.range && data.range.length > 0) {
      document.getElementById('rangeSection').style.display = '';
      document.getElementById('rangeCount').textContent = data.range.length;
      document.getElementById('rangeList').innerHTML = data.range.map(r => renderReport(r)).join('');
    } else {
      document.getElementById('rangeSection').style.display = 'none';
    }
  } catch (e) {
    document.getElementById('weeklyList').innerHTML = '<div class="empty-msg">Failed to load reports.</div>';
  }
}

// Default date range: last 7 days
(function initDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  document.getElementById('rangeStart').value = start.toISOString().slice(0, 10);
  document.getElementById('rangeEnd').value = end.toISOString().slice(0, 10);
})();

// Generate range report
document.getElementById('rangeGenBtn').addEventListener('click', async () => {
  const btn = document.getElementById('rangeGenBtn');
  const startDate = document.getElementById('rangeStart').value;
  const endDate = document.getElementById('rangeEnd').value;
  const statusEl = document.getElementById('rangeStatus');
  if (!startDate || !endDate) { statusEl.textContent = '⚠️ Select both dates'; return; }
  if (startDate > endDate) { statusEl.textContent = '⚠️ Start must be before end'; return; }
  btn.textContent = '⏳ Generating…';
  btn.disabled = true;
  statusEl.textContent = '';
  try {
    const resp = await fetch('/api/generate-range-report', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ startDate, endDate })
    });
    const data = await resp.json();
    if (data.error) {
      statusEl.textContent = '❌ ' + data.error;
    } else {
      statusEl.textContent = '✅ ' + data.sessionCount + ' sessions found';
      // Show inline result
      const resultDiv = document.getElementById('rangeResult');
      resultDiv.style.display = '';
      resultDiv.innerHTML = '<div class="range-result">'
        + '<div class="range-result-header">'
        + '<span class="label">📊 ' + esc(data.label || 'Range Report') + '</span>'
        + '<span class="report-stats">'
        + '<span class="stat">📊 <span class="val">' + data.sessionCount + '</span> sessions</span>'
        + '<span class="stat">💬 <span class="val">' + data.totalTurns + '</span> turns</span>'
        + '<span class="stat">🔧 <span class="val">' + data.totalToolCalls + '</span> tools</span>'
        + '<span class="stat">✅ <span class="val">' + data.totalTaskCompletes + '</span> tasks</span>'
        + '</span>'
        + '<button class="dismiss-btn" onclick="document.getElementById(\\'rangeResult\\').style.display=\\'none\\'">✕ Dismiss</button>'
        + '</div>'
        + '<div style="padding:0 18px 16px;">'
        + (data.repositories && data.repositories.length ? '<h3 style="font-size:13px;color:var(--dim);margin:10px 0 6px;">Repositories</h3><div class="repo-tags">' + data.repositories.map(r => '<span class="repo-tag">' + esc(shortRepo(r)) + '</span>').join('') + '</div>' : '')
        + '<h3 style="font-size:13px;color:var(--dim);margin:10px 0 6px;">Sessions</h3>'
        + (data.sessions || []).map(s =>
            '<div class="session-row">'
            + '<div class="s-summary">' + esc(s.summary || s.id) + '</div>'
            + '<div class="s-stats">'
            + '<span>💬 ' + (s.turns || 0) + '</span>'
            + '<span>🔧 ' + (s.toolCalls || 0) + '</span>'
            + '<span>✅ ' + (s.taskCompletes || 0) + '</span>'
            + '</div></div>').join('')
        + '</div></div>';
      await loadReports();
    }
  } catch { statusEl.textContent = '❌ Failed'; }
  btn.textContent = 'Generate Range Report';
  btn.disabled = false;
});

// Regenerate all periods button
document.getElementById('genAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('genAllBtn');
  btn.textContent = '⏳ Generating…';
  btn.disabled = true;
  try {
    await fetch('/api/generate-reports', { method: 'POST' });
    await loadReports();
    btn.textContent = '✅ Done';
  } catch { btn.textContent = '❌ Failed'; }
  setTimeout(() => { btn.textContent = '🔄 Regenerate All Periods'; btn.disabled = false; }, 2000);
});

loadReports();
</script>
</body>
</html>`;
}

// --- HTTP Server ---
const server = createServer((req, res) => {
    if (req.url === "/api/stream") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
    }
    if (req.url === "/api/sessions") {
        const sessions = scanSessions();
        sendJson(res, sessions);
        return;
    }
    if (req.url === "/api/repos") {
        sendJson(res, scanRepos());
        return;
    }
    if (req.url === "/api/resume" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { sessionId, cwd } = JSON.parse(body);
                if (!sessionId) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Missing sessionId" }));
                    return;
                }
                const dir = cwd && existsSync(cwd) ? cwd : homedir();
                // Open a new tab in Windows Terminal, cd to dir, and resume
                const cmd = `wt -w 0 new-tab --title "Copilot: ${sessionId.slice(0, 8)}" -d "${dir}" cmd /k "${COPILOT_CMD} --resume=${sessionId}"`;
                exec(cmd, () => {});
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(e) }));
            }
        });
        return;
    }
    if (req.url === "/api/open" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { path: targetPath, editor } = JSON.parse(body);
                if (!targetPath || !existsSync(targetPath)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Path not found" }));
                    return;
                }
                const cmd = editor === "vs" ? `vs.cmd "${targetPath}"` : `code "${targetPath}"`;
                exec(cmd, { cwd: targetPath }, () => {});
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(e) }));
            }
        });
        return;
    }
    // --- Feature 2: Kill session ---
    if (req.url === "/api/kill" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { pid } = JSON.parse(body);
                if (!pid) { res.writeHead(400); res.end('{"error":"Missing pid"}'); return; }
                try { process.kill(Number(pid), 'SIGTERM'); } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: String(e) })); return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"ok":true}');
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    // --- Feature 3: Events endpoint ---
    if (req.url?.startsWith("/api/events")) {
        const url = new URL(req.url, "http://localhost");
        const sessionId = url.searchParams.get("id");
        if (!sessionId) { res.writeHead(400); res.end('{"error":"Missing id"}'); return; }
        const eventsPath = join(SESSION_STATE_DIR, sessionId, "events.jsonl");
        let events = [];
        try {
            const raw = readFileSync(eventsPath, "utf-8");
            const lines = raw.trim().split("\n").slice(-50);
            events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(events));
        return;
    }
    // --- Feature 4: Notes endpoints ---
    if (req.url === "/api/notes" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(loadNotes()));
        return;
    }
    if (req.url === "/api/notes" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { sessionId, note } = JSON.parse(body);
                const notes = loadNotes();
                if (note) notes[sessionId] = note;
                else delete notes[sessionId];
                saveNotes(notes);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"ok":true}');
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    // --- Feature 6: Focus terminal tab ---
    if (req.url === "/api/focus-tab" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { title, altTitle, pid, cwd, sessionId } = JSON.parse(body);
                sendFocusCommand(title, altTitle, cwd, (result) => {
                    // If no matching tab was found, launch a new one
                    if ((result === "FOCUSED_WINDOW" || result === "NO_WT") && sessionId) {
                        const dir = cwd && existsSync(cwd) ? cwd : homedir();
                        const tabTitle = (title || `Copilot: ${sessionId.slice(0, 8)}`).replace(/"/g, "'");
                        const resumeCmd = `${COPILOT_CMD} --resume=${sessionId}`;
                        const cmd = result === "NO_WT"
                            ? `wt --title "${tabTitle}" -d "${dir}" cmd /k "${resumeCmd}"`
                            : `wt -w 0 new-tab --title "${tabTitle}" -d "${dir}" cmd /k "${resumeCmd}"`;
                        exec(cmd, () => {});
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, action: "launched", result }));
                    } else {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, action: "focused", result }));
                    }
                });
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    // --- Feature 8: Stale sessions & cleanup ---
    if (req.url === "/api/stale-sessions") {
        const stale = [];
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const sessions = scanSessions();
        for (const s of sessions) {
            if (s.alive) continue;
            const lastTime = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
            if (lastTime && (Date.now() - lastTime) > THIRTY_DAYS) {
                // Only compute size on demand (this is a rarely-called endpoint)
                let size = 0;
                const dir = join(SESSION_STATE_DIR, s.id);
                try {
                    const files = readdirSync(dir);
                    for (const f of files) { try { size += statSync(join(dir, f)).size; } catch {} }
                } catch {}
                stale.push({ id: s.id, age: Math.round((Date.now() - lastTime) / 86400000), size });
            }
        }
        sendJson(res, stale);
        return;
    }
    if (req.url === "/api/cleanup" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { sessionIds } = JSON.parse(body);
                const archiveDir = join(SESSION_STATE_DIR, ".archive");
                try { mkdirSync(archiveDir, { recursive: true }); } catch {}
                let moved = 0;
                for (const id of (sessionIds || [])) {
                    const src = join(SESSION_STATE_DIR, id);
                    const dst = join(archiveDir, id);
                    try { renameSync(src, dst); moved++; } catch {}
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, moved }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    // --- Feature 10: Analytics data ---
    if (req.url === "/api/analytics-data") {
        sendJson(res, computeAnalyticsData());
        return;
    }
    if (req.url === "/analytics") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(cachedHtml("analytics", analyticsHtml));
        return;
    }
    // --- Todos feature ---
    if (req.url === "/todos") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(cachedHtml("todos", todosHtml));
        return;
    }
    if (req.url === "/api/todos" && req.method === "GET") {
        sendJson(res, loadTodos());
        return;
    }
    if (req.url === "/api/todos/save" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (!data || !Array.isArray(data.categories)) {
                    res.writeHead(400); res.end('{"error":"Invalid payload"}'); return;
                }
                data.version = 1;
                const ok = saveTodos(data);
                res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    if (req.url === "/api/todos/parse" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", async () => {
            try {
                const { text, existingCategories } = JSON.parse(body);
                if (!text || !text.trim()) {
                    res.writeHead(400); res.end('{"error":"text is required"}'); return;
                }
                const result = await parseTodosWithAI(text, existingCategories || []);
                if (result.error) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: result.error }));
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    if (req.url === "/api/todos/launch" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", async () => {
            try {
                const { todoId, subtodoId, force } = JSON.parse(body);
                const data = loadTodos();
                const found = findTodo(data, todoId, subtodoId || null);
                if (!found) { res.writeHead(404); res.end('{"error":"Todo not found"}'); return; }
                const { category, todo, sub } = found;
                const target = sub || todo;
                const repo = todo.repo;
                if (!repo) { res.writeHead(400); res.end('{"error":"Set a repo on this todo first."}'); return; }
                const slug = (target.branchSuffix || slugify(target.title) || "todo").replace(/^-+|-+$/g, "");

                // Idempotency guard: if this todo was already launched and the
                // worktree dir still exists, don't silently spawn another terminal.
                // The UI can re-call with force:true after confirming with the user.
                if (!force && target.launchedAt && target.worktreePath && existsSync(target.worktreePath)) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        alreadyLaunched: true,
                        worktreePath: target.worktreePath,
                        branch: target.branch,
                        launchedAt: target.launchedAt,
                    }));
                    return;
                }

                // Build the .copilot-todo.md content
                const lines = [];
                lines.push(`# Todo: ${target.title}`);
                lines.push("");
                lines.push(`Category: ${category.name}`);
                lines.push(`Status: ${target.status || "pending"}`);
                if (sub) lines.push(`Parent todo: ${todo.title}`);
                lines.push("");
                if (target.context) {
                    lines.push("## Context");
                    lines.push(target.context);
                    lines.push("");
                }
                if (sub && todo.context) {
                    lines.push("## Parent context");
                    lines.push(todo.context);
                    lines.push("");
                }
                lines.push("---");
                lines.push("");
                lines.push("This file was created by the session dashboard's Todos feature.");
                lines.push("When work here is complete, mark this todo as done in the dashboard at /todos.");

                const tabTitle = `Copilot: ${target.title.slice(0, 40)}`;
                const launchRes = await launchTodoWorktree({
                    repo,
                    branchSlug: slug,
                    tabTitle,
                    todoMdPath: ".copilot-todo.md",
                    todoMdContent: lines.join("\n"),
                });
                if (launchRes.error) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(launchRes));
                    return;
                }
                // Persist back to the todo for traceability
                target.worktreePath = launchRes.worktreePath;
                target.branch = launchRes.branch;
                target.launchedAt = new Date().toISOString();
                if (target.status === "pending") target.status = "in_progress";
                target.updatedAt = new Date().toISOString();
                saveTodos(data);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(launchRes));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    // --- Feature 12: Workspace save/restore ---
    if (req.url === "/api/workspace-status") {
        try {
            if (existsSync(WORKSPACE_FILE)) {
                const data = JSON.parse(readFileSync(WORKSPACE_FILE, "utf-8"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ hasSaved: true, count: (data.sessions || []).length, savedAt: data.savedAt || "", restoredAt: data.restoredAt || "" }));
            } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ hasSaved: false, count: 0 }));
            }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/save-workspace" && req.method === "POST") {
        try {
            autoSaveWorkspace();
            const data = existsSync(WORKSPACE_FILE) ? JSON.parse(readFileSync(WORKSPACE_FILE, "utf-8")) : { sessions: [] };
            const count = (data.sessions || []).length;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, count }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/restore-workspace" && req.method === "POST") {
        try {
            if (!existsSync(WORKSPACE_FILE)) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ restored: 0, skippedAlive: 0, skippedMissing: 0, failed: 0 }));
                return;
            }
            const data = JSON.parse(readFileSync(WORKSPACE_FILE, "utf-8"));
            const savedSessions = data.sessions || [];
            const currentSessions = scanSessions();
            const aliveIds = new Set(currentSessions.filter(s => s.alive).map(s => s.id));

            let restored = 0, skippedAlive = 0, skippedMissing = 0, failed = 0;

            // Build list of sessions to restore
            const toRestore = [];
            for (const s of savedSessions) {
                if (aliveIds.has(s.sessionId)) { skippedAlive++; continue; }
                const sessionDir = join(SESSION_STATE_DIR, s.sessionId);
                if (!existsSync(sessionDir)) { skippedMissing++; continue; }
                toRestore.push(s);
            }

            // Launch each session in a new WT tab with staggered delays
            const launchNext = (i) => {
                if (i >= toRestore.length) return;
                const s = toRestore[i];
                const dir = s.cwd && existsSync(s.cwd) ? s.cwd : homedir();
                const tabTitle = (s.summary ? `Copilot: ${s.summary.slice(0, 40)}` : `Copilot: ${s.sessionId.slice(0, 8)}`).replace(/"/g, "'");
                const resumeCmd = `${COPILOT_CMD} --resume=${s.sessionId}`;
                let cmd;
                if (i === 0) {
                    cmd = `wt --title "${tabTitle}" -d "${dir}" cmd /k "${resumeCmd}"`;
                } else {
                    cmd = `wt -w 0 new-tab --title "${tabTitle}" -d "${dir}" cmd /k "${resumeCmd}"`;
                }
                exec(cmd, () => {});
                // Stagger launches by 800ms so WT can register each tab
                if (i + 1 < toRestore.length) setTimeout(() => launchNext(i + 1), 800);
            };
            if (toRestore.length > 0) launchNext(0);
            restored = toRestore.length;

            // Mark as restored but keep the file
            data.restoredAt = new Date().toISOString();
            const tmpFile = WORKSPACE_FILE + ".tmp";
            writeFileSync(tmpFile, JSON.stringify(data, null, 2));
            renameSync(tmpFile, WORKSPACE_FILE);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ restored, skippedAlive, skippedMissing, failed }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/workspace-backups") {
        try {
            const snapshots = [];
            const readSnap = (path, slot) => {
                if (!existsSync(path)) return null;
                try {
                    const raw = readFileSync(path, "utf-8");
                    const data = JSON.parse(raw);
                    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
                    let savedAt = data.savedAt || "";
                    if (!savedAt) {
                        try { savedAt = statSync(path).mtime.toISOString(); } catch {}
                    }
                    return { slot, savedAt, count: sessions.length, sessions };
                } catch (e) {
                    let savedAt = "";
                    try { savedAt = statSync(path).mtime.toISOString(); } catch {}
                    return { slot, savedAt, count: 0, sessions: [], error: String(e) };
                }
            };
            const cur = readSnap(WORKSPACE_FILE, "current");
            if (cur) snapshots.push(cur);
            for (let i = 1; i <= WORKSPACE_BACKUP_COUNT; i++) {
                const snap = readSnap(`${WORKSPACE_FILE}.${i}`, i);
                if (snap) snapshots.push(snap);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ snapshots }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/workspace-promote" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const { slot } = JSON.parse(body || "{}");
                const slotNum = Number(slot);
                if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > WORKSPACE_BACKUP_COUNT) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: `Invalid slot: ${slot}` }));
                    return;
                }
                const src = `${WORKSPACE_FILE}.${slotNum}`;
                if (!existsSync(src)) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: `Backup .${slotNum} does not exist` }));
                    return;
                }
                // Validate the backup parses and has sessions before promoting.
                let parsed;
                try {
                    parsed = JSON.parse(readFileSync(src, "utf-8"));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: `Backup .${slotNum} is not valid JSON: ${e}` }));
                    return;
                }
                const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

                // Rotate current → backup chain so we don't lose it.
                rotateWorkspaceBackups();

                // Write the promoted snapshot as the new active file. Refresh
                // savedAt so the UI shows "promoted just now" while preserving
                // the original timestamp in a sibling field for traceability.
                const payload = {
                    version: parsed.version || 1,
                    savedAt: new Date().toISOString(),
                    promotedFromSlot: slotNum,
                    promotedFromSavedAt: parsed.savedAt || "",
                    sessions,
                };
                const tmpFile = WORKSPACE_FILE + ".tmp";
                writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
                renameSync(tmpFile, WORKSPACE_FILE);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, count: sessions.length, slot: slotNum }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: String(e) }));
            }
        });
        return;
    }
    if (req.url === "/api/screen-blank" && req.method === "POST") {
        if (screenBlankActive) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true,"skipped":"already active"}');
            return;
        }
        try {
            screenBlankActive = true;
            // Cancel any existing lock countdown
            if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
            lockFlowActive = false;
            const scriptPath = join(homedir(), ".copilot", "screen-blank.ps1");
            const callbackUrl = `http://127.0.0.1:${serverPort}/api/screen-dismissed`;
            const ps = [
                "Add-Type -AssemblyName System.Windows.Forms",
                "[System.Windows.Forms.Application]::EnableVisualStyles()",
                "$script:forms = @()",
                "$screens = [System.Windows.Forms.Screen]::AllScreens",
                "foreach ($scr in $screens) {",
                "    $f = New-Object System.Windows.Forms.Form",
                "    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None",
                "    $f.BackColor = [System.Drawing.Color]::Black",
                "    $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
                "    $f.Bounds = $scr.Bounds",
                "    $f.TopMost = $true",
                "    $f.Cursor = [System.Windows.Forms.Cursors]::None",
                "    $f.ShowInTaskbar = $false",
                "    $f.KeyPreview = $true",
                "    $f.Add_Click({ foreach ($x in $script:forms) { try { $x.Close() } catch {} } })",
                "    $f.Add_KeyDown({ foreach ($x in $script:forms) { try { $x.Close() } catch {} } })",
                "    $f.Add_MouseMove({",
                "        if (-not $script:lastPt) { $script:lastPt = [System.Windows.Forms.Cursor]::Position; return }",
                "        $cur = [System.Windows.Forms.Cursor]::Position",
                "        $dx = [Math]::Abs($cur.X - $script:lastPt.X)",
                "        $dy = [Math]::Abs($cur.Y - $script:lastPt.Y)",
                "        if ($dx -gt 20 -or $dy -gt 20) { foreach ($x in $script:forms) { try { $x.Close() } catch {} } }",
                "    })",
                "    $script:forms += $f",
                "}",
                "foreach ($f in $script:forms) { $f.Show() }",
                "if ($script:forms.Count -gt 0) { $script:forms[0].Activate() }",
                "[System.Windows.Forms.Application]::Run($script:forms[0])",
                "# Forms dismissed — notify server to start lock countdown",
                `try { Invoke-WebRequest -Uri '${callbackUrl}' -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`,
            ].join("\r\n");
            writeFileSync(scriptPath, ps);
            spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true, stdio: "ignore" }).unref();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/screen-dismissed" && req.method === "POST") {
        // Called by the PS script when black screens are dismissed — start lock countdown
        screenBlankActive = false;
        // Ignore duplicate calls — only one lock flow at a time
        if (lockFlowActive) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true,"skipped":"lock flow already active"}');
            return;
        }
        lockFlowActive = true;

        // Start webcam capture NOW so it has the full countdown duration to finish
        const photoDir = join(homedir(), ".copilot", "intrusion-photos");
        try { mkdirSync(photoDir, { recursive: true }); } catch {}
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const photoFile = join(photoDir, `intrusion-${ts}.jpg`);
        const intrusionTs = new Date().toISOString();
        const capturePy = [
            "import cv2, json",
            `photo = r'${photoFile}'`,
            `intrusion = r'${INTRUSION_FILE}'`,
            "ok = False",
            "try:",
            "    cap = cv2.VideoCapture(0)",
            "    if cap.isOpened():",
            "        for _ in range(5): cap.read()",
            "        ret, frame = cap.read()",
            "        cap.release()",
            "        if ret:",
            "            cv2.imwrite(photo, frame)",
            "            ok = True",
            "except: pass",
            `data = {'intrusion': True, 'timestamp': '${intrusionTs}'}`,
            "if ok: data['photo'] = photo",
            "with open(intrusion, 'w') as f: json.dump(data, f)",
        ].join("\n");
        const captureScriptPath = join(homedir(), ".copilot", "intrusion-capture.py");
        writeFileSync(captureScriptPath, capturePy);
        spawn("py", [captureScriptPath], { windowsHide: true, stdio: "ignore" }).unref();

        let remaining = LOCK_COUNTDOWN_SEC;
        const sendCountdown = (r) => {
            const evt = `event: lockCountdown\ndata: ${JSON.stringify({ remaining: r })}\n\n`;
            for (const c of sseClients) { try { c.write(evt); } catch {} }
        };
        sendCountdown(remaining);
        lockTimer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(lockTimer);
                lockTimer = null;
                sendCountdown(0);
                // Lock immediately
                lockFlowActive = false;
                exec("rundll32.exe user32.dll,LockWorkStation", () => {});
                // Push intrusion alert after a short delay so photo capture has finished
                setTimeout(() => {
                    const intrusionEvt = `event: intrusion\ndata: ${JSON.stringify({ intrusion: true, timestamp: intrusionTs })}\n\n`;
                    for (const c of sseClients) { try { c.write(intrusionEvt); } catch {} }
                }, 4000);
            } else {
                sendCountdown(remaining);
            }
        }, 1000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
    }
    if (req.url === "/api/cancel-lock" && req.method === "POST") {
        if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
        lockFlowActive = false;
        const evt = `event: lockCountdown\ndata: ${JSON.stringify({ remaining: 0, cancelled: true })}\n\n`;
        for (const c of sseClients) { try { c.write(evt); } catch {} }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true,"cancelled":true}');
        return;
    }
    if (req.url === "/api/intrusion-status") {
        try {
            if (existsSync(INTRUSION_FILE)) {
                const data = JSON.parse(readFileSync(INTRUSION_FILE, "utf-8"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(data));
            } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"intrusion":false}');
            }
        } catch { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"intrusion":false}'); }
        return;
    }
    if (req.url === "/api/dismiss-intrusion" && req.method === "POST") {
        try {
            if (existsSync(INTRUSION_FILE)) {
                const data = JSON.parse(readFileSync(INTRUSION_FILE, "utf-8"));
                if (data.photo && existsSync(data.photo)) unlinkSync(data.photo);
                unlinkSync(INTRUSION_FILE);
            }
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
    }
    if (req.url.startsWith("/api/intrusion-photo")) {
        try {
            if (existsSync(INTRUSION_FILE)) {
                const data = JSON.parse(readFileSync(INTRUSION_FILE, "utf-8"));
                if (data.photo && existsSync(data.photo)) {
                    const img = readFileSync(data.photo);
                    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
                    res.end(img);
                    return;
                }
            }
        } catch {}
        res.writeHead(404);
        res.end();
        return;
    }
    if (req.url === "/api/clear-workspace" && req.method === "POST") {
        try {
            if (existsSync(WORKSPACE_FILE)) unlinkSync(WORKSPACE_FILE);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/reports") {
        try {
            const reports = listReports();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(reports));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/generate-reports" && req.method === "POST") {
        try {
            checkAndGenerateReports();
            const reports = listReports();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, weekly: reports.weekly.length, monthly: reports.monthly.length }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        return;
    }
    if (req.url === "/api/generate-single-report" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            try {
                const { type, startDate, endDate, label } = JSON.parse(body);
                if (!type || !startDate || !endDate) { res.writeHead(400); res.end('{"error":"Missing type, startDate, or endDate"}'); return; }
                const report = generateAndSaveSingleReport(type, startDate, endDate, label);
                if (report.error) { res.writeHead(400); res.end(JSON.stringify(report)); return; }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(report));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    if (req.url === "/api/generate-range-report" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            try {
                const { startDate, endDate } = JSON.parse(body);
                if (!startDate || !endDate) { res.writeHead(400); res.end('{"error":"Missing startDate or endDate"}'); return; }
                const report = generateRangeReport(startDate, endDate);
                if (report.error) { res.writeHead(400); res.end(JSON.stringify(report)); return; }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(report));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    if (req.url === "/api/generate-report-summary" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", async () => {
            try {
                const { type, startDate, endDate } = JSON.parse(body);
                if (!type || !startDate || !endDate) { res.writeHead(400); res.end('{"error":"Missing type, startDate, or endDate"}'); return; }
                // Find the report on disk
                const found = findReportFile(type, startDate, endDate);
                if (!found) { res.writeHead(404); res.end('{"error":"Report not found on disk"}'); return; }
                // Generate AI summary
                const result = await generateAISummary(found.data);
                if (result.error) { res.writeHead(500); res.end(JSON.stringify(result)); return; }
                // Save back to disk
                found.data.aiSummary = result.summary;
                found.data.aiSummaryGeneratedAt = new Date().toISOString();
                const tmp = found.path + "." + Date.now() + ".tmp";
                writeFileSync(tmp, JSON.stringify(found.data, null, 2));
                renameSync(tmp, found.path);
                invalidateReportsCache();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ summary: result.summary }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
        });
        return;
    }
    if (req.url === "/reports") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(cachedHtml("reports", reportsHtml));
        return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(cachedHtml("dashboard", dashboardHtml));
});

// Start server on preferred port, fall back to random if in use
await new Promise((resolve, reject) => {
    server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && PREFERRED_PORT !== 0) {
            // Saved port is busy — use random port
            server.listen(0, "127.0.0.1", () => {
                serverPort = server.address().port;
                try { writeFileSync(PORT_FILE, String(serverPort)); } catch {}
                resolve();
            });
        } else {
            reject(err);
        }
    });
    server.listen(PREFERRED_PORT, "127.0.0.1", () => {
        serverPort = server.address().port;
        try { writeFileSync(PORT_FILE, String(serverPort)); } catch {}
        resolve();
    });
});

// Periodic push of session state to all SSE clients
let _lastSsePayload = "";
let _lastSseCacheRef = null;
setInterval(() => {
    if (sseClients.size === 0) return;
    const sessions = scanSessions();
    // Avoid re-serializing if the cache reference hasn't changed
    if (sessions !== _lastSseCacheRef) {
        _lastSsePayload = `data: ${JSON.stringify(sessions)}\n\n`;
        _lastSseCacheRef = sessions;
    }
    for (const res of sseClients) {
        try { res.write(_lastSsePayload); } catch {}
    }
}, POLL_INTERVAL_MS);

// Auto-save workspace every minute (skip if no active sessions)
setInterval(autoSaveWorkspace, AUTO_SAVE_INTERVAL_MS);

// Auto-generate reports on startup (deferred so it doesn't block server) and every hour
const REPORT_GEN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setTimeout(async () => {
    try { checkAndGenerateReports(); } catch {}
    // After data reports exist, generate AI summaries for completed periods missing them
    try { await autoGenerateAISummaries(); } catch {}
}, 5000);
setInterval(async () => {
    try { checkAndGenerateReports(); } catch {}
    try { await autoGenerateAISummaries(); } catch {}
}, REPORT_GEN_INTERVAL_MS);

function openBrowser(url) {
    const cmd = process.platform === "win32" ? `start "" "${url}"`
        : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
}

// --- Session ---
const session = await joinSession({
    tools: [
        {
            name: "open_session_dashboard",
            description: "Opens the live session dashboard in the browser, showing real-time activity (messages, tool calls, errors) as a visual side UI.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            overridesBuiltInTool: true,
            handler: async () => {
                const url = `http://127.0.0.1:${serverPort}`;
                openBrowser(url);
                return `Session monitor opened at ${url}`;
            },
        },
        {
            name: "get_all_session_summaries",
            description: "Returns a structured summary of all active Copilot CLI sessions, including their goal, stage, progress, and current status. Use this when the user asks about the status of their sessions.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => {
                const sessions = scanSessions();
                const alive = sessions.filter(s => s.alive);
                if (alive.length === 0) return "No active sessions found.";
                const lines = alive.map(s => {
                    let out = `**${s.summary}** (${s.label})`;
                    if (s.goal) out += `\n  Goal: ${s.goal}`;
                    if (s.stage) out += `\n  Stage: ${s.stage}`;
                    if (s.progressNote) out += `\n  Progress: ${s.progressNote}`;
                    out += `\n  Stats: ${s.turns} turns, ${s.toolCalls} tools, ${s.taskCompletes} completed`;
                    if (s.cwd) out += `\n  Dir: ${s.cwd}`;
                    return out;
                });
                return lines.join("\n\n");
            },
        },
    ],
});
mainSession = session;

await session.log(`Session monitor running at http://127.0.0.1:${serverPort}`);
