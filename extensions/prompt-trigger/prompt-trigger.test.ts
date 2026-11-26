/**
 * Unit tests for the prompt-trigger extension.
 *
 * Run: node --test          (from the extension directory)
 * With coverage: c8 node --test
 *
 * Strategy: the extension's only side channel is the real filesystem, so
 * tests run against REAL temp directories, with file mtimes backdated via
 * utimesSync so prompts are stable as soon as they are first observed, and
 * REAL Date.now() (stability arithmetic stays authentic). Only the poll
 * interval is mocked (mock.timers, setInterval), making tick firing
 * deterministic; the ≥500ms stability gap between the two consumption ticks
 * is real elapsed time. Every test shuts the interval down — a leaked
 * interval would keep the process alive.
 *
 * KNOWN DOC/IMPL GAP (asserted as actual behavior): the documented
 * MAX_FILES_PER_TICK cap ("5 prompts consumed per tick") actually bounds
 * the OBSERVATION loop, so a burst is drained over consecutive ticks (see
 * the burst-pacing test for the measured dynamics).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import activatePromptTrigger from "./prompt-trigger.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE = () => new Promise((r) => setImmediate(r));
// Real elapsed time between the observation tick and the consumption tick —
// must exceed STABILITY_MS (500ms) with margin for scheduler jitter.
const STABLE_GAP = 600;

interface Harness {
	sent: Array<{ text: string; opts?: unknown }>;
	notified: string[];
	newSessions: Array<Record<string, unknown>>;
	handlers: Record<string, (e?: unknown, c?: unknown) => Promise<void>>;
	ctx: Record<string, unknown>;
}

function activate(): Harness {
	const sent: Array<{ text: string; opts?: unknown }> = [];
	const notified: string[] = [];
	const newSessions: Array<Record<string, unknown>> = [];
	const handlers: Record<string, (e?: unknown, c?: unknown) => Promise<void>> = {};
	const pi = {
		on: (event: string, handler: unknown) => { handlers[event] = handler as never; },
		sendUserMessage: (text: string, opts?: unknown) => { sent.push({ text, opts }); },
	};
	const ctx = {
		hasUI: true,
		notified,
		newSessions,
		ui: { notify: (msg: string, _level?: string) => notified.push(msg) },
		newSession: (o: Record<string, unknown>) => { newSessions.push(o); return Promise.resolve(); },
	};
	activatePromptTrigger(pi as never);
	return { sent, notified, newSessions, handlers, ctx: ctx as never };
}

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "prompt-trigger-test-"));
}

// A file whose mtime is old enough to satisfy the stability window the
// moment it is first observed.
function dropPrompt(dir: string, name: string, content: string): string {
	const full = path.join(dir, name);
	fs.writeFileSync(full, content);
	const old = Date.now() / 1000 - 10; // 10s in the past
	fs.utimesSync(full, old, old);
	return full;
}

type TestCtx = { mock: { timers: { tick: (ms: number) => void } } };

// Fires the mocked poll interval once (period: POLL_MS = 1500ms). Date is
// NOT mocked, so the stability check uses authentic wall-clock deltas.
const tickOnce = (t: TestCtx) => t.mock.timers.tick(1500);

// Standard two-tick lifecycle: first tick observes, real gap, second consumes.
async function twoTicks(t: TestCtx) {
	tickOnce(t); await SETTLE();
	await sleep(STABLE_GAP);
	tickOnce(t); await SETTLE();
}

// Shared body: enable mocked interval, point PI_TRIGGER_DIR at a fresh
// temp dir, run `fn`, then always shut the interval down and clean up.
async function withHarness(t: TestCtx, fn: (h: Harness, dir: string) => Promise<void>) {
	const dir = tmpdir();
	const h = activate();
	t.mock.timers.enable({ apis: ["setInterval"] });
	process.env.PI_TRIGGER_DIR = dir;
	try {
		await fn(h, dir);
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("dormant without PI_TRIGGER_DIR: no notification, no consumption", { timeout: 10000 }, async (t) => {
	const h = activate();
	delete process.env.PI_TRIGGER_DIR;
	await h.handlers.session_start(null, h.ctx);
	assert.equal(h.notified.length, 0);
	assert.deepEqual(h.sent, []);
	await h.handlers.session_shutdown();
});

test("session_start announces the watched directory and poll interval", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		assert.equal(h.notified.length, 1);
		assert.match(h.notified[0], /^\[prompt-trigger\] watching \S+ \(poll 1500ms, mailbox active, self=/);
	});
});

test("consumes a stable file: content sent as a user message, file deleted", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "p1", "hello world");
		await twoTicks(t);
		assert.deepEqual(h.sent, [{ text: "hello world", opts: undefined }]);
		assert.ok(!fs.existsSync(file), "consumed file must be deleted");
	});
});

test("stability window respected: too-young observation is not consumed", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "p1", "later");
		tickOnce(t); await SETTLE(); // observe
		await sleep(100); // younger than STABILITY_MS
		tickOnce(t); await SETTLE(); // second tick, still too young
		assert.deepEqual(h.sent, []);
		assert.ok(fs.existsSync(file));
		await sleep(600); // now older than the window
		tickOnce(t); await SETTLE();
		assert.deepEqual(h.sent, [{ text: "later", opts: undefined }]);
	});
});

test("a file still being rewritten is re-observed, not consumed mid-write", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "p1", "short");
		tickOnce(t); await SETTLE(); // observe v1
		// producer rewrites: larger content, fresh mtime backdated again
		fs.writeFileSync(file, "much longer rewritten content");
		dropPrompt(dir, "p1", "much longer rewritten content");
		tickOnce(t); await SETTLE(); // size changed → re-observe
		assert.deepEqual(h.sent, []);
		await sleep(STABLE_GAP);
		tickOnce(t); await SETTLE(); // v2 stable → consume v2
		assert.deepEqual(h.sent, [{ text: "much longer rewritten content", opts: undefined }]);
		assert.ok(!fs.existsSync(file));
	});
});

test("/new directive starts a fresh session without a model call", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		dropPrompt(dir, "n1", "/new");
		await twoTicks(t);
		assert.equal(h.newSessions.length, 1);
		assert.deepEqual(h.newSessions[0], {});
		assert.ok(h.notified.some((m) => m.includes("fresh session started")));
		assert.deepEqual(h.sent, []);
	});
});

test("/new with kickoff text: fresh session, then kickoff as first message", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		dropPrompt(dir, "n1", "/new review the PR");
		await twoTicks(t);
		assert.equal(h.newSessions.length, 1);
		assert.deepEqual(h.sent, [{ text: "review the PR", opts: undefined }]);
	});
});

test("/new failure (runtime without newSession) notifies the error", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		(h.ctx as { newSession: () => Promise<void> }).newSession = () => Promise.reject(new Error("not supported"));
		await h.handlers.session_start(null, h.ctx);
		dropPrompt(dir, "n1", "/new");
		await twoTicks(t);
		assert.equal(h.newSessions.length, 0);
		assert.ok(h.notified.some((m) => m.includes("/new failed:")), "error must be notified");
	});
});

test("empty file is consumed silently (no prompt sent)", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "e1", "   \n");
		await twoTicks(t);
		assert.deepEqual(h.sent, []);
		assert.ok(!fs.existsSync(file));
	});
});

test("dotfiles are never consumed", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		dropPrompt(dir, ".hidden", "secret");
		await twoTicks(t);
		await twoTicks(t); // extra tick: still nothing
		assert.deepEqual(h.sent, []);
		assert.ok(fs.existsSync(path.join(dir, ".hidden")));
	});
});

test("non-regular entries (directories) are skipped", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		fs.mkdirSync(path.join(dir, "subdir"));
		await twoTicks(t);
		assert.deepEqual(h.sent, []);
	});
});

test("mid-run prompts are queued as followUp instead of interrupting", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		await h.handlers.agent_start(); // streaming in progress
		dropPrompt(dir, "b1", "queued question");
		await twoTicks(t);
		assert.deepEqual(h.sent, [{ text: "queued question", opts: { deliverAs: "followUp" } }]);
		await h.handlers.agent_end();
		// idle again: the next prompt goes out directly
		dropPrompt(dir, "b2", "direct question");
		await twoTicks(t);
		assert.deepEqual(h.sent[1], { text: "direct question", opts: undefined });
	});
});

test("trigger dir missing at tick time: dormant, no throw", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		fs.rmSync(dir, { recursive: true, force: true });
		tickOnce(t); await SETTLE(); // readdirSync fails → silent tick
		assert.deepEqual(h.sent, []);
	});
});

test("file deleted externally between ticks: observation forgotten, no throw", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "v1", "vanishing");
		tickOnce(t); await SETTLE(); // observed
		fs.unlinkSync(file); // external actor removes it
		tickOnce(t); await SETTLE(); // statSync fails → forget
		assert.deepEqual(h.sent, []);
	});
});

test("burst pacing: a 7-file burst is consumed over three ticks (cap dynamics)", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		for (let i = 0; i < 7; i++) dropPrompt(dir, `c${i}`, `prompt ${i}`);

		// tick 1: observation is capped — 6 of 7 files enter the pending map
		// (the loop breaks after the 6th candidate), c6 is not yet observed.
		tickOnce(t); await SETTLE();
		assert.deepEqual(h.sent, []);

		// tick 2: the 6 observed files are all stable → all consumed (the
		// consume branch has no cap); c6 gets observed before the loop breaks.
		await sleep(STABLE_GAP);
		tickOnce(t); await SETTLE();
		assert.equal(h.sent.length, 6);

		// tick 3: c6, observed on tick 2, is now stable → consumed
		await sleep(STABLE_GAP);
		tickOnce(t); await SETTLE();
		assert.equal(h.sent.length, 7);
		assert.deepEqual(h.sent.map((s) => s.text), [0, 1, 2, 3, 4, 5, 6].map((i) => `prompt ${i}`));
	});
});

test("session_shutdown stops the poll interval", { timeout: 10000 }, async (t) => {
	const dir = tmpdir();
	const h = activate();
	t.mock.timers.enable({ apis: ["setInterval"] });
	process.env.PI_TRIGGER_DIR = dir;
	try {
		await h.handlers.session_start(null, h.ctx);
		await h.handlers.session_shutdown();
		dropPrompt(dir, "late", "never consumed");
		await tickOnce(t); await SETTLE();
		await tickOnce(t); await SETTLE();
		assert.deepEqual(h.sent, []);
		assert.ok(fs.existsSync(path.join(dir, "late")));
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("shutdown before any session_start: no timer, no throw", async (t) => {
	const h = activate();
	await h.handlers.session_shutdown(); // timer never created — false side of the clearInterval guard
});

test("hasUI=false: ticks run but the TUI is not notified", { timeout: 10000 }, async (t) => {
	const dir = tmpdir();
	const h = activate();
	(h.ctx as { hasUI: boolean }).hasUI = false;
	t.mock.timers.enable({ apis: ["setInterval"] });
	process.env.PI_TRIGGER_DIR = dir;
	try {
		await h.handlers.session_start(null, h.ctx);
		assert.equal(h.notified.length, 0); // start notification suppressed
		dropPrompt(dir, "n1", "/new");
		await twoTicks(t);
		assert.equal(h.newSessions.length, 1); // session control still happens
		assert.equal(h.notified.length, 0); // notify suppressed there too
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a file touched without size change is re-observed (mtime branch)", { timeout: 10000 }, async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		const file = dropPrompt(dir, "m1", "abc");
		tickOnce(t); await SETTLE(); // observed
		// touch only: same size, different mtime → must NOT be consumed
		fs.utimesSync(file, Date.now() / 1000 - 10, Date.now() / 1000 - 10);
		tickOnce(t); await SETTLE(); // mtime changed → re-observe
		assert.deepEqual(h.sent, []);
		assert.ok(fs.existsSync(file));
		await sleep(STABLE_GAP);
		tickOnce(t); await SETTLE(); // now stable → consume
		assert.deepEqual(h.sent, [{ text: "abc", opts: undefined }]);
	});
});

test("a broken symlink in the dir is skipped silently (statSync failure)", async (t) => {
	await withHarness(t, async (h, dir) => {
		await h.handlers.session_start(null, h.ctx);
		fs.symlinkSync(path.join(dir, "does-not-exist"), path.join(dir, "dangling"));
		tickOnce(t); await SETTLE(); // readdir lists it, statSync fails → forgotten
		tickOnce(t); await SETTLE();
		assert.deepEqual(h.sent, []);
	});
});

// --- fs-race windows (child process with mocked node:fs) ---------------------
// The catch paths around readFileSync/unlinkSync are real race windows
// (file vanishing between scan and read; delete failing) — deterministic
// only when node:fs is intercepted, which needs mock.module. Each scenario
// runs in a child process (scripts/race-scenario.mjs); its V8 coverage is
// merged automatically by c8 via the inherited NODE_V8_COVERAGE.

test("file vanishing between scan and read: skipped, retried next tick", () => {
	execFileSync(process.execPath, [
		"--experimental-test-module-mocks",
		"scripts/race-scenario.mjs",
		"vanish",
	], { stdio: "inherit" });
});

test("delete failing after send: prompt delivered, file removal silently retried", () => {
	execFileSync(process.execPath, [
		"--experimental-test-module-mocks",
		"scripts/race-scenario.mjs",
		"sticky",
	], { stdio: "inherit" });
});
