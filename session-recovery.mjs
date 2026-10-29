import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
    closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, mkdirSync,
    openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync,
} from "node:fs";

const execFileAsync = promisify(execFile);
const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HEARTBEAT_TTL = 25000;
const LEASE_TTL = 45000;
export const RESTORE_TIMEOUT = 180000;

export function validateSessionId(id) {
    if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error("Invalid session ID");
    return id;
}

function sessionMetadata(session) {
    const result = { sessionId: validateSessionId(session.sessionId || session.id) };
    for (const key of ["cwd", "summary", "branch", "repository"]) {
        result[key] = String(session[key] || "");
    }
    return result;
}

function workspaceMembership(sessions) {
    return [...new Set(sessions.map(session => session.sessionId))].sort().join("\n");
}

function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"));
}

function atomicJson(file, data) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx");
    try {
        writeFileSync(fd, JSON.stringify(data, null, 2));
        fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
}

export function processSessionId(commandLine) {
    const match = String(commandLine || "").match(/(?:^|\s)--(?:resume|session-id)(?:=|\s+)["']?([a-f0-9-]{36})(?=["'\s]|$)/i);
    return match && SESSION_ID.test(match[1]) ? match[1].toLowerCase() : null;
}

export async function readRuntimeProcesses() {
    if (process.platform !== "win32") {
        let bootId = null;
        try { bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
        return { bootId, processes: [], healthy: false, capturedAt: Date.now() };
    }
    const script = `
$ErrorActionPreference = 'Stop'
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
$bootCounter = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters' -Name BootId -ErrorAction SilentlyContinue).BootId
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
        pid = $_.ProcessId
        parentPid = $_.ParentProcessId
        name = $_.Name
        startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })
        commandLine = $(if ($_.Name -match '^(copilot|node|cmd)\\.exe$') { $_.CommandLine } else { '' })
    }
})
@{bootId=$(if ($null -ne $bootCounter) { "windows-boot-$bootCounter" } else { $boot }); bootStartedAt=$boot; processes=$processes} | ConvertTo-Json -Depth 4 -Compress
`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!result.bootId || !Array.isArray(result.processes)) throw new Error("Incomplete process discovery");
    return { ...result, healthy: true, capturedAt: Date.now() };
}

function isCliProcess(p) {
    return /^copilot(?:\.exe)?$/i.test(p.name)
        || (/^node(?:\.exe)?$/i.test(p.name) && /\bcopilot[^"'\s]*\.(?:m?js|cjs)\b/i.test(p.commandLine));
}

export function shareRuntime(runtime) {
    return {
        ...runtime,
        processes: runtime.processes.map(p => ({
            pid: p.pid, parentPid: p.parentPid, startedAt: p.startedAt,
            name: /^node(?:\.exe)?$/i.test(p.name) && isCliProcess(p) ? "copilot.exe" : p.name,
            commandLine: processSessionId(p.commandLine) ? `copilot --resume=${processSessionId(p.commandLine)}` : "",
        })),
    };
}

export function sessionPresence(store, id, runtime) {
    const now = store.now();
    const fresh = runtime?.healthy && now - runtime.capturedAt < HEARTBEAT_TTL;
    const processes = fresh ? runtime.processes : [];
    const sameBoot = observer => observer.boot_id === store.bootId
        || (runtime?.bootId === store.bootId
            && Math.abs(Date.parse(observer.boot_id) - Date.parse(runtime.bootStartedAt)) < 60000);
    const registrations = [];
    for (const observer of store.observers()) {
        if (!sameBoot(observer) || now - observer.heartbeat_at >= HEARTBEAT_TTL) continue;
        const p = processes.find(p => p.pid === observer.pid);
        if (!p || !(Math.abs(Date.parse(p.startedAt) - observer.started_at) < 2000)) continue;
        let host = p, ancestor = p;
        const seen = new Set([p.pid]);
        while (ancestor.parentPid && !seen.has(ancestor.parentPid)) {
            ancestor = processes.find(p => p.pid === ancestor.parentPid);
            if (!ancestor) break;
            seen.add(ancestor.pid);
            if (isCliProcess(ancestor)) { host = ancestor; break; }
        }
        registrations.push({ observer, host });
    }
    const registered = registrations.find(r => r.observer.session_id === id);
    if (registered) return { alive: true, pid: registered.host.pid, processStartedAt: registered.host.startedAt, liveness: "running", source: "registration" };
    const assignedElsewhere = p => registrations.some(r => r.host.pid === p.pid && r.observer.session_id !== id);
    const matching = processes.filter(p => processSessionId(p.commandLine) === id.toLowerCase());
    const cli = matching.find(p => isCliProcess(p) && !assignedElsewhere(p));
    if (cli) return { alive: true, pid: cli.pid, processStartedAt: cli.startedAt, liveness: "running", source: "process" };
    for (const observer of store.observers(id)) {
        if (!sameBoot(observer) || now - observer.heartbeat_at >= HEARTBEAT_TTL) continue;
        // A fresh SDK heartbeat remains useful on platforms without process enumeration.
        if (process.platform !== "win32" && !runtime?.healthy) {
            try {
                process.kill(observer.pid, 0);
                return { alive: true, pid: observer.pid, processStartedAt: new Date(observer.started_at).toISOString(), liveness: "running", source: "registration" };
            } catch {}
        }
    }
    if (fresh) {
        const directory = join(store.sessionDirectory, id);
        try {
            for (const file of readdirSync(directory)) {
                const match = file.match(/^inuse\.(\d+)\.lock$/);
                if (!match) continue;
                const p = processes.find(p => p.pid === Number(match[1]));
                const assigned = p && processSessionId(p.commandLine);
                if (p && isCliProcess(p) && !assignedElsewhere(p) && (!assigned || assigned === id.toLowerCase())
                    && Date.parse(p.startedAt) <= statSync(join(directory, file)).mtimeMs + 2000) {
                    return { alive: true, pid: p.pid, processStartedAt: p.startedAt, liveness: "running", source: "lock" };
                }
            }
        } catch {}
    }
    const starting = matching.find(p => /^cmd(?:\.exe)?$/i.test(p.name));
    if (starting) return { alive: false, pid: starting.pid, liveness: "starting", source: "launcher" };
    return { alive: false, pid: null, liveness: fresh ? "not-running" : "unknown", source: "discovery" };
}

async function readAppendedResumes(file, offset, since) {
    const fd = openSync(file, "r");
    let input, lines;
    try {
        const size = statSync(file).size;
        if (offset > size) offset = 0;
        if (offset === size) return { offset, confirmed: false };
        const start = offset;
        input = createReadStream(file, { start: offset, end: size - 1, encoding: "utf8" });
        lines = createInterface({ input, crlfDelay: Infinity });
        let confirmed = false;
        for await (const line of lines) {
            const length = Buffer.byteLength(line, "utf8");
            const delimiter = Buffer.alloc(2);
            readSync(fd, delimiter, 0, Math.min(2, Math.max(0, size - offset - length)), offset + length);
            const newline = delimiter[0] === 10 ? 1 : delimiter[0] === 13 && delimiter[1] === 10 ? 2 : 0;
            if (!newline) break; // A partially appended JSON record is not evidence yet.
            offset += length + newline;
            if (line.includes("session.resume")) {
                try {
                    const event = JSON.parse(line);
                    if (event.type === "session.resume" && Date.parse(event.timestamp) >= since) confirmed = true;
                } catch {}
            }
            if (offset - start >= 4 * 1024 * 1024) break;
        }
        return { offset, confirmed };
    } finally {
        lines?.close();
        input?.destroy();
        closeSync(fd);
    }
}

export class RecoveryStore {
    constructor({ directory, bootId = null, bootStartedAt = null, now = Date.now, instanceId = randomUUID() }) {
        this.directory = directory;
        this.sessionDirectory = join(directory, "session-state");
        this.workspaceFile = join(directory, "saved-workspace.json");
        this.now = now;
        this.bootId = bootId || "unknown";
        this.instanceId = instanceId;
        mkdirSync(directory, { recursive: true });
        this.db = new DatabaseSync(join(directory, "session-recovery.db"));
        this.db.exec(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS roster (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, forgotten_at INTEGER,
                last_opened_at INTEGER, last_observed_at INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'idle', error TEXT,
                attempt_id TEXT, attempt_at INTEGER, attempt_boot TEXT,
                event_offset INTEGER NOT NULL DEFAULT 0, resume_confirmed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS observers (
                instance_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pid INTEGER NOT NULL,
                started_at INTEGER NOT NULL, boot_id TEXT NOT NULL, heartbeat_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS journal (
                seq INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
                action TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS checkpoints (
                boot_id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspace_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT, boot_id TEXT, saved_at TEXT NOT NULL,
                source TEXT NOT NULL, payload TEXT NOT NULL
            );
        `);
        this.transaction(() => {
            if (!this.meta("initialized")) {
                for (let slot = 10; slot >= 0; slot--) {
                    try {
                        const saved = readJson(this.workspaceFile + (slot ? `.${slot}` : ""));
                        for (const session of saved.sessions || []) {
                            try { this.remember(session); }
                            catch (error) { console.warn("Recovery entry import:", error.message); }
                        }
                    } catch (error) {
                        if (error.code !== "ENOENT") console.warn("Recovery snapshot import:", error.message);
                    }
                }
                this.setMeta("initialized", "1");
            }
            if (!this.meta("baseline-created")) {
                if (this.list().length) {
                    const saved = { version: 2, savedAt: new Date(now()).toISOString(), sessions: this.list().map(s => s.metadata) };
                    this.db.prepare("INSERT OR IGNORE INTO checkpoints VALUES (?, ?, ?)")
                        .run("legacy-import", saved.savedAt, JSON.stringify(saved));
                }
                this.setMeta("baseline-created", "1");
            }
            if (!this.meta("open-tabs:initialized")) {
                const snapshots = [];
                for (let slot = 0; slot <= 10; slot++) {
                    try {
                        const saved = readJson(this.workspaceFile + (slot ? `.${slot}` : ""));
                        // Version 2 projected the entire archive, not the open tabs.
                        if (saved.version === 2 || !Array.isArray(saved.sessions) || !Number.isFinite(Date.parse(saved.savedAt))) continue;
                        const sessions = saved.sessions.filter(session => this.canRestore(session)).map(sessionMetadata);
                        if (sessions.length || saved.sessions.length === 0) snapshots.push({ savedAt: saved.savedAt, sessions });
                    } catch {}
                }
                snapshots.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
                if (snapshots.length) {
                    const snapshot = { ...snapshots[0], source: "legacy-snapshot" };
                    this.setMeta("open-tabs:saved", JSON.stringify(snapshot));
                    if (bootId && Date.parse(snapshot.savedAt) >= Date.parse(bootStartedAt)) {
                        this.setMeta("open-tabs:live", JSON.stringify({ ...snapshot, bootId }));
                    }
                }
                this.setMeta("open-tabs:initialized", "1");
            }
            this.migrateWorkspaceHistory();
        });
        if (bootId) this.setBoot(bootId, bootStartedAt);
    }

    migrateWorkspaceHistory() {
        if (this.meta("workspace-history:initialized")) return;
        const snapshots = new Map();
        const collect = (snapshot, source = "legacy-backup") => {
            if (!snapshot || snapshot.version === 2 || !Array.isArray(snapshot.sessions)
                || !Number.isFinite(Date.parse(snapshot.savedAt))) return null;
            const sessions = [];
            for (const session of snapshot.sessions) {
                try { sessions.push(sessionMetadata(session)); } catch {}
            }
            // Never turn an unreadable historical group into a confirmed empty workspace.
            if (snapshot.sessions.length && !sessions.length) return null;
            const normalized = { ...snapshot, sessions, source, bootId: snapshot.bootId || null };
            const key = JSON.stringify([normalized.bootId, normalized.savedAt, workspaceMembership(sessions)]);
            snapshots.set(key, normalized);
            return key;
        };
        for (let slot = 10; slot >= 0; slot--) {
            try { collect(readJson(this.workspaceFile + (slot ? `.${slot}` : ""))); } catch {}
        }
        for (const checkpoint of this.checkpoints()) {
            collect({ ...checkpoint.data, bootId: checkpoint.bootId }, "previous-boot");
        }
        const legacyLive = JSON.parse(this.meta("open-tabs:live") || "null");
        const legacySaved = JSON.parse(this.meta("open-tabs:saved") || "null");
        const liveKey = collect(legacyLive, "live");
        const savedKey = collect(legacySaved, legacySaved?.source || "legacy-snapshot");
        const ids = new Map();
        for (const [key, snapshot] of [...snapshots].sort((a, b) => Date.parse(a[1].savedAt) - Date.parse(b[1].savedAt))) {
            ids.set(key, this.recordWorkspace(snapshot).snapshotId);
        }
        if (liveKey) this.setMeta("workspace-history:live", String(ids.get(liveKey)));
        if (savedKey) {
            const target = legacySaved.source === "previous-boot" ? "previous" : "saved";
            this.setMeta(`workspace-history:${target}`, String(ids.get(savedKey)));
        }
        const previousBoot = this.meta("open-tabs:boot") || legacyLive?.bootId;
        if (previousBoot) this.setMeta("workspace-history:boot", previousBoot);
        this.setMeta("workspace-history:initialized", "1");
    }

    setBoot(bootId, bootStartedAt = null) {
        if (!bootId) return;
        this.transaction(() => {
            const previousBoot = this.meta("workspace-history:boot");
            if (previousBoot && previousBoot !== bootId) {
                const sameBoot = Math.abs(Date.parse(previousBoot) - Date.parse(bootStartedAt)) < 60000;
                if (!sameBoot) {
                    const live = this.liveWorkspace();
                    if (live.snapshotId) {
                        const saved = { ...live, version: 3, source: "previous-boot" };
                        this.setMeta("workspace-history:previous", String(live.snapshotId));
                        this.db.prepare("INSERT OR IGNORE INTO checkpoints VALUES (?, ?, ?)")
                            .run(previousBoot, saved.savedAt, JSON.stringify(saved));
                    }
                    this.db.prepare("DELETE FROM metadata WHERE key IN ('workspace-history:live','workspace-history:captured-at')").run();
                    this.db.prepare("UPDATE roster SET state='interrupted', error='Computer restarted before restore confirmation' WHERE state IN ('queued','launching')").run();
                    this.db.prepare("DELETE FROM metadata WHERE key='workspace-history:coordinator'").run();
                }
            }
            this.setMeta("workspace-history:boot", bootId);
            this.bootId = bootId;
        });
    }

    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    meta(key) { return this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value; }
    setMeta(key, value) { this.db.prepare("INSERT OR REPLACE INTO metadata VALUES (?, ?)").run(key, value); }
    log(action, id, payload = {}) {
        this.db.prepare("INSERT INTO journal(timestamp,action,session_id,payload) VALUES (?,?,?,?)")
            .run(this.now(), action, id, JSON.stringify(payload));
    }

    remember(session, openedAt = null) {
        const incoming = sessionMetadata(session);
        const row = this.db.prepare("SELECT * FROM roster WHERE id=?").get(incoming.sessionId);
        if (row?.forgotten_at != null && (!openedAt || openedAt <= row.forgotten_at)) return;
        const previous = row ? JSON.parse(row.payload) : {};
        const metadata = { ...previous, sessionId: incoming.sessionId };
        for (const key of ["cwd", "summary", "branch", "repository"]) {
            if (incoming[key] || !metadata[key]) metadata[key] = incoming[key];
        }
        const payload = JSON.stringify(metadata);
        this.db.prepare(`INSERT INTO roster(id,payload,last_opened_at,last_observed_at) VALUES (?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, forgotten_at=NULL,
                last_observed_at=excluded.last_observed_at,
                last_opened_at=MAX(COALESCE(roster.last_opened_at,0),COALESCE(excluded.last_opened_at,0))`)
            .run(metadata.sessionId, payload, openedAt, this.now());
        if (!row || row.payload !== payload || (openedAt && openedAt > (row.last_opened_at || 0))) {
            this.log(openedAt ? "opened" : "observed", metadata.sessionId, { ...metadata, openedAt });
        }
    }

    observe(sessions) {
        this.transaction(() => {
            for (const session of sessions) {
                if (this.canRestore(session)) this.remember(session);
            }
        });
    }

    include(sessions) {
        this.transaction(() => {
            for (const session of sessions) {
                const id = validateSessionId(session.sessionId || session.id);
                const forgotten = this.db.prepare("SELECT forgotten_at FROM roster WHERE id=?").get(id)?.forgotten_at;
                this.db.prepare("UPDATE roster SET forgotten_at=NULL WHERE id=?").run(id);
                this.remember(session);
                if (forgotten != null) this.log("included", id);
            }
        });
    }

    register(session, { pid, startedAt, openedAt = this.now() }) {
        this.transaction(() => {
            this.remember(session, openedAt);
            this.db.prepare(`INSERT OR REPLACE INTO observers VALUES (?,?,?,?,?,?)`)
                .run(this.instanceId, session.sessionId || session.id, pid, startedAt, this.bootId, this.now());
        });
    }

    heartbeat() {
        this.db.prepare("UPDATE observers SET heartbeat_at=? WHERE instance_id=?").run(this.now(), this.instanceId);
    }

    observers(id) {
        return id
            ? this.db.prepare("SELECT * FROM observers WHERE session_id=?").all(id)
            : this.db.prepare("SELECT * FROM observers").all();
    }

    list() {
        return this.db.prepare("SELECT * FROM roster WHERE forgotten_at IS NULL ORDER BY id").all()
            .map(row => ({ ...row, metadata: JSON.parse(row.payload) }));
    }

    canRestore(session) {
        try {
            const id = validateSessionId(session.sessionId || session.id);
            return Boolean(session.cwd && statSync(session.cwd).isDirectory()
                && statSync(join(this.sessionDirectory, id, "events.jsonl")).isFile());
        } catch { return false; }
    }

    observeWorkspace(runtime) {
        if (!runtime?.healthy || !Array.isArray(runtime.processes) || !Number.isFinite(runtime.capturedAt)
            || runtime.bootId !== this.bootId || this.now() - runtime.capturedAt >= HEARTBEAT_TTL) return false;
        return this.transaction(() => {
            if (this.meta("workspace-history:boot") !== runtime.bootId
                || runtime.capturedAt < Number(this.meta("workspace-history:captured-at") || 0)) return false;
            const sessions = this.list().filter(row => this.canRestore(row.metadata)
                && sessionPresence(this, row.id, runtime).alive).map(row => row.metadata);
            const previous = this.liveWorkspace();
            if (!previous.snapshotId || workspaceMembership(previous.sessions) !== workspaceMembership(sessions)) {
                const snapshot = this.recordWorkspace({
                    bootId: this.bootId, savedAt: new Date(runtime.capturedAt).toISOString(), source: "live", sessions,
                });
                this.setMeta("workspace-history:live", String(snapshot.snapshotId));
            }
            this.setMeta("workspace-history:captured-at", String(runtime.capturedAt));
            return true;
        });
    }

    saveWorkspace() {
        return this.transaction(() => {
            const live = this.liveWorkspace();
            if (!live.snapshotId || this.meta("workspace-history:boot") !== this.bootId) {
                throw new Error("No confirmed open-tab snapshot is available");
            }
            const current = new Map(this.list().map(row => [row.id, row.metadata]));
            const saved = this.recordWorkspace({
                ...live, bootId: this.bootId, savedAt: new Date(this.now()).toISOString(), source: "manual-save",
                sessions: live.sessions.map(session => current.get(session.sessionId) || session),
            });
            this.setMeta("workspace-history:saved", String(saved.snapshotId));
            return saved;
        });
    }

    recordWorkspace({ bootId = null, savedAt, source, sessions }) {
        sessions = [...new Map(sessions.map(session => {
            const metadata = sessionMetadata(session);
            return [metadata.sessionId, metadata];
        })).values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        const result = this.db.prepare("INSERT INTO workspace_snapshots(boot_id,saved_at,source,payload) VALUES (?,?,?,?)")
            .run(bootId, savedAt, source, JSON.stringify(sessions));
        return { snapshotId: Number(result.lastInsertRowid), bootId, savedAt, source, sessions, count: sessions.length };
    }

    workspaceSnapshot(snapshotId) {
        if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) throw new Error("Invalid workspace snapshot ID");
        const row = this.db.prepare("SELECT * FROM workspace_snapshots WHERE id=?").get(snapshotId);
        if (!row) return null;
        const sessions = JSON.parse(row.payload);
        return { snapshotId: row.id, bootId: row.boot_id, savedAt: row.saved_at, source: row.source, sessions, count: sessions.length };
    }

    workspaceHistory({ before = null, limit = 50 } = {}) {
        if ((before !== null && (!Number.isSafeInteger(before) || before < 1))
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid workspace history page");
        const rows = this.db.prepare("SELECT id FROM workspace_snapshots WHERE id<? ORDER BY id DESC LIMIT ?")
            .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
        const snapshots = rows.slice(0, limit).map(row => this.workspaceSnapshot(row.id));
        return { snapshots, nextBefore: rows.length > limit ? snapshots.at(-1).snapshotId : null };
    }

    liveWorkspace() {
        const id = this.meta("workspace-history:live");
        return (id && this.workspaceSnapshot(Number(id)))
            || { snapshotId: null, savedAt: "", source: "none", bootId: this.bootId, sessions: [], count: 0 };
    }

    workspace() {
        const savedId = this.meta("workspace-history:saved");
        const previousId = this.meta("workspace-history:previous");
        const saved = savedId ? this.workspaceSnapshot(Number(savedId))
            : previousId ? { ...this.workspaceSnapshot(Number(previousId)), source: "previous-boot" } : this.liveWorkspace();
        const retained = new Map(this.list().map(row => [row.id, row.metadata]));
        const sessions = (saved?.sessions || []).filter(session => retained.has(session.sessionId) && this.canRestore(session))
            .map(session => ({ ...session, ...retained.get(session.sessionId) }))
            .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        return {
            snapshotId: saved?.snapshotId || null, savedAt: saved?.savedAt || "", source: saved?.source || "none",
            bootId: saved?.bootId || null, sessions, count: sessions.length,
        };
    }

    forget(ids) {
        ids = (Array.isArray(ids) ? ids : [ids]).map(validateSessionId);
        this.transaction(() => {
            for (const id of ids) {
                this.db.prepare("UPDATE roster SET forgotten_at=? WHERE id=?").run(this.now(), id);
                this.log("forgotten", id);
            }
        });
    }

    claimCoordinator() {
        return this.transaction(() => {
            const lease = JSON.parse(this.meta("workspace-history:coordinator") || "null");
            if (lease && lease.owner !== this.instanceId && lease.expiresAt > this.now()) return false;
            this.setMeta("workspace-history:coordinator", JSON.stringify({ owner: this.instanceId, bootId: this.bootId, expiresAt: this.now() + LEASE_TTL }));
            return true;
        });
    }

    projectWorkspace() {
        if (!this.claimCoordinator()) return false;
        const workspace = this.workspace();
        const sessions = workspace.sessions;
        let previous = null;
        try { previous = readJson(this.workspaceFile); } catch {}
        if (JSON.stringify(previous?.sessions) !== JSON.stringify(sessions) || previous?.version !== 3 || previous?.savedAt !== workspace.savedAt) {
            const previousIds = (previous?.sessions || []).map(s => s.sessionId).sort();
            if (previous && JSON.stringify(previousIds) !== JSON.stringify(sessions.map(s => s.sessionId))) {
                for (let slot = 9; slot >= 0; slot--) {
                    const source = this.workspaceFile + (slot ? `.${slot}` : "");
                    if (existsSync(source)) copyFileSync(source, `${this.workspaceFile}.${slot + 1}`);
                }
            }
            atomicJson(this.workspaceFile, { version: 3, ...workspace });
        }
        const checkpointDirectory = join(this.directory, "workspace-checkpoints");
        mkdirSync(checkpointDirectory, { recursive: true });
        for (const checkpoint of this.checkpoints()) {
            const file = join(checkpointDirectory, `${checkpoint.bootId.replace(/[^a-z0-9-]/gi, "_")}.json`);
            if (!existsSync(file)) atomicJson(file, checkpoint.data);
        }
        return true;
    }

    checkpoints() {
        return this.db.prepare("SELECT * FROM checkpoints ORDER BY saved_at DESC").all()
            .map(row => ({ bootId: row.boot_id, savedAt: row.saved_at, data: JSON.parse(row.payload) }));
    }

    queue(ids, runtime) {
        return this.transaction(() => ids.map(id => {
            validateSessionId(id);
            const row = this.db.prepare("SELECT * FROM roster WHERE id=? AND forgotten_at IS NULL").get(id);
            if (!row) return { id, state: "failed", error: "Session is not in the recovery roster" };
            if (row.attempt_boot === this.bootId && ["queued", "launching"].includes(row.state)) return { id, state: row.state };
            const presence = sessionPresence(this, id, runtime);
            if (presence.alive || presence.liveness === "starting") return { id, state: "already-running" };
            if (presence.liveness === "unknown") {
                const error = "Process discovery is unavailable; refusing a possible duplicate launch";
                this.db.prepare("UPDATE roster SET state='failed',error=? WHERE id=?").run(error, id);
                this.log("failed", id, { error });
                return { id, state: "failed", error };
            }
            const session = JSON.parse(row.payload);
            const history = join(this.sessionDirectory, id, "events.jsonl");
            let error;
            if (!existsSync(history)) error = "Session history is missing";
            else if (!session.cwd || !existsSync(session.cwd) || !statSync(session.cwd).isDirectory()) error = "Original working directory is missing";
            const state = error ? "failed" : "queued";
            this.db.prepare("UPDATE roster SET state=?,error=?,attempt_id=?,attempt_at=?,attempt_boot=?,resume_confirmed=0,event_offset=0 WHERE id=?")
                .run(state, error || null, randomUUID(), this.now(), this.bootId, id);
            this.log(state, id, { error });
            return { id, state, error };
        }));
    }

    setRestoreState(row, state, error = null) {
        this.transaction(() => {
            const result = this.db.prepare("UPDATE roster SET state=?,error=? WHERE id=? AND attempt_id=?")
                .run(state, error, row.id, row.attempt_id);
            if (result.changes) this.log(state, row.id, { error });
        });
    }

    async tickRestores(runtime, launch, { concurrency = 2, timeout = RESTORE_TIMEOUT } = {}) {
        if (!this.claimCoordinator()) return;
        let active = this.list().filter(row => row.state === "launching" && row.attempt_boot === this.bootId);
        for (const row of active) {
            try {
                const progress = await readAppendedResumes(join(this.sessionDirectory, row.id, "events.jsonl"), row.event_offset, row.attempt_at);
                const confirmed = row.resume_confirmed || progress.confirmed;
                this.db.prepare("UPDATE roster SET event_offset=?,resume_confirmed=? WHERE id=? AND attempt_id=?")
                    .run(progress.offset, Number(Boolean(confirmed)), row.id, row.attempt_id);
                const presence = sessionPresence(this, row.id, runtime);
                if (confirmed && presence.alive) this.setRestoreState(row, "resumed");
                else if (this.now() - row.attempt_at >= timeout) {
                    this.setRestoreState(row, presence.liveness === "not-running" ? "failed" : "unconfirmed",
                        "Timed out waiting for both a fresh resume event and the running session; no automatic retry");
                }
            } catch (error) { this.setRestoreState(row, "failed", error.message); }
        }
        active = this.list().filter(row => row.state === "launching" && row.attempt_boot === this.bootId);
        const queued = this.list().filter(row => row.state === "queued" && row.attempt_boot === this.bootId);
        for (const row of queued.slice(0, Math.max(0, concurrency - active.length))) {
            if (!this.claimCoordinator()) return;
            const presence = sessionPresence(this, row.id, runtime);
            if (presence.alive || presence.liveness === "starting") {
                this.setRestoreState(row, "already-running");
                continue;
            }
            if (presence.liveness === "unknown") continue;
            try {
                const session = row.metadata;
                if (!session.cwd || !statSync(session.cwd).isDirectory()) throw new Error("Original working directory is missing");
                const offset = statSync(join(this.sessionDirectory, row.id, "events.jsonl")).size;
                const claimed = this.transaction(() => this.db.prepare(`UPDATE roster SET state='launching',attempt_at=?,event_offset=?
                    WHERE id=? AND attempt_id=? AND state='queued' AND forgotten_at IS NULL
                    AND (SELECT COUNT(*) FROM roster WHERE state='launching' AND forgotten_at IS NULL AND attempt_boot=?) < ?`)
                    .run(this.now(), offset, row.id, row.attempt_id, this.bootId, concurrency).changes);
                if (!claimed) continue;
                this.log("launching", row.id);
                await launch(session);
            } catch (error) { this.setRestoreState(row, "failed", error.message); }
        }
    }

    close() { this.db.close(); }
}

export async function launchSessionTab(session, command) {
    const id = validateSessionId(session.sessionId);
    if (process.platform !== "win32") throw new Error("Terminal launching currently requires Windows Terminal");
    const title = `Copilot: ${(session.summary || id.slice(0, 8)).slice(0, 60)}`.replace(/[";\r\n]/g, " ");
    await execFileAsync("wt.exe", ["-w", "0", "new-tab", "--title", title, "-d", session.cwd, "cmd", "/k", `${command} --resume=${id}`], {
        windowsHide: true, timeout: 15000,
    });
}

export async function findSessionsResumed(sessionDirectory, { start, end }, metadataFor = () => ({})) {
    const from = Date.parse(start), to = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 48 * 60 * 60 * 1000) {
        throw new Error("Supply a valid date range of at most 48 hours");
    }
    const results = [];
    for (const id of readdirSync(sessionDirectory)) {
        if (!SESSION_ID.test(id)) continue;
        const file = join(sessionDirectory, id, "events.jsonl");
        try {
            if (statSync(file).mtimeMs < from) continue;
        } catch { continue; }
        const input = createReadStream(file, { encoding: "utf8" });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let found = null;
        let lineNumber = 0;
        try {
            for await (const line of lines) {
                lineNumber++;
                if (!line.includes("session.resume")) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                const timestamp = Date.parse(event.timestamp);
                if (event.type !== "session.resume" || !(timestamp >= from && timestamp < to)) continue;
                if (!found) {
                    const meta = metadataFor(id);
                    found = { ...sessionMetadata({ ...meta, sessionId: id }), firstResumedAt: event.timestamp, lastResumedAt: event.timestamp, count: 0, evidenceLine: lineNumber };
                    found.cwd ||= event.data?.context?.cwd || "";
                }
                if (timestamp < Date.parse(found.firstResumedAt)) found.firstResumedAt = event.timestamp;
                if (timestamp > Date.parse(found.lastResumedAt)) found.lastResumedAt = event.timestamp;
                found.count++;
            }
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        } finally {
            lines.close();
            input.destroy();
        }
        if (found) results.push(found);
    }
    return results.sort((a, b) => a.firstResumedAt.localeCompare(b.firstResumedAt));
}
