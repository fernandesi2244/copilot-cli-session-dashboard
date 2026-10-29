import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("HTTP recovery flows use an isolated home, fake SDK, and fake terminal", async t => {
    const home = mkdtempSync(join(tmpdir(), "copilot-dashboard-http-"));
    const directory = join(home, ".copilot");
    const cwd = join(home, "project");
    mkdirSync(cwd);
    for (let n = 1; n <= 3; n++) {
        const path = join(directory, "session-state", id(n));
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "events.jsonl"), JSON.stringify({
            type: "session.resume", timestamp: n === 3 ? "2020-06-05T12:00:00Z" : "2020-06-04T12:00:00Z",
            data: { context: { cwd } },
        }) + "\n");
        if (n !== 3) writeFileSync(join(path, "workspace.yaml"), `name: Session ${n}\ncwd: ${cwd}\n`);
    }
    writeFileSync(join(directory, "saved-workspace.json"), JSON.stringify({
        version: 1, savedAt: "2020-06-05T12:00:00Z", sessions: [{ sessionId: id(2), cwd }],
    }));

    // Nothing in the extension may reach the real SDK, user home, shell, or terminal.
    const script = `
import os from 'node:os';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
os.homedir = () => ${JSON.stringify(home)};
cp.execSync = () => Buffer.from('tester@example.test');
cp.exec = (...args) => { const callback=args.at(-1); if (typeof callback==='function') callback(new Error('Unexpected shell call')); };
cp.execFile = () => { throw new Error('Unexpected direct execFile'); };
cp.execFile[promisify.custom] = async file => {
  if (file === 'powershell.exe') return { stdout:JSON.stringify({
    bootId:'http-boot', processes:[{pid:process.pid,name:'node.exe',startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),commandLine:''}]
  }), stderr:'' };
  if (file === 'wt.exe') {
    console.log('FAKE_LAUNCH');
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('Simulated terminal launch failure');
  }
  throw new Error('Unexpected executable');
};
cp.spawn = () => {
  const worker=new EventEmitter();
  worker.stdout=new EventEmitter();
  worker.stdin={ writable:true, write(value) {
    if (value.trim().startsWith('{')) queueMicrotask(() => worker.stdout.emit('data',Buffer.from('RESULT:NO_WT\\n')));
  }};
  queueMicrotask(() => worker.stdout.emit('data',Buffer.from('READY\\n')));
  return worker;
};
syncBuiltinESMExports();
const sdk='export async function joinSession(){return {sessionId:${JSON.stringify(id(1))},on(){},async log(message){console.log("READY:"+message.match(/http[^ ]+/)[0]);}}}';
registerHooks({resolve(specifier,context,next) {
  if (specifier==='@github/copilot-sdk/extension') return {url:'data:text/javascript,'+encodeURIComponent(sdk),shortCircuit:true};
  return next(specifier,context);
}});
await import(${JSON.stringify(new URL("./extension.mjs", import.meta.url).href)});
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    t.after(async () => {
        if (child.exitCode === null) {
            const exited = once(child, "exit");
            child.kill();
            await exited;
        }
        rmSync(home, { recursive: true, force: true });
    });
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Extension did not start: " + stderr)), 10000);
        child.stdout.on("data", () => {
            const match = stdout.match(/READY:(http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Extension exited: " + stderr)); });
    });
    const api = async (path, body) => {
        const response = await fetch(url + path, body === undefined ? {} : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
    };
    const initial = (await api("/api/recovery")).data;
    assert.equal(initial.sessions.length, 2);
    assert.equal(initial.sessions.find(s => s.sessionId === id(1)).alive, true);
    assert.equal(initial.sessions.find(s => s.sessionId === id(1)).summary, "Session 1");
    assert.equal(initial.checkpoints[0].bootId, "legacy-import");
    const workspace = (await api("/api/workspace-status")).data;
    assert.equal(workspace.count, 1, "saved workspace must not count the archive or newly opened tabs");
    assert.equal(workspace.archiveCount, 2);

    const page = await fetch(url + "/recovery").then(r => r.text());
    const browserScript = page.match(/<script>([\s\S]*?)<\/script>/)[1];
    new Script(browserScript);
    const main = await fetch(url).then(r => r.text());
    assert.match(main, /href="\/recovery"/);
    for (const match of main.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
    const localDayRange = browserScript.match(/function localDayRange\(value\) \{[\s\S]*?^\}/m)[0];
    const lengths = JSON.parse(execFileSync(process.execPath, ["-e", localDayRange + `
console.log(JSON.stringify(['2024-03-10','2024-11-03'].map(day => {
 const r=localDayRange(day); return (Date.parse(r.end)-Date.parse(r.start))/3600000;
})));`], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" }));
    assert.deepEqual(lengths, [23, 25], "local dates must use separate midnight boundaries across DST");

    const found = (await api("/api/recovery/find?start=2020-06-05T00:00:00Z&end=2020-06-06T00:00:00Z")).data.sessions;
    assert.deepEqual(found.map(s => s.sessionId), [id(3)]);
    assert.equal(found[0].cwd, cwd);
    assert.equal((await api("/api/recovery")).data.sessions.length, 2, "searching alone must not import");
    assert.equal((await api("/api/recovery/find?start=bad&end=bad")).status, 400);
    assert.equal((await api("/api/resume", { sessionId: "../bad" })).status, 400);
    assert.equal((await api("/api/resume", { sessionId: id(1) })).data.results[0].state, "already-running");

    const requests = await Promise.all([
        api("/api/recovery/restore", { sessionIds: [id(3)] }),
        api("/api/resume", { sessionId: id(3) }),
        api("/api/focus-tab", { sessionId: id(3), title: "Test session" }),
    ]);
    assert.equal(requests[0].status, 202);
    assert.equal(requests[1].status, 202);
    assert.ok(requests.every(r => ["queued", "launching"].includes(r.data.results[0].state)));
    let status;
    for (let n = 0; n < 100; n++) {
        status = (await api("/api/restore-status?ids=" + id(3))).data.results[0];
        if (status.state === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.state, "failed");
    assert.match(status.error, /Simulated terminal launch failure/);
    assert.equal((stdout.match(/FAKE_LAUNCH/g) || []).length, 1, "all resume routes must share one attempt");
    assert.equal((await api("/api/recovery")).data.sessions.find(s => s.sessionId === id(3)).cwd, cwd);
    const restored = await api("/api/restore-workspace", {});
    assert.equal(restored.status, 202);
    assert.equal(restored.data.restored, undefined, "a queued launch must never be reported as restored");
    assert.deepEqual(restored.data.results.map(r => r.id), [id(2)], "bulk restore must not launch unrelated archived sessions");
    const saved = await api("/api/save-workspace", {});
    assert.equal(saved.data.count, 1, "manual save must use the currently open tabs, not the archive");
    assert.equal((await api("/api/recovery")).data.sessions.length, 3, "manual save must preserve older archive entries");
    const currentRestore = await api("/api/restore-workspace", {});
    assert.deepEqual(currentRestore.data.results.map(r => [r.id, r.state]), [[id(1), "already-running"]]);

    await api("/api/recovery/forget", { sessionIds: [id(3)] });
    assert.equal(existsSync(join(directory, "session-state", id(3), "events.jsonl")), true);
    assert.equal((await api("/api/recovery")).data.sessions.some(s => s.sessionId === id(3)), false);
    await api("/api/recovery/forget", { sessionIds: [id(2)] });
    const promoted = await api("/api/workspace-promote", { slot: 1 });
    assert.equal(promoted.data.ok, true);
    assert.equal((await api("/api/recovery")).data.sessions.some(s => s.sessionId === id(1)), true, "promotion must retain other entries");
    assert.equal((await api("/api/recovery/checkpoint", { bootId: "legacy-import" })).data.ok, true);
    assert.equal((await api("/api/recovery/checkpoint", { bootId: "missing" })).status, 400);
    assert.equal((await api("/api/recovery")).data.sessions.some(s => s.sessionId === id(2)), true);
    assert.equal((await api("/api/clear-workspace", {})).data.ok, true);
    assert.equal((await api("/api/save-workspace", {})).data.count, 0, "live scans must respect explicit forgetting");
    assert.equal((await api("/api/workspace-status")).data.hasSaved, false);
    assert.equal(JSON.parse(readFileSync(join(directory, "saved-workspace.json"))).sessions.length, 0);
});
