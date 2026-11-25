/**
 * pi-obs — command-surface tests (SPECS R7 ACs, DEV_PLAN Step 8):
 * the /pi-obs grammar (stats subs byte-identical + status/flush/report),
 * driven through the mock harness with a real file exporter and the
 * throwaway OTLP receiver.
 *
 *   - grammar matrix: every subcommand + flag — valid, ambiguous,
 *     missing args → distinct, actionable messages;
 *   - status reflects configuration (endpoint set/unset, file on/off),
 *     shows queue + drop counters after a scripted drain, and shows
 *     the sticky last-error after a failed export;
 *   - flush: bounded drain, reports what was flushed (and times out
 *     against a hanging backend without hanging the command);
 *   - report: happy path on a fixture (stdout lines parse as
 *     OTLP/JSON), id mode + two-arg dir mode, --branch, --otlp (to the
 *     receiver), --file, and the distinct error paths;
 *   - stats regression (R7 AC): /pi-obs, /pi-obs json, /pi-obs all
 *     outputs are BYTE-IDENTICAL to the pre-spec implementation on
 *     the same fixtures (golden strings below; stats.ts is untouched
 *     in git since the spec).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import piObs from "../../src/index.ts";
import { FLUSH_TIMEOUT_MS } from "../../src/index.ts";
import { mockPi, type MockPi } from "../harness.ts";
import { startReceiver, type OtlpReceiver } from "../otlp_receiver.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "sessions");
const ENV_KEYS = ["PI_HOME", "HOME", "PI_OBS_FILE", "PI_OBS_FILE_PATH", "PI_OBS_OTLP_ENDPOINT", "PI_OBS_CAPTURE_PROMPTS", "PI_OBS_CAPTURE_TOOL_IO", "PI_OBS_QUEUE_MAX", "PI_SERVE_DIR", "PI_OBS_ENABLED", "PI_OBS_RESOURCE_SERVICE"];
let savedEnv: Record<string, string | undefined>;
let dir: string;
let exportPath: string;
let pi: MockPi;
let stdout: string[];
let stderr: string[];
const realError = console.error;
const realLog = console.log;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	dir = mkdtempSync(join(tmpdir(), "pi-obs-cmd-"));
	exportPath = join(dir, "pi-obs.jsonl");
	process.env.PI_HOME = dir;
	process.env.HOME = dir;
	stdout = [];
	stderr = [];
	console.error = (message?: unknown) => {
		stderr.push(String(message));
	};
	console.log = (message?: unknown) => {
		stdout.push(String(message));
	};
	pi = mockPi({ cwd: "/work/demo", sessionId: "sess-0001", sessionDir: join(dir, "sessions"), model: { provider: "openrouter", id: "m" } });
});

afterEach(() => {
	console.error = realError;
	console.log = realLog;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

const activate = (extra: Record<string, string> = {}) => {
	process.env.PI_OBS_FILE = "1";
	process.env.PI_OBS_FILE_PATH = exportPath;
	delete process.env.PI_OBS_ENABLED; // the container may inject PI_OBS_ENABLED=0 — tests control their own env
	for (const [key, value] of Object.entries(extra)) process.env[key] = value;
	piObs(pi as never);
};

const run = async (args: string): Promise<string> => {
	stdout = [];
	await pi.runCommand("pi-obs", args);
	return stdout.join("\n");
};

/** Enqueue some telemetry and let the drain settle (bounded). */
const settle = async (): Promise<void> => {
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("message_update", { message: { role: "assistant" } });
	await pi.emit("session_shutdown", { reason: "quit" });
};

test("grammar: missing args, unknown flags, and ambiguities give distinct actionable messages", async () => {
	activate();
	mkdirSync(join(dir, "sessions"), { recursive: true }); // the ctx session dir must exist for id-mode errors
	assert.match(await run("report"), /missing <session-id \| path>/);
	assert.match(await run("report --otlp"), /missing <session-id \| path>/);
	assert.match(await run(`report ${join(FIXTURES, "straight.jsonl")} --wat`), /unknown flag "--wat"/);
	assert.match(await run(`report ${join(FIXTURES, "straight.jsonl")} extra-bare-token`), /unexpected argument "extra-bare-token"/);
	assert.match(await run(`report ${join(FIXTURES, "straight.jsonl")} some-dir`), /a \[session-dir\] may only follow a session ID/);
	assert.match(await run("report some-id some-dir third-bare"), /unexpected argument "third-bare"/);
	assert.match(await run("report no-such-id"), /no session with id no-such-id/);
	assert.match(await run("status"), /active \(1 exporter/); // sanity: the good subcommands still work
});

test("status: inactive, file-only, otlp-only, both — reflecting configuration", async () => {
	// inactive
	piObs(pi as never);
	assert.match(await run("status"), /inactive \(no exporter configured/);
	assert.match(await run("status"), /stats commands work regardless/);

	// file only
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
	activate();
	assert.match(await run("status"), /active \(1 exporter/);
	assert.match(await run("status"), new RegExp(`file: ${exportPath.replaceAll("/", "/")}`));
	assert.ok(!(await run("status")).includes("otlp:"), "no otlp line when unconfigured");

	// otlp only
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
	activate({ PI_OBS_FILE: "0", PI_OBS_OTLP_ENDPOINT: "http://collector.example:4318/v1/traces" });
	assert.match(await run("status"), /otlp: http:\/\/collector\.example:4318\/v1\/traces/);
	assert.ok(!(await run("status")).includes("file:"), "no file line when disabled");

	// both
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
	activate({ PI_OBS_OTLP_ENDPOINT: "http://collector.example:4318" });
	const both = await run("status");
	assert.ok(both.includes("file:") && both.includes("otlp:"), `both exporters listed:\n${both}`);
	assert.match(both, /queue: depth 0 · enqueued 0 · drained 0 · dropped 0/);
});

test("status after a scripted drain: counters and last-export timestamp; sticky last-error after a failed export", async () => {
	activate();
	await settle();
	const status = await run("status");
	assert.match(status, /file: .* — written [1-9]\d* · dropped 0 · last export 20\d\d-\d\d-\d\dT/);
	assert.match(status, /queue: depth 0 · enqueued [1-9]\d* · drained [1-9]\d* · dropped 0/);
	assert.match(status, /last error —/);

	// a failing OTLP leg: dead port, bounded attempts, then the error is visible in status
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
	activate({ PI_OBS_OTLP_ENDPOINT: "http://127.0.0.1:9" }); // port 9 (discard): refused fast
	await settle();
	const failed = await run("status");
	assert.match(failed, /otlp: .*dropped [1-9]\d*.*last error .*(fetch failed|ECONNREFUSED|Connection)/i);
	assert.match(failed, /file: .* — written [1-9]/, "the file leg kept working (isolation)");

	// R4: the exporter fault became an OTel log record in the file export — never stderr-only
	const wire = readFileSync(exportPath, "utf8");
	const logLines = wire.split("\n").filter((l) => l.includes('"resourceLogs"'));
	assert.ok(logLines.length > 0, "log records exported");
	const bodies = logLines.map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string }; severityText: string }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0]);
	assert.ok(bodies.some((rec) => rec.severityText === "ERROR" && rec.body.stringValue.includes("exporter otlp failed")), `exporter fault record: ${JSON.stringify(bodies)}`);
	assert.ok(!bodies.some((rec) => rec.body.stringValue.includes("dropped")), "no queue-overflow drops in this scenario — these were exporter-level drops");
});

test("flush: reports the bounded drain; times out against a hanging backend without hanging the command", async () => {
	// inactive
	piObs(pi as never);
	assert.match(await run("flush"), /no telemetry queue/);

	// active + a hanging OTLP leg: items pile up behind the stuck dispatch
	const receiver = await startReceiver();
	receiver.hang(99);
	try {
		pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
		activate({ PI_OBS_OTLP_ENDPOINT: receiver.url });
		await pi.emit("session_start", { reason: "startup" }); // first drain enters the hanging dispatch
		await pi.emit("message_update", { message: { role: "assistant" } });
		await pi.emit("message_update", { message: { role: "assistant" } });
		const t0 = performance.now();
		const result = await run("flush");
		const elapsed = performance.now() - t0;
		assert.match(result, new RegExp(`timed out after ${FLUSH_TIMEOUT_MS}ms \\(\\d+ still pending`));
		assert.ok(elapsed >= FLUSH_TIMEOUT_MS * 0.9 && elapsed < FLUSH_TIMEOUT_MS * 2, `flush bounded: ${elapsed.toFixed(0)}ms`);
	} finally {
		await receiver.close();
	}

	// a healthy queue: flush drains (or was already drained) and says so
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
	activate();
	await pi.emit("message_update", { message: { role: "assistant" } });
	const healthy = await run("flush");
	assert.match(healthy, /queue drained \(\d+ pending item\(s\) → 0\)/);
	const status = await run("status");
	assert.match(status, /queue: depth 0/);
});

test("queue overflow: the drop notice becomes a WARN log record (R4 — never stderr-only)", async () => {
	const receiver = await startReceiver();
	receiver.hang(99); // stall the first dispatch so the queue fills behind it
	try {
		pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
		activate({ PI_OBS_QUEUE_MAX: "3", PI_OBS_OTLP_ENDPOINT: receiver.url });
		await pi.emit("session_start", { reason: "startup" });
		for (let i = 0; i < 8; i++) await pi.emit("message_update", { message: { role: "assistant" } });
		await receiver.close(); // destroy the hanging sockets: the dispatch unblocks and drains
		await pi.emit("session_shutdown", { reason: "quit" });
		const wire = readFileSync(exportPath, "utf8");
		const notices = wire
			.split("\n")
			.filter((l) => l.includes('"resourceLogs"'))
			.map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string }; severityText: string }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0])
			.filter((rec) => rec.body.stringValue.includes("dropped"));
		assert.ok(notices.length > 0, `drop notices exported: ${notices.length}`);
		assert.equal(notices[0].severityText, "WARN");
		assert.match(notices[0].body.stringValue, /dropped [1-9]\d* telemetry item/);
	} finally {
		await receiver.close();
	}
});

test("report: stdout OTLP/JSON-per-line on a fixture; id mode + two-arg dir mode; --branch", async () => {
	activate();
	const out = await run(`report ${join(FIXTURES, "straight.jsonl")}`);
	const lines = out.split("\n").filter((l) => l.startsWith("{"));
	assert.ok(lines.length > 0, "stdout lines emitted");
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
	assert.ok(lines.some((l) => l.includes('"pi.model"')));
	assert.ok(lines.some((l) => l.includes('"pi.replayed":true') || l.includes('"pi.replay\\"') || l.includes("pi.replay")), "resource marking rides along");

	// --branch changes the span set
	const branched = await run(`report ${join(FIXTURES, "forked.jsonl")} --branch=c1`);
	assert.ok(branched.includes('"m2"'), "the fork's model is included");
	assert.ok(!branched.includes("active branch answer"), "abandoned entries excluded");

	// id mode: resolve against the ctx session dir (header wins over file name)
	const sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir);
	writeFileSync(join(sessionsDir, "renamed-whatever.jsonl"), readFileSync(join(FIXTURES, "straight.jsonl")));
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: sessionsDir };
	const byId = await run("report 0193aaaa-0001-7000-8000-000000000001");
	assert.ok(byId.includes('"pi.session"'));

	// two-arg form: id + explicit dir
	const byIdDir = await run(`report 0193aaaa-0001-7000-8000-000000000001 ${sessionsDir}`);
	assert.ok(byIdDir.includes('"pi.session"'));
});

test("report --otlp / --file: the flagged sinks reuse the report's resource; distinct error paths", async () => {
	// --otlp without an endpoint
	piObs(pi as never); // inactive telemetry
	const noEndpoint = await run(`report ${join(FIXTURES, "straight.jsonl")} --otlp`);
	assert.match(noEndpoint, /no OTLP endpoint configured/);

	// --otlp to the throwaway receiver: same span set as stdout
	const receiver = await startReceiver();
	try {
		pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: join(dir, "sessions") });
		activate({ PI_OBS_OTLP_ENDPOINT: receiver.url });
		const out = await run(`report ${join(FIXTURES, "straight.jsonl")} --otlp`);
		assert.match(out, new RegExp(`posted \\d+ record\\(s\\) to ${receiver.url.replaceAll("/", "\\/")}`));
		const traces = receiver.requests.filter((r) => r.path === "/v1/traces");
		assert.ok(traces.length > 0);
		const names = traces
			.flatMap((r) => (JSON.parse(r.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans)
			.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => s.name)))
			.sort();
		const stdoutNames = out
			.split("\n")
			.filter((l) => l.includes('"resourceSpans"'))
			.map((l) => (JSON.parse(l) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans[0].scopeSpans[0].spans[0].name)
			.sort();
		assert.deepEqual(names, stdoutNames, "receiver saw the same span set as stdout");
		const body = traces[0]?.body ?? "";
		assert.ok(body.includes("pi.replayed"), "the report's resource (with the replay marking) is reused");

		// --file: writes the same lines to a file
		const target = join(dir, "report-out.jsonl");
		const filed = await run(`report ${join(FIXTURES, "straight.jsonl")} --file=${target}`);
		assert.match(filed, new RegExp(`wrote \\d+ line\\(s\\) to ${target.replaceAll("/", "\\/")}`));
		const written = readFileSync(target, "utf8").split("\n").filter((l) => l !== "");
		const stdoutReportLines = filed.split("\n").filter((l) => l.startsWith("{"));
		assert.equal(written.length, stdoutReportLines.length, "the file holds exactly the stdout report's lines — the same encoding");
		for (let i = 0; i < written.length; i++) assert.equal(written[i], stdoutReportLines[i], `line ${i} identical`);
		assert.ok(written.some((l) => l.includes('"pi.replayed"')));
	} finally {
		await receiver.close();
	}

	// --file into a session directory: the R2 rule rejects it with its message
	const badTarget = join(dir, "sessions", "ws", "report.jsonl");
	const rejected = await run(`report ${join(FIXTURES, "straight.jsonl")} --file=${badTarget}`);
	assert.match(rejected, /is inside a session directory/);
});

test("stats regression (R7 AC): /pi-obs, /pi-obs json, /pi-obs all are byte-identical goldens", async () => {
	piObs(pi as never); // telemetry inactive — the stats surface works regardless (R6/R7)
	const branch = [
		{ type: "message", timestamp: "2024-12-03T14:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1733234401000 } },
		{ type: "message", timestamp: "2024-12-03T14:01:01.000Z", message: { role: "assistant", provider: "openrouter", model: "m", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } }, stopReason: "stop", timestamp: 1733234461000 } },
	];
	pi.contextOptions = { cwd: "/work/demo", sessionId: "s", sessionDir: join(dir, "sessions"), branch };

	// bare report — golden captured from the pre-spec implementation (stats.ts untouched since)
	assert.equal(
		await run(""),
		"pi-obs · session\nmessages: 2 (user 1 · assistant 1 · tool results 0)\nduration: 1m 00s\ntokens: 150 (in 100 · out 50 · cache read 0 · reasoning 0)\ncost: $0.0020\nmodels: openrouter/m (1 turn, $0.0020)",
	);

	// json — byte-identical (the exact pretty-printed golden, line by line)
	const goldenJson = [
		"{",
		'  "userMessages": 1,',
		'  "assistantMessages": 1,',
		'  "toolResults": 0,',
		'  "usage": {',
		'    "input": 100,',
		'    "output": 50,',
		'    "cacheRead": 0,',
		'    "cacheWrite": 0,',
		'    "reasoning": 0,',
		'    "totalTokens": 150',
		"  },",
		'  "cost": 0.002,',
		'  "models": [',
		"    {",
		'      "provider": "openrouter",',
		'      "model": "m",',
		'      "turns": 1,',
		'      "usage": {',
		'        "input": 100,',
		'        "output": 50,',
		'        "cacheRead": 0,',
		'        "cacheWrite": 0,',
		'        "reasoning": 0,',
		'        "totalTokens": 150',
		"      },",
		'      "cost": 0.002',
		"    }",
		"  ],",
		'  "firstTimestamp": "2024-12-03T14:00:01.000Z",',
		'  "lastTimestamp": "2024-12-03T14:01:01.000Z",',
		'  "durationMs": 60000',
		"}",
	].join("\n");
	assert.equal(await run("json"), goldenJson);

	// all — with a fixed-mtime file, byte-identical including the timestamp column
	const sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const file = join(sessionsDir, "golden.jsonl");
	writeFileSync(file, branch.map((e) => JSON.stringify(e)).join("\n") + "\n");
	utimesSync(file, new Date("2024-12-03T14:02:00.000Z"), new Date("2024-12-03T14:02:00.000Z"));
	pi.contextOptions = { cwd: "/work/demo", sessionId: "s", sessionDir: sessionsDir };
	assert.equal(await run("all"), "pi-obs · 1 session · total 150 tok · $0.0020\n\n2024-12-03 14:02 · 150 tok · $0.0020 · golden.jsonl");
});
