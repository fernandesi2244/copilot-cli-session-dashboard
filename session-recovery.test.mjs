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

test("saved workspace migrates the latest open-tab snapshot, never the merged archive", t => {
    const f = fixture(t);
    const one = f.session(1), two = f.session(2), three = f.session(3);
    writeFileSync(join(f.directory, "saved-workspace.json"), JSON.stringify({
        version: 2, savedAt: "2030-01-02T11:00:00Z", sessions: [one, two, three],
    }));
    writeFileSync(join(f.directory, "saved-workspace.json.2"), JSON.stringify({
        version: 1, savedAt: "2030-01-01T11:00:00Z", sessions: [one],
    }));
    writeFileSync(join(f.directory, "saved-workspace.json.1"), JSON.stringify({
        version: 1, savedAt: "2030-01-01T12:00:00Z", sessions: [two, { sessionId: id(99), cwd: f.directory }],
    }));
    const store = f.store();
    assert.deepEqual(store.workspace().sessions.map(s => s.sessionId), [id(2)]);
    assert.equal(store.list().length, 4, "archive membership must not be deleted");
    store.observeWorkspace(f.runtime([f.process(3)]));
    store.projectWorkspace();
    assert.deepEqual(store.workspace().sessions.map(s => s.sessionId), [id(2)], "startup must preserve the recovery target");
    assert.equal(JSON.parse(readFileSync(store.workspaceFile)).version, 3);
    assert.equal(JSON.parse(readFileSync(store.workspaceFile)).sessions.length, 1);
    const second = f.store();
    assert.deepEqual(second.workspace(), store.workspace(), "migration must only run once");
    store.saveWorkspace();
    assert.deepEqual(store.workspace().sessions.map(s => s.sessionId), [id(3)]);
});

test("only confirmed open sessions enter live snapshots; missing, stale and partial discovery cannot inflate or erase them", t => {
    const f = fixture(t), store = f.store();
    store.observe([f.session(1), f.session(2), { sessionId: id(99), cwd: f.directory }]);
    assert.equal(store.list().length, 2, "temporary observations without conversation history must not be retained");
    store.observeWorkspace(f.runtime([f.process(1), f.process(2)]));
    assert.equal(store.workspace().sessions.length, 2);
    store.observe([f.session(1)]);
    store.observeWorkspace(f.runtime([f.process(1), f.process(2)]));
    assert.equal(store.workspace().sessions.length, 2, "a partial metadata scan must not hide a still-running archived session");
    store.observeWorkspace(f.runtime([], false));
    assert.equal(store.workspace().sessions.length, 2, "failed discovery cannot erase a workspace");
    store.observeWorkspace({ ...f.runtime(), capturedAt: f.now() - 25000 });
    store.observeWorkspace({ ...f.runtime(), bootId: "other-boot" });
    assert.equal(store.workspace().sessions.length, 2, "stale or foreign-boot snapshots are not evidence");
    store.observeWorkspace(f.runtime([f.process(2)]));
    assert.deepEqual(store.workspace().sessions.map(s => s.sessionId), [id(2)], "confirmed closure removes only live membership");
    assert.equal(store.list().length, 2);
    store.observeWorkspace(f.runtime());
    assert.equal(store.workspace().sessions.length, 0, "a confirmed empty workspace is distinct from failed discovery");
});

test("without an open-tab backup, migration never guesses a previous workspace from the archive", t => {
    const f = fixture(t);
    writeFileSync(join(f.directory, "saved-workspace.json"), JSON.stringify({
        version: 2, savedAt: new Date(f.now()).toISOString(), sessions: [f.session(1), f.session(2)],
    }));
    const store = f.store();
    assert.equal(store.workspace().sessions.length, 0);
    assert.equal(store.list().length, 2);
    store.observeWorkspace(f.runtime([f.process(2)]));
    assert.deepEqual(store.workspace().sessions.map(s => s.sessionId), [id(2)]);
});

test("reboot freezes only the last confirmed open tabs while newer tabs and old writers leave the target intact", t => {
    const f = fixture(t), before = f.store();
    before.observe([f.session(1), f.session(2), f.session(3)]);
    before.observeWorkspace(f.runtime([f.process(1), f.process(2)]));
    before.observeWorkspace(f.runtime([f.process(2)]));
    const after = f.store("boot-b");
    assert.deepEqual(after.workspace().sessions.map(s => s.sessionId), [id(2)]);
    after.observeWorkspace({ ...f.runtime([f.process(3)]), bootId: "boot-b" });
    after.setMeta("boot", "old-writer-boot");
    after.setMeta("workspace-boot", "old-writer-boot");
    after.setMeta("saved-workspace", JSON.stringify({ sessions: [] }));
    after.setMeta("coordinator", JSON.stringify({ owner: "old-writer", expiresAt: f.now() + 45000 }));
    after.setBoot("boot-b");
    assert.equal(after.claimCoordinator(), true, "old coordinators must not block live-workspace capture");
    assert.deepEqual(after.workspace().sessions.map(s => s.sessionId), [id(2)]);
    assert.deepEqual(after.checkpoints().find(c => c.bootId === "boot-a").data.sessions.map(s => s.sessionId), [id(2)]);
    after.forget(id(2));
    assert.equal(after.workspace().sessions.length, 0);
    assert.equal(after.checkpoints().find(c => c.bootId === "boot-a").data.sessions.length, 1, "forgetting cannot mutate the checkpoint");
    const next = f.store("boot-c");
    assert.deepEqual(next.workspace().sessions.map(s => s.sessionId), [id(3)], "the next boot uses its immediately preceding live workspace");
});

test("adopting a stable boot ID does not manufacture a reboot or replace the saved workspace", t => {
    const f = fixture(t), legacyBoot = "2030-01-02T08:00:04Z", before = f.store(legacyBoot);
    before.observe([f.session(1), f.session(2)]);
    before.observeWorkspace({ ...f.runtime([f.process(1)]), bootId: legacyBoot });
    before.saveWorkspace();
    before.observeWorkspace({ ...f.runtime([f.process(2)]), bootId: legacyBoot });
    before.setBoot("windows-boot-55", "2030-01-02T08:00:00Z");
    assert.deepEqual(before.workspace().sessions.map(s => s.sessionId), [id(1)]);
    assert.equal(before.checkpoints().length, 0);
    const after = f.store("windows-boot-56");
    assert.deepEqual(after.workspace().sessions.map(s => s.sessionId), [id(2)]);
});

test("connections share membership and a single expiring coordinator lease", t => {
    const f = fixture(t), a = f.store(), b = f.store();
    a.observe([f.session(1)]);
    b.observe([f.session(2)]);
    assert.equal(a.claimCoordinator(), true);
    assert.equal(b.claimCoordinator(), false);
    a.observeWorkspace(f.runtime([f.process(1), f.process(2)]));
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
    b.observeWorkspace(f.runtime([f.process(1), f.process(2), f.process(3)]));
    b.projectWorkspace();
    assert.equal(JSON.parse(readFileSync(a.workspaceFile + ".1")).sessions.length, 2);
});

test("previous-boot checkpoints survive observations, forgetting, and rolling backup churn", t => {
    const f = fixture(t), before = f.store();
    before.observe([f.session(1), f.session(2)]);
    before.queue([id(1)], f.runtime());
    before.observeWorkspace(f.runtime([f.process(1), f.process(2)]));
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
    before.observeWorkspace(f.runtime([f.process(1)]));
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

test("legacy SDK registrations remain usable on the same stable Windows boot", t => {
    const f = fixture(t), store = f.store("windows-boot-55");
    const bootStartedAt = "2030-01-02T08:00:00Z";
    store.register(f.session(1), { pid: 101, startedAt: f.now() - 1000 });
    store.db.prepare("UPDATE observers SET boot_id=?").run("2030-01-02T08:00:04Z");
    const host = { ...f.process(1, 100), commandLine: "copilot" };
    const child = { pid: 101, parentPid: 100, name: "node.exe", startedAt: new Date(f.now() - 1000).toISOString() };
    const runtime = { ...f.runtime([host, child]), bootId: "windows-boot-55", bootStartedAt };
    assert.equal(sessionPresence(store, id(1), runtime).alive, true);
    store.db.prepare("UPDATE observers SET boot_id=?").run("2030-01-01T08:00:04Z");
    assert.equal(sessionPresence(store, id(1), runtime).alive, false);
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
    a.include([f.session(1), { sessionId: id(2), cwd: f.directory }, { ...f.session(3), cwd: join(f.directory, "missing") }, f.session(4)]);
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
