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
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
        pid = $_.ProcessId
        parentPid = $_.ParentProcessId
        name = $_.Name
        startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })
        commandLine = $(if ($_.Name -match '^(copilot|node|cmd)\\.exe$') { $_.CommandLine } else { '' })
    }
})
@{bootId=$boot; processes=$processes} | ConvertTo-Json -Depth 4 -Compress
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
    const registrations = [];
    for (const observer of store.observers()) {
        if (observer.boot_id !== store.bootId || now - observer.heartbeat_at >= HEARTBEAT_TTL) continue;
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
        if (observer.boot_id !== store.bootId || now - observer.heartbeat_at >= HEARTBEAT_TTL) continue;
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
    constructor({ directory, bootId = null, now = Date.now, instanceId = randomUUID() }) {
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
        });
        if (bootId) this.setBoot(bootId);
    }

    setBoot(bootId) {
        if (!bootId) return;
        this.transaction(() => {
            const previousBoot = this.meta("boot");
            if (previousBoot && previousBoot !== bootId) {
                const saved = { version: 2, savedAt: new Date(this.now()).toISOString(), sessions: this.list().map(s => s.metadata) };
                this.db.prepare("INSERT OR IGNORE INTO checkpoints VALUES (?, ?, ?)")
                    .run(previousBoot, saved.savedAt, JSON.stringify(saved));
                this.db.prepare("UPDATE roster SET state='interrupted', error='Computer restarted before restore confirmation' WHERE state IN ('queued','launching')").run();
                this.db.prepare("DELETE FROM metadata WHERE key='coordinator'").run();
            }
            this.setMeta("boot", bootId);
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
        this.transaction(() => { for (const session of sessions) this.remember(session); });
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
            const lease = JSON.parse(this.meta("coordinator") || "null");
            if (lease && lease.owner !== this.instanceId && lease.expiresAt > this.now()) return false;
            this.setMeta("coordinator", JSON.stringify({ owner: this.instanceId, bootId: this.bootId, expiresAt: this.now() + LEASE_TTL }));
            return true;
        });
    }

    projectWorkspace() {
        if (!this.claimCoordinator()) return false;
        const sessions = this.list().map(row => ({
            ...row.metadata,
            lastOpenedAt: row.last_opened_at ? new Date(row.last_opened_at).toISOString() : null,
        }));
        let previous = null;
        try { previous = readJson(this.workspaceFile); } catch {}
        if (JSON.stringify(previous?.sessions) !== JSON.stringify(sessions) || previous?.bootId !== this.bootId) {
            const previousIds = (previous?.sessions || []).map(s => s.sessionId).sort();
            if (previous && JSON.stringify(previousIds) !== JSON.stringify(sessions.map(s => s.sessionId))) {
                for (let slot = 9; slot >= 0; slot--) {
                    const source = this.workspaceFile + (slot ? `.${slot}` : "");
                    if (existsSync(source)) copyFileSync(source, `${this.workspaceFile}.${slot + 1}`);
                }
            }
            atomicJson(this.workspaceFile, { version: 2, bootId: this.bootId, savedAt: new Date(this.now()).toISOString(), sessions });
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
