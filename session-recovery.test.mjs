import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryStore, findSessionsResumed, processSessionId, sessionPresence, shareRuntime } from "./session-recovery.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resume = timestamp => JSON.stringify({ type: "session.resume", timestamp: new Date(timestamp).toISOString() }) + "\n";

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "copilot-recovery-"));
    let time = Date.parse("2030-01-02T12:00:00Z");
    const stores = [];
    mkdirSync(join(directory, "session-state"));
    t.after(() => {
        for (const store of stores) store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        directory,
        now: () => time,
        advance: ms => { time += ms; },
        store(bootId = "boot-a") {
            const store = new RecoveryStore({ directory, bootId, now: () => time });
            stores.push(store);
            return store;
        },
        session(n, events = "") {
            const session = { sessionId: id(n), summary: `Session ${n}`, cwd: directory };
            const path = join(directory, "session-state", session.sessionId);
            mkdirSync(path, { recursive: true });
            writeFileSync(join(path, "events.jsonl"), events);
            return session;
        },
        history(n) { return join(directory, "session-state", id(n), "events.jsonl"); },
        runtime(processes = [], healthy = true) { return { bootId: "boot-a", capturedAt: time, healthy, processes }; },
        process(n, pid = n) { return { pid, name: "copilot.exe", commandLine: `copilot --resume=${id(n)}`, startedAt: new Date(time - 5000).toISOString() }; },
    };
}

test("imports the union of legacy snapshots and keeps an immutable migration baseline", t => {
    const f = fixture(t);
    t.mock.method(console, "warn", () => {});
    writeFileSync(join(f.directory, "saved-workspace.json.10"), "{invalid");
    writeFileSync(join(f.directory, "saved-workspace.json.1"), JSON.stringify({ sessions: [f.session(1), { sessionId: "../bad" }, f.session(2)] }));
    writeFileSync(join(f.directory, "saved-workspace.json"), JSON.stringify({ sessions: [f.session(3)] }));
    const store = f.store();
    assert.deepEqual(store.list().map(r => r.id), [id(1), id(2), id(3)]);
    store.forget(id(1));
    const second = f.store();
    assert.deepEqual(second.list().map(r => r.id), [id(2), id(3)]);
    assert.equal(second.checkpoints().find(c => c.bootId === "legacy-import").data.sessions.length, 3);
});

test("empty, partial, and late scans cannot shrink membership; forgetting is explicit", t => {
    const f = fixture(t), store = f.store();
    store.observe([f.session(1), f.session(2)]);
    f.advance(600000);
    store.observe([]);
    store.observe([f.session(1)]);
    assert.equal(store.list().length, 2);
    store.forget(id(1));
    store.observe([f.session(1)]);
    assert.deepEqual(store.list().map(r => r.id), [id(2)]);
    f.advance(1);
    store.register(f.session(1), { pid: 123, startedAt: f.now() });
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[0].last_opened_at, f.now());
});

test("upgrading an existing recovery database backfills the baseline without replacing it", t => {
    const f = fixture(t), before = f.store();
    before.observe([f.session(1), f.session(2)]);
    before.db.prepare("DELETE FROM metadata WHERE key='baseline-created'").run();
    const after = f.store();
    assert.equal(after.checkpoints().find(c => c.bootId === "legacy-import").data.sessions.length, 2);
    after.forget(id(1));
    f.store();
    assert.equal(after.checkpoints().find(c => c.bootId === "legacy-import").data.sessions.length, 2);
});

test("connections share membership and a single expiring coordinator lease", t => {
    const f = fixture(t), a = f.store(), b = f.store();
    a.observe([f.session(1)]);
    b.observe([f.session(2)]);
    assert.equal(a.claimCoordinator(), true);
    assert.equal(b.claimCoordinator(), false);
    assert.equal(a.projectWorkspace(), true);
    assert.equal(b.projectWorkspace(), false);
    assert.equal(JSON.parse(readFileSync(a.workspaceFile)).sessions.length, 2);
    a.observe([f.session(2), f.session(1)]);
    a.projectWorkspace();
    assert.equal(existsSync(a.workspaceFile + ".1"), false, "ordering alone must not rotate");
    f.advance(45001);
    assert.equal(b.claimCoordinator(), true);
    assert.equal(a.claimCoordinator(), false);
    b.observe([f.session(3)]);
    b.projectWorkspace();
    assert.equal(JSON.parse(readFileSync(a.workspaceFile + ".1")).sessions.length, 2);
});

test("previous-boot checkpoints survive observations, forgetting, and rolling backup churn", t => {
    const f = fixture(t), before = f.store();
    before.observe([f.session(1), f.session(2)]);
    before.queue([id(1)], f.runtime());
    before.projectWorkspace();
    const after = f.store("boot-b");
    assert.equal(after.list()[0].state, "interrupted");
    const checkpoint = after.checkpoints().find(c => c.bootId === "boot-a");
    assert.equal(checkpoint.data.sessions.length, 2);
    after.forget(id(1));
    for (let n = 3; n < 16; n++) {
        after.observe([f.session(n)]);
        after.projectWorkspace();
    }
    assert.deepEqual(after.checkpoints().find(c => c.bootId === "boot-a"), checkpoint);
    assert.equal(readdirSync(join(f.directory, "workspace-checkpoints")).length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.directory, "workspace-checkpoints", "boot-a.json"))).sessions.length, 2);
});

test("a delayed boot lookup checkpoints the old roster before registering the new session", t => {
    const f = fixture(t), before = f.store();
    before.observe([f.session(1)]);
    const after = f.store(null);
    assert.equal(after.bootId, "unknown");
    after.setBoot("boot-b");
    after.register(f.session(2), { pid: 123, startedAt: f.now() });
    assert.deepEqual(after.checkpoints()[0].data.sessions.map(s => s.sessionId), [id(1)]);
});

test("SDK process identity rejects reused PIDs and returns the CLI host rather than the extension", t => {
    const f = fixture(t), store = f.store(), session = f.session(1);
    store.register(session, { pid: 101, startedAt: f.now() - 1000 });
    const host = { ...f.process(1, 100), commandLine: "copilot" };
    const child = { pid: 101, parentPid: 100, name: "node.exe", startedAt: new Date(f.now() - 1000).toISOString() };
    const presence = sessionPresence(store, id(1), f.runtime([host, child]));
    assert.equal(presence.source, "registration");
    assert.equal(presence.pid, 100);
    child.startedAt = new Date(f.now() + 20000).toISOString();
    assert.equal(sessionPresence(store, id(1), f.runtime([host, child])).alive, false);
    child.startedAt = "";
    assert.equal(sessionPresence(store, id(1), f.runtime([host, child])).alive, false);
    assert.equal(sessionPresence(store, id(1), f.runtime([], false)).liveness, "unknown");
    f.advance(25001);
    assert.equal(sessionPresence(store, id(1), f.runtime([host, child])).alive, false);
});

test("a current SDK session supersedes stale resume arguments after an in-place session switch", t => {
    const f = fixture(t), store = f.store();
    store.register(f.session(2), { pid: 101, startedAt: f.now() - 1000 });
    const runtime = f.runtime([f.process(1, 100), { pid: 101, parentPid: 100, name: "node.exe", startedAt: new Date(f.now() - 1000).toISOString() }]);
    assert.equal(sessionPresence(store, id(2), runtime).pid, 100);
    assert.equal(sessionPresence(store, id(1), runtime).alive, false);
    const shared = shareRuntime(runtime);
    assert.equal(sessionPresence(store, id(2), shared).alive, true);
    assert.equal(JSON.stringify(shared).includes("secret"), false);
    const node = f.runtime([{ ...f.process(3), name: "node.exe", commandLine: `node copilot.js --resume ${id(3)} --secret do-not-persist` }]);
    assert.equal(sessionPresence(store, id(3), shareRuntime(node)).alive, true);
    assert.equal(JSON.stringify(shareRuntime(node)).includes("do-not-persist"), false);
});

test("legacy locks require a CLI process whose birth predates the lock", t => {
    const f = fixture(t), store = f.store();
    f.session(1);
    const lock = join(f.directory, "session-state", id(1), "inuse.77.lock");
    writeFileSync(lock, "");
    utimesSync(lock, f.now() / 1000, f.now() / 1000);
    const p = { ...f.process(1, 77), commandLine: "copilot" };
    assert.equal(sessionPresence(store, id(1), f.runtime([p])).source, "lock");
    p.startedAt = new Date(f.now() + 3000).toISOString();
    assert.equal(sessionPresence(store, id(1), f.runtime([p])).alive, false);
    p.name = "unrelated.exe";
    p.startedAt = new Date(f.now() - 3000).toISOString();
    assert.equal(sessionPresence(store, id(1), f.runtime([p])).alive, false);
});

test("restore requests deduplicate across connections and fail visibly on missing prerequisites", t => {
    const f = fixture(t), a = f.store(), b = f.store();
    a.observe([f.session(1), { sessionId: id(2), cwd: f.directory }, { ...f.session(3), cwd: join(f.directory, "missing") }, f.session(4)]);
    assert.equal(a.queue([id(1)], f.runtime())[0].state, "queued");
    const token = a.list()[0].attempt_id;
    assert.equal(b.queue([id(1)], f.runtime())[0].state, "queued");
    assert.equal(a.list()[0].attempt_id, token);
    assert.match(a.queue([id(2)], f.runtime())[0].error, /history/);
    assert.match(a.queue([id(3)], f.runtime())[0].error, /directory/);
    assert.match(a.queue([id(4)], f.runtime([], false))[0].error, /discovery/);
    assert.equal(a.queue([id(4)], f.runtime([f.process(4)]))[0].state, "already-running");
    assert.equal(a.queue([id(4)], f.runtime([{ ...f.process(4), name: "cmd.exe" }]))[0].state, "already-running");
    assert.throws(() => a.queue(["../invalid"], f.runtime()), /Invalid session ID/);
});

test("restores are bounded, require fresh event plus presence, and do not automatically retry", async t => {
    const f = fixture(t), a = f.store(), b = f.store();
    a.observe([f.session(1, resume(f.now() - 1000)), f.session(2), f.session(3)]);
    a.queue([id(1), id(2), id(3)], f.runtime());
    const launched = [];
    const launch = async s => { launched.push(s.sessionId); };
    await a.tickRestores(f.runtime(), launch);
    assert.deepEqual(launched, [id(1), id(2)]);
    await b.tickRestores(f.runtime(), launch);
    assert.equal(launched.length, 2);
    await a.tickRestores(f.runtime([f.process(1)]), launch);
    assert.equal(a.list()[0].state, "launching", "old events cannot confirm a launch");
    appendFileSync(f.history(1), resume(f.now()));
    await a.tickRestores(f.runtime([f.process(1)]), launch);
    assert.equal(a.list()[0].state, "resumed");
    assert.equal(launched.length, 3);
    f.advance(180001);
    await a.tickRestores(f.runtime([f.process(2)]), launch);
    assert.equal(a.list()[1].state, "unconfirmed");
    assert.equal(a.list()[2].state, "failed");
    await a.tickRestores(f.runtime(), launch);
    assert.equal(launched.length, 3);
});

test("launcher errors are recorded and incomplete resume records are not prematurely confirmed", async t => {
    const f = fixture(t), store = f.store();
    store.observe([f.session(1), f.session(2)]);
    store.queue([id(1)], f.runtime());
    await store.tickRestores(f.runtime(), async () => { throw new Error("Terminal unavailable"); });
    assert.equal(store.list()[0].state, "failed");
    assert.equal(store.list()[0].error, "Terminal unavailable");
    store.queue([id(2)], f.runtime());
    await store.tickRestores(f.runtime(), async () => {});
    const line = resume(f.now()).trimEnd();
    appendFileSync(f.history(2), '{"bad":"session.resume"}\n' + line);
    await store.tickRestores(f.runtime([f.process(2)]), async () => {});
    assert.equal(store.list()[1].state, "launching");
    appendFileSync(f.history(2), "\n");
    await store.tickRestores(f.runtime([f.process(2)]), async () => {});
    assert.equal(store.list()[1].state, "resumed");
});

test("date recovery uses actual resume timestamps, tolerates malformed events, and does not mutate the roster", async t => {
    const f = fixture(t), store = f.store();
    const start = "2030-01-01T08:00:00Z", end = "2030-01-02T08:00:00Z";
    const timestamp = Date.parse(start) + 3600000;
    f.session(1, '{"bad":"session.resume"}\n' + resume(timestamp) + resume(timestamp + 1000) +
        JSON.stringify({ type: "user.message", timestamp: "2030-01-03T08:00:00Z", data: { content: "session.resume" } }) + "\n");
    f.session(2, resume(Date.parse(start) - 1));
    f.session(3, resume(Date.parse(end)));
    for (let n = 1; n <= 3; n++) utimesSync(f.history(n), f.now() / 1000, f.now() / 1000);
    const found = await findSessionsResumed(store.sessionDirectory, { start, end }, n => ({ summary: `Found ${n}`, cwd: f.directory }));
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, id(1));
    assert.equal(found[0].count, 2);
    assert.equal(found[0].evidenceLine, 2);
    assert.equal(store.list().length, 0);
    await assert.rejects(findSessionsResumed(store.sessionDirectory, { start: "invalid", end }), /valid date range/);
});

test("confirmation advances past large tool records and handles CRLF and partial Unicode records", async t => {
    const f = fixture(t), store = f.store();
    store.observe([f.session(1)]);
    store.queue([id(1)], f.runtime());
    await store.tickRestores(f.runtime(), async () => {});
    appendFileSync(f.history(1), JSON.stringify({ type: "tool.execution_complete", data: "x".repeat(4 * 1024 * 1024 + 1) }) + "\r\n");
    const line = JSON.stringify({ type: "session.resume", timestamp: new Date(f.now()).toISOString(), data: { note: "\u00e9" } });
    appendFileSync(f.history(1), line);
    await store.tickRestores(f.runtime([f.process(1)]), async () => {});
    assert.ok(store.list()[0].event_offset > 4 * 1024 * 1024);
    await store.tickRestores(f.runtime([f.process(1)]), async () => {});
    assert.equal(store.list()[0].state, "launching");
    appendFileSync(f.history(1), "\r\n");
    await store.tickRestores(f.runtime([f.process(1)]), async () => {});
    assert.equal(store.list()[0].state, "resumed");
});

test("process arguments require an exact UUID session flag", () => {
    assert.equal(processSessionId(`copilot --resume="${id(1)}"`), id(1));
    assert.equal(processSessionId(`cmd /k "copilot --resume ${id(1)}"`), id(1));
    assert.equal(processSessionId(`copilot --session-id=${id(2)}`), id(2));
    assert.equal(processSessionId(`copilot --resume=${id(1)}extra`), null);
    assert.equal(processSessionId(`copilot --not-resume=${id(1)}`), null);
});
