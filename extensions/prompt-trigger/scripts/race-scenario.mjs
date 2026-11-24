/**
 * fs-race scenario runner for prompt-trigger unit tests.
 *
 * The extension's readFileSync/unlinkSync catch paths guard real race
 * windows (file vanishing between scan and read; delete failing after the
 * prompt was delivered). They are deterministic only when node:fs is
 * intercepted, which requires `mock.module` — available under
 * `--experimental-test-module-mocks` and cleanest exercised in this child
 * process, whose V8 coverage c8 merges automatically via NODE_V8_COVERAGE.
 *
 * Usage: node --experimental-test-module-mocks race-scenario.mjs <mode>
 *   vanish — readFileSync throws for gone.txt: prompt skipped, file kept
 *   sticky — unlinkSync throws for sticky.txt: prompt delivered, file kept
 * Exits 0 when the scenario behaved as specified.
 */

import { mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mode = process.argv[2];
const realFs = fs;

if (mode === "vanish") {
	mock.module("node:fs", {
		namedExports: {
			// only the fs surface the extension uses — spreading the whole
			// namespace fails (non-configurable CJS props like constants)
			readFileSync: (p, enc) => {
				if (String(p).endsWith("gone.txt")) throw new Error("vanished");
				return realFs.readFileSync(p, enc);
			},
			readdirSync: (p, o) => realFs.readdirSync(p, o),
			statSync: (p, o) => realFs.statSync(p, o),
			unlinkSync: (p) => realFs.unlinkSync(p),
		},
	});
} else if (mode === "sticky") {
	mock.module("node:fs", {
		namedExports: {
			readdirSync: (p, o) => realFs.readdirSync(p, o),
			statSync: (p, o) => realFs.statSync(p, o),
			readFileSync: (p, enc) => realFs.readFileSync(p, enc),
			unlinkSync: (p) => {
				if (String(p).endsWith("sticky.txt")) throw new Error("EBUSY");
				return realFs.unlinkSync(p);
			},
		},
	});
} else {
	console.error(`unknown mode: ${mode}`);
	process.exit(1);
}

const { default: activate } = await import("../prompt-trigger.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-trigger-race-"));
const sent = [];
const handlers = {};
activate({
	on: (e, h) => { handlers[e] = h; },
	sendUserMessage: (text) => { sent.push(text); },
});
const ctx = { hasUI: true, ui: { notify: () => {} }, newSession: () => Promise.resolve() };

function dropPrompt(name, content) {
	const full = path.join(dir, name);
	fs.writeFileSync(full, content);
	const old = Date.now() / 1000 - 10;
	fs.utimesSync(full, old, old);
	return full;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.PI_TRIGGER_DIR = dir;
// the poll interval is mocked like in the main suite — only its FIRING is
// controlled; the stability window still uses real elapsed time
mock.timers.enable({ apis: ["setInterval"] });
await handlers.session_start(null, ctx);

const file = mode === "vanish" ? dropPrompt("gone.txt", "race") : dropPrompt("sticky.txt", "delivered once");
// tick 1 observes; real gap; tick 2 consumes (or fails to read)
mock.timers.tick(1500);
await new Promise((r) => setImmediate(r));
await sleep(600);
mock.timers.tick(1500);
await new Promise((r) => setImmediate(r));
await sleep(600);
mock.timers.tick(1500);
await new Promise((r) => setImmediate(r));

if (mode === "vanish") {
	assert.deepEqual(sent, [], "nothing delivered when the read fails");
	assert.ok(fs.existsSync(file), "file kept for a retry on a later tick");
} else {
	assert.deepEqual(sent, ["delivered once"], "prompt delivered despite the delete failure");
	assert.ok(fs.existsSync(file), "sticky file kept (delete failed)");
}

await handlers.session_shutdown();
mock.timers.reset();
delete process.env.PI_TRIGGER_DIR;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`race-scenario ${mode}: OK`);
