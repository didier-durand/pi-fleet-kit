/**
 * mailbox.test.ts — the mailbox protocol lifecycle (SPECS v1.1.0 R9–R12).
 *
 * Real temp exchange dirs (two agents' dirs side by side, sharing a parent —
 * the fleet layout), mocked poll interval, real wall-clock stability windows
 * with mtimes backdated via utimesSync — the same strategy as the v0.1.0
 * suite, extended to the maildir state machine: claim → deliver → reply →
 * processed, with the ledger giving at-most-once and the reply closing the
 * loop between two agents.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import activatePromptTrigger from "../prompt-trigger.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE = () => new Promise((r) => setImmediate(r));
const STABLE_GAP = 600; // > STABILITY_MS with margin
const tickOnce = (t: { mock: { timers: { tick: (ms: number) => void } } }) => t.mock.timers.tick(1500);


// --- fixture: a fleet exchange root with two agents' dirs --------------------

function makeFleet(): { root: string; dirA: string; dirB: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-fleet-"));
	const dirA = path.join(root, "pi-a");
	const dirB = path.join(root, "pi-b");
	for (const d of [dirA, dirB]) fs.mkdirSync(d);
	return { root, dirA, dirB };
}

function envelope(to: string, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
		from: "pi-a",
		to,
		type: "request",
		correlation_id: null,
		created: new Date().toISOString(),
		body,
		attempts: 0,
		...overrides,
	};
}

interface Harness {
	sent: Array<{ text: string; opts?: unknown }>;
	notified: string[];
	handlers: Record<string, (e?: unknown, c?: unknown) => Promise<void>>;
	ctx: Record<string, unknown>;
}

function activate(): Harness {
	const sent: Array<{ text: string; opts?: unknown }> = [];
	const notified: string[] = [];
	const handlers: Record<string, (e?: unknown, c?: unknown) => Promise<void>> = {};
	const pi = {
		on: (event: string, handler: unknown) => { handlers[event] = handler as never; },
		sendUserMessage: (text: string, opts?: unknown) => { sent.push({ text, opts }); },
	};
	const ctx = {
		hasUI: true,
		notified,
		ui: { notify: (msg: string, _level?: string) => notified.push(msg) },
		// the branch: one user entry + one assistant entry — the reply body
		sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "the question" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } },
		] },
	};
	activatePromptTrigger(pi as never);
	return { sent, notified, handlers, ctx: ctx as never };
}

// the two-tick lifecycle: mailbox envelopes are consumed on the FIRST tick
// (the maildir has its own stability semantics — the send.sh atomic rename
// makes them complete on arrival), the reply is written on agent_end.
async function runTicks(t: { mock: { timers: { tick: (ms: number) => void } } }, n: number) {
	for (let i = 0; i < n; i++) { tickOnce(t); await SETTLE(); }
}

// --- R10: maildir setup ------------------------------------------------------

test("session_start creates the maildir layout (idempotent)", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { dirA } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirA;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		await SETTLE();
		for (const sub of ["inbox", "working", "pending", "processed", "failed"]) {
			assert.ok(fs.statSync(path.join(dirA, sub)).isDirectory(), `${sub}/ created`);
		}
		// idempotent: a second start does not throw
		await h.handlers.session_start(null, h.ctx);
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(path.dirname(dirA), { recursive: true, force: true });
	}
});

// --- R9/R10/R12: the full request → reply loop --------------------------------

test("request envelope: claim → deliver → reply on settle → processed; reply correlates", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirB; // agent B consumes a request FROM agent A
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		// both agents' inboxes exist (each agent's session_start creates its own)
		fs.mkdirSync(path.join(dirA, 'inbox'), { recursive: true });
		// agent A drops a request into B's inbox (atomic, send.sh-style)
		const req = envelope("pi-b", "please summarize the PR");
		fs.writeFileSync(path.join(dirB, "inbox", `${req.id}.json`), JSON.stringify(req));
		await runTicks(t, 1); // one tick: claim + deliver

		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].text, "please summarize the PR");
		assert.ok(fs.existsSync(path.join(dirB, "working", `${req.id}.json`)), "claimed (working/) while the turn runs");

		// the turn settles: the reply goes to A's inbox, the message to processed/
		await h.handlers.agent_end(null, h.ctx);
		const replies = fs.readdirSync(path.join(dirA, "inbox")).filter((n) => !n.startsWith("."));
		assert.equal(replies.length, 1, "one reply envelope in A's inbox");
		const reply = JSON.parse(fs.readFileSync(path.join(dirA, "inbox", replies[0]), "utf-8"));
		assert.equal(reply.type, "reply");
		assert.equal(reply.correlation_id, req.id);
		assert.equal(reply.from, "pi-b");
		assert.equal(reply.to, "pi-a");
		assert.equal(reply.body, "the answer");
		assert.ok(fs.existsSync(path.join(dirB, "processed", `${req.id}.json`)), "completed → processed/");
		assert.ok(!fs.existsSync(path.join(dirB, "working", `${req.id}.json`)), "no longer working");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("busy agent: request delivered as followUp; reply still on settle", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirB;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		fs.mkdirSync(path.join(dirA, 'inbox'), { recursive: true });
		await h.handlers.agent_start(null, h.ctx); // streaming in progress
		const req = envelope("pi-b", "queued question");
		fs.writeFileSync(path.join(dirB, "inbox", `${req.id}.json`), JSON.stringify(req));
		await runTicks(t, 1);
		assert.deepEqual(h.sent, [{ text: "queued question", opts: { deliverAs: "followUp" } }]);
		await h.handlers.agent_end(null, h.ctx);
		assert.ok(fs.existsSync(path.join(dirA, "inbox", `msg-1.json`)) || fs.readdirSync(path.join(dirA, "inbox")).filter(n => !n.startsWith(".")).length === 1, "reply arrived");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- R9: malformed envelopes fail closed --------------------------------------

test("malformed envelope in inbox/ → failed/ + ledger note, never consumed", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirB;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		fs.writeFileSync(path.join(dirB, "inbox", "msg-bad-1.json"), "{not json");
		await runTicks(t, 1);
		assert.equal(h.sent.length, 0, "never delivered");
		assert.ok(fs.existsSync(path.join(dirB, "failed", "msg-bad-1.json")), "moved to failed/");
		const ledger = fs.readFileSync(path.join(dirB, "ledger.ndjson"), "utf-8");
		assert.match(ledger, /malformed envelope/);
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- R11: ledger at-most-once -------------------------------------------------

test("ledger at-most-once: a re-dropped handled id goes straight to processed, no re-delivery", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirB;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		const req = envelope("pi-b", "once only");
		fs.writeFileSync(path.join(dirB, "inbox", `${req.id}.json`), JSON.stringify(req));
		await runTicks(t, 1);
		await h.handlers.agent_end(null, h.ctx); // reply sent, processed, ledgered
		assert.equal(h.sent.length, 1);

		// the same message id re-dropped (crash artifact / duplicate producer)
		fs.writeFileSync(path.join(dirB, "inbox", `${req.id}.json`), JSON.stringify(req));
		await runTicks(t, 1);
		assert.equal(h.sent.length, 1, "NO second delivery (at-most-once)");
		assert.ok(fs.existsSync(path.join(dirB, "processed", `${req.id}.json`)), "straight to processed/");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- R12: reply envelopes do not loop; error replies; unreachable senders -----

test("reply envelope delivered as a resume prompt — no reply-of-reply loop", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirA; // agent A receives B's reply
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		fs.mkdirSync(path.join(dirB, 'inbox'), { recursive: true });
		const reply = envelope("pi-a", "the answer from B", { type: "reply", correlation_id: "msg-9-9", from: "pi-b" });
		fs.writeFileSync(path.join(dirA, "inbox", `${reply.id}.json`), JSON.stringify(reply));
		await runTicks(t, 1);
		assert.deepEqual(h.sent, [{ text: "the answer from B", opts: undefined }]);
		// no reply-of-reply: A must NOT write a reply to B's inbox
		await h.handlers.agent_end(null, h.ctx);
		assert.equal(fs.readdirSync(path.join(dirB, "inbox")).filter((n) => !n.startsWith(".")).length, 0, "no reply loop");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("unreachable sender: request → failed/ + ledger note", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirB } = makeFleet(); // pi-a's dir does not exist
	process.env.PI_TRIGGER_DIR = dirB;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		const req = envelope("pi-b", "from a ghost", { from: "pi-ghost" });
		fs.writeFileSync(path.join(dirB, "inbox", `${req.id}.json`), JSON.stringify(req));
		await runTicks(t, 1);
		await h.handlers.agent_end(null, h.ctx);
		assert.equal(h.sent.length, 1, "the prompt was still delivered");
		assert.ok(fs.existsSync(path.join(dirB, "failed", `${req.id}.json`)), "moved to failed/");
		const ledger = fs.readFileSync(path.join(dirB, "ledger.ndjson"), "utf-8");
		assert.match(ledger, /sender inbox unreachable/);
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- R10: crash recovery + retention -------------------------------------------

test("crash recovery: a ledgered working/ file is NOT re-delivered; an error reply is sent", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA, dirB } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirB;
	const h = activate();
	try {
		// pre-crash state: the message was delivered + ledgered, reply not written
		const req = envelope("pi-b", "interrupted work");
		fs.mkdirSync(path.join(dirB, "working"), { recursive: true });
		fs.writeFileSync(path.join(dirB, "working", `${req.id}.json`), JSON.stringify(req));
		fs.mkdirSync(path.join(dirA, "inbox"), { recursive: true });
		fs.writeFileSync(path.join(dirB, "ledger.ndjson"), `${JSON.stringify({ id: req.id, at: new Date().toISOString(), note: "delivered: awaiting reply" })}\n`);
		await h.handlers.session_start(null, h.ctx);
		await SETTLE();
		assert.equal(h.sent.length, 0, "NOT re-delivered (at-most-once)");
		const replies = fs.readdirSync(path.join(dirA, "inbox")).filter((n) => !n.startsWith("."));
		assert.equal(replies.length, 1, "an error reply explains the interruption");
		const reply = JSON.parse(fs.readFileSync(path.join(dirA, "inbox", replies[0]), "utf-8"));
		assert.equal(reply.type, "error");
		assert.equal(reply.correlation_id, req.id);
		assert.ok(fs.existsSync(path.join(dirB, "processed", `${req.id}.json`)), "closed out as processed");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("processed/ retention: only the last 100 are kept", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirA;
	const h = activate();
	try {
		fs.mkdirSync(path.join(dirA, "processed"), { recursive: true });
		for (let i = 0; i < 105; i++) {
			fs.writeFileSync(path.join(dirA, "processed", `msg-${String(i).padStart(5, "0")}-1.json`), "{}");
		}
		await h.handlers.session_start(null, h.ctx);
		await SETTLE();
		const left = fs.readdirSync(path.join(dirA, "processed")).filter((n) => !n.startsWith("."));
		assert.equal(left.length, 100);
		assert.equal(left[0], "msg-00005-1.json", "the OLDEST five pruned");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- legacy transition rule (R9 backward compat) --------------------------------

test("transition rule: a raw (non-envelope) file in the exchange ROOT is still a legacy prompt", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { root, dirA } = makeFleet();
	process.env.PI_TRIGGER_DIR = dirA;
	const h = activate();
	try {
		await h.handlers.session_start(null, h.ctx);
		const raw = path.join(dirA, "raw-prompt.txt");
		fs.writeFileSync(raw, "just a plain prompt");
		const old = Date.now() / 1000 - 10;
		fs.utimesSync(raw, old, old);
		await tickOnce(t); await SETTLE();
		await sleep(STABLE_GAP);
		await tickOnce(t); await SETTLE();
		assert.deepEqual(h.sent, [{ text: "just a plain prompt", opts: undefined }]);
		assert.ok(!fs.existsSync(raw), "legacy consumption: deleted");
	} finally {
		await h.handlers.session_shutdown();
		delete process.env.PI_TRIGGER_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

