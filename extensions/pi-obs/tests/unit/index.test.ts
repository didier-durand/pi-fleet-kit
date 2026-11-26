/**
 * pi-obs — extension-entry tests (SPECS R1/R2/R3/R6/R7 ACs, DEV_PLAN
 * Step 6), driven through the mock harness (tests/harness.ts) with a
 * REAL file exporter (config: PI_OBS_FILE=1 into a temp dir) — the
 * export file is the ground truth the assertions read.
 *
 *   - subscriptions are exactly the A ∪ B hooks when active; the 3
 *     category-D hooks have NO handler (SPECS R3 AC); inactive by
 *     default → only the 4 stats hooks (R6 master rule);
 *   - a scripted event sequence (prompt → turn → model call with
 *     usage → tool call → settle) produces exactly
 *     pi.session > pi.run > pi.turn > { pi.model, pi.tool … }
 *     (SPECS R3 smoke AC, harness level), with events, metrics, and
 *     GenAI attributes on the model span;
 *   - every category-C handler returns undefined (inert);
 *   - a throwing handler is isolated exactly once: one stderr report,
 *     one OTel log record, emission disabled, pi never sees the
 *     throw (R1 AC);
 *   - the canary secret never reaches the export under ANY capture
 *     setting — omitted by default, REDACTED under the opt-ins (R2);
 *   - pi.appendEntry is never called in any path (R1);
 *   - the stats feature is retained: footer status with UI, /pi-obs
 *     report/json/all, print-mode stdout emit (R7);
 *   - defensive: every hook fires safely with garbage payloads and
 *     before any session exists;
 *   - live smoke (model-gated on OPENROUTER_API_KEY + the pi binary):
 *     a scripted `pi -e ./pi-obs/index.ts -p …` run exports the
 *     expected hierarchy, and the same prompt without pi-obs yields
 *     identical output and exit code (R1 AC). Auto-skips without a
 *     key (the CI path).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import piObs from "../../src/index.ts";
import { mockContext, mockPi, type MockContextOptions, type MockPi } from "../harness.ts";
import { startReceiver } from "../otlp_receiver.ts";
import { INERT_HOOKS, SUBSCRIBED_HOOKS, UNSUBSCRIBED_HOOKS } from "../../src/hooks.ts";

const ENV_KEYS = ["PI_HOME", "HOME", "PI_OBS_FILE", "PI_OBS_FILE_PATH", "PI_OBS_CAPTURE_PROMPTS", "PI_OBS_CAPTURE_TOOL_IO", "PI_OBS_QUEUE_MAX", "PI_SERVE_DIR", "PI_OBS_OTLP_ENDPOINT", "PI_OBS_ENABLED", "PI_OBS_RESOURCE_SERVICE"];
let savedEnv: Record<string, string | undefined>;
let dir: string;
let exportPath: string;
let pi: MockPi;
let stderr: string[];
let stdout: string[];
const realError = console.error;
const realLog = console.log;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	dir = mkdtempSync(join(tmpdir(), "pi-obs-idx-"));
	exportPath = join(dir, "pi-obs.jsonl");
	process.env.PI_HOME = dir; // no settings.json here: env + defaults only
	process.env.HOME = dir;
	stderr = [];
	stdout = [];
	console.error = (message?: unknown) => {
		stderr.push(String(message));
	};
	console.log = (message?: unknown) => {
		stdout.push(String(message));
	};
	pi = mockPi({ cwd: "/work/demo", sessionId: "sess-0001", sessionFile: "/work/demo/.pi/sessions/sess-0001.jsonl", sessionDir: dir, model: { provider: "openrouter", id: "nvidia/nemotron-3.5-lightning" } });
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

/** Activate telemetry via the file exporter. */
const activate = (extra: Record<string, string> = {}) => {
	process.env.PI_OBS_FILE = "1";
	process.env.PI_OBS_FILE_PATH = exportPath;
	delete process.env.PI_OBS_ENABLED; // the container may inject PI_OBS_ENABLED=0 — tests control their own env
	for (const [key, value] of Object.entries(extra)) process.env[key] = value;
	piObs(pi as never);
};

/** The export file's OTLP/JSON lines (spans/metrics/logs, one per line). */
const exported = (): Record<string, never>[] => {
	try {
		return readFileSync(exportPath, "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, never>);
	} catch {
		return [];
	}
};

/** The span records from the export, decoded to {name, parent, trace, events, attrs}. */
const spans = () =>
	exported()
		.filter((l) => "resourceSpans" in l)
		.map((l) => {
			const rs = (l as unknown as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] }).resourceSpans[0];
			return rs.scopeSpans[0].spans[0] as {
				name: string;
				traceId: string;
				spanId: string;
				parentSpanId?: string;
				attributes: { key: string; value: Record<string, unknown> }[];
				events: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
			};
		});

const metricPoints = (name: string) =>
	exported()
		.filter((l) => "resourceMetrics" in l)
		.map((l) => (l as unknown as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum?: { dataPoints: Record<string, unknown>[] }; histogram?: { dataPoints: Record<string, unknown>[] } }[] }[] }[] }).resourceMetrics[0].scopeMetrics[0].metrics[0])
		.filter((m) => m.name === name);

/** The scripted happy-path sequence (one prompt, one model call, one tool call). */
async function scriptedSession(pi: MockPi, ctxOpts: MockContextOptions = {}): Promise<void> {
	const ctx = mockContext({ cwd: "/work/demo", sessionId: "sess-0001", sessionFile: "/work/demo/.pi/sessions/sess-0001.jsonl", model: { provider: "openrouter", id: "nvidia/nemotron-3.5-lightning" }, ...ctxOpts });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("resources_discover", { reason: "startup", cwd: "/work/demo" }, ctx);
	await pi.emit("input", { text: "please run the tests", source: "interactive" }, ctx);
	await pi.emit("before_agent_start", { messageType: "user" }, ctx);
	await pi.emit("turn_start", { turnIndex: 0 }, ctx);
	await pi.emit("before_provider_headers", { headers: { authorization: "Bearer secret-token", "x-other": "1" } }, ctx);
	await pi.emit("before_provider_request", { payload: {} }, ctx);
	await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
	await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
	await pi.emit("after_provider_response", { status: 200 }, ctx);
	await pi.emit("message_end", { message: { role: "assistant", provider: "openrouter", model: "nvidia/nemotron-3.5-lightning", stopReason: "stop", usage: { input: 1523, output: 287, cacheRead: 40960, cacheWrite: 0, reasoning: 512, totalTokens: 43282, cost: { total: 0.001234 } } } }, ctx);
	await pi.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: {} }, ctx);
	await pi.emit("tool_call", { toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } }, ctx);
	await pi.emit("tool_execution_update", { toolCallId: "call-1", toolName: "bash" }, ctx);
	await pi.emit("tool_result", { toolCallId: "call-1", toolName: "bash", content: "all good", isError: false }, ctx);
	await pi.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash", result: "ok", isError: false, durationMs: 137 }, ctx);
	await pi.emit("turn_end", { turnIndex: 0 }, ctx);
	await pi.emit("agent_settled", { aborted: false }, ctx);
	await pi.emit("session_shutdown", { reason: "quit" }, ctx);
}

test("active: subscriptions are exactly the A∪B hooks; the 3 category-D hooks have none", () => {
	activate();
	assert.deepEqual([...pi.subscribed()].sort(), [...SUBSCRIBED_HOOKS].sort(), "exactly A∪B (38)");
	for (const hook of UNSUBSCRIBED_HOOKS) assert.ok(!pi.subscribed().includes(hook), `${hook} (category D) must have no handler`);
	assert.equal(pi.subscribed().length, 38);
});

test("inactive by default: only the stats hooks; stats commands still work (R6/R7)", async () => {
	piObs(pi as never); // no exporter configured
	assert.deepEqual(pi.subscribed().sort(), ["agent_settled", "session_start", "session_tree", "turn_end"]);
	assert.ok(pi.commands.has("pi-obs"));
	await pi.runCommand("pi-obs");
	assert.ok(stdout.some((l) => l.includes("pi-obs · session")), "print-mode emit goes to stdout");
});

test("scripted sequence: exactly pi.session > pi.run > pi.turn > { pi.model, pi.tool … } (R3 smoke AC)", async () => {
	activate();
	await scriptedSession(pi);

	const byName = new Map(spans().map((s) => [s.name, s]));
	const session = byName.get("pi.session");
	const run = byName.get("pi.run");
	const turn = byName.get("pi.turn");
	const model = byName.get("pi.model");
	const tool = byName.get("pi.tool bash");
	assert.ok(session && run && turn && model && tool, `spans: ${[...byName.keys()].join(", ")}`);
	assert.equal(session.parentSpanId, undefined);
	assert.equal(run.traceId, session.traceId, "one trace per session lifetime");
	assert.ok(run.spanId !== undefined && run.parentSpanId === session.spanId);
	assert.equal(turn.parentSpanId, run.spanId);
	assert.equal(model.parentSpanId, turn.spanId);
	assert.equal(tool.parentSpanId, turn.spanId);

	// root attributes + the user-input event (hash + length, no text by default)
	const rootAttrs = Object.fromEntries(session.attributes.map((a) => [a.key, a.value]));
	assert.equal(rootAttrs["pi.session.id"].stringValue, "sess-0001");
	assert.equal(rootAttrs["pi.session.reason"].stringValue, "startup");
	assert.equal(rootAttrs["pi.cwd"].stringValue, "/work/demo");
	const inputEvent = session.events.find((e) => e.name === "pi.user.input");
	assert.ok(inputEvent !== undefined);
	const inputAttrs = Object.fromEntries(inputEvent.attributes.map((a) => [a.key, a.value]));
	assert.equal(inputAttrs["pi.source"].stringValue, "interactive");
	assert.equal(inputAttrs["pi.content.length"].intValue, "20", "character count of \"please run the tests\"");
	assert.match(String(inputAttrs["pi.content.hash"].stringValue), /^[0-9a-f]{12}$/);
	assert.ok(!("pi.content.text" in inputAttrs), "no verbatim text by default (R2)");
	assert.ok(session.events.some((e) => e.name === "pi.resources"));

	// model span: GenAI attributes from the message_end payload + header NAMES only
	const modelAttrs = Object.fromEntries(model.attributes.map((a) => [a.key, a.value]));
	assert.equal(modelAttrs["gen_ai.system"].stringValue, "openrouter");
	assert.equal(modelAttrs["gen_ai.request.model"].stringValue, "nvidia/nemotron-3.5-lightning");
	assert.equal(modelAttrs["gen_ai.usage.input_tokens"].intValue, "1523");
	assert.equal(modelAttrs["pi.cost.total"].doubleValue, 0.001234);
	assert.equal(modelAttrs["pi.stop_reason"].stringValue, "stop");
	const headerEvent = model.events.find((e) => e.name === "pi.model.headers");
	assert.ok(headerEvent !== undefined);
	const headerAttrs = Object.fromEntries(headerEvent.attributes.map((a) => [a.key, a.value]));
	assert.equal(headerAttrs["pi.header.names"].stringValue, "authorization,x-other");
	assert.ok(!JSON.stringify(headerAttrs).includes("secret-token"), "R2: header VALUES never captured");
	assert.ok(model.events.some((e) => e.name === "pi.model.response_status"));

	// tool span: outcome event, duration histogram, no result body by default
	assert.ok(tool.events.some((e) => e.name === "pi.tool.outcome"));
	const toolAttrs = Object.fromEntries(tool.attributes.map((a) => [a.key, a.value]));
	assert.equal(toolAttrs["pi.tool.name"].stringValue, "bash");
	assert.ok(!("pi.tool.result" in toolAttrs), "tool result bodies omitted by default (R2)");

	// metrics from the sequence
	assert.equal(metricPoints("pi.model.requests").length, 1);
	assert.equal(metricPoints("pi.messages").length, 2, "one per streaming delta");
	assert.equal(metricPoints("pi.model.time_to_first_token").length, 1);
	assert.ok(metricPoints("pi.tokens").length >= 4, "type-distinguished token counters");
	assert.equal(metricPoints("pi.tool.calls").length, 1);
	assert.equal(metricPoints("pi.tool.updates").length, 1);
	assert.equal(metricPoints("pi.tool.duration").length, 1);

	// everything flushed at shutdown: no dangling queue work
	assert.ok(pi.appendEntryCalls.length === 0, "R1: appendEntry never called");
});

test("category C: every inert hook's handler returns undefined (observe only)", async () => {
	activate();
	const payloads: Record<string, unknown> = {
		input: { text: "hi", source: "interactive" },
		context: { messages: [{}, {}] },
		context_with_system: { messages: [{}] },
		before_provider_headers: { headers: { a: "1" } },
		before_provider_request: { payload: {} },
		tool_call: { toolCallId: "t", toolName: "bash", input: { command: "ls" } },
		tool_result: { toolCallId: "t", content: "x", isError: false },
		session_before_switch: { reason: "new" },
		session_before_fork: { entryId: "e1", position: "before" },
		session_before_compact: { reason: "manual", preparation: { tokensBefore: 10 } },
		session_before_tree: { preparation: { targetId: "x" } },
		cache_warming_decision: { action: "warm" },
	};
	await pi.emit("session_start", { reason: "startup" });
	for (const hook of INERT_HOOKS) {
		const result = await pi.emit(hook, payloads[hook] ?? {});
		assert.equal(result, undefined, `${hook} must be inert (return undefined)`);
	}
});

test("fault isolation: one stderr report, one OTel log record, emission disabled, pi unaffected (R1 AC)", async () => {
	activate();
	await pi.emit("session_start", { reason: "startup" }); // healthy start: the root span is open
	// force a real handler throw through its one external dependency: a pi ctx method
	// that explodes when the handler reads it (a broken pi API, exactly what R1 isolates)
	const poisoned = mockContext({ sessionId: "sess-0001", sessionFile: "/x.jsonl" });
	(poisoned.sessionManager as unknown as { getSessionId: () => string }).getSessionId = () => {
		throw new Error("pi API exploded");
	};
	stderr = [];
	const result = await pi.emit("session_start", { reason: "reload" }, poisoned);
	assert.equal(result, undefined, "pi never sees the throw");
	assert.equal(stderr.length, 1, "exactly one stderr report");
	assert.match(stderr[0] ?? "", /pi-obs: session_start handler failed once/);
	assert.match(stderr[0] ?? "", /pi API exploded/);

	// the emission is disabled: a healthy session_start no longer opens a span
	await pi.emit("session_start", { reason: "reload" });
	assert.equal(stderr.length, 1, "no second report");
	await pi.emit("session_shutdown", { reason: "quit" });
	const roots = spans().filter((s) => s.name === "pi.session");
	assert.equal(roots.length, 1, "the healthy session's span is the only root: the faulted session_start never opened another");

	// the fault itself became an OTel log record (R4: never stderr-only)
	const logs = exported()
		.filter((l) => "resourceLogs" in l)
		.map((l) => (l as unknown as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string }; severityText: string }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0]);
	assert.ok(logs.some((rec) => rec.body.stringValue.includes("handler fault on session_start") && rec.severityText === "ERROR"));
	assert.equal(pi.appendEntryCalls.length, 0, "R1 holds even on the fault path");
});

test("tool IO capture: tool_call records the input JSON as pi.tool.input (R2 opt-in, redacted, no fault)", async () => {
	// regression: pi.tool.input was emitted without a semconv row — the R4
	// fail-closed validation threw and the tool_call handler was disabled
	// for the whole session (the CI fleet test surfaced the fault record)
	activate({ PI_OBS_CAPTURE_TOOL_IO: "1" });
	const ctx = mockContext({ sessionId: "sess-0001", sessionFile: "/work/demo/.pi/sessions/sess-0001.jsonl" });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("before_agent_start", { messageType: "user" }, ctx);
	await pi.emit("turn_start", { turnIndex: 0 }, ctx);
	await pi.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash" }, ctx);
	// the credential pattern must be one redact() catches INSIDE JSON —
	// the sk- pattern matches the raw value regardless of JSON quoting
	// (kept under 20 chars so the pre-commit secret scanner lets it pass
	// as an obvious fixture)
	await pi.emit("tool_call", { toolCallId: "call-1", toolName: "bash", input: { command: "send.sh pi-developer -", api_key: "sk-abcdefgh12345678" } }, ctx);
	await pi.emit("tool_result", { toolCallId: "call-1", toolName: "bash", content: "sent: /exchange/pi-developer/inbox/msg-1.json", isError: false }, ctx);
	await pi.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash", isError: false, durationMs: 12 }, ctx);
	await pi.emit("turn_end", { turnIndex: 0 }, ctx);
	await pi.emit("agent_settled", { aborted: false }, ctx);
	await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	assert.equal(stderr.length, 0, "no handler fault — pi.tool.input is registered (R4)");
	const tool = spans().find((s) => String(s.name) === "pi.tool bash");
	assert.ok(tool, "the bash tool span exists");
	const outcome = (tool!.events as { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[]).flat().find((e) => e.name === "pi.tool.outcome");
	assert.ok(outcome, "the pi.tool.outcome event exists (the handler was not disabled)");
	const input = String(outcome.attributes.find((a) => a.key === "pi.tool.input")?.value?.stringValue ?? "");
	assert.ok(input.includes("send.sh pi-developer -"), "the input JSON is captured");
	assert.ok(!input.includes("sk-abcdefgh12345678"), "R2 redaction applied before the queue");
	assert.ok(input.includes("[REDACTED]"), "the credential became [REDACTED]");
});

test("R2 canary: the secret never reaches the export under ANY capture setting", async () => {
	const canary = "zlX9.trap-Canary_q7r8s9t0u1";

	// default: no verbatim text at all
	activate();
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("input", { text: `help with SECRET_CANARY=${canary}`, source: "interactive" }, mockContext());
	await pi.emit("session_shutdown", { reason: "quit" });
	let wire = readFileSync(exportPath, "utf8");
	assert.ok(!wire.includes(canary), "default: canary absent (text never captured)");
	for (let i = 0; i + 8 <= canary.length; i++) assert.ok(!wire.includes(canary.slice(i, i + 8)), `default: substring leak ${canary.slice(i, i + 8)}`);

	// opt-in prompts: text captured, but REDACTED before the queue
	rmSync(exportPath, { force: true });
	pi = mockPi({ cwd: "/work/demo", sessionId: "s", model: { provider: "openrouter", id: "m" } });
	activate({ PI_OBS_CAPTURE_PROMPTS: "1" });
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("input", { text: `help with SECRET_CANARY=${canary}`, source: "interactive" }, mockContext());
	await pi.emit("session_shutdown", { reason: "quit" });
	wire = readFileSync(exportPath, "utf8");
	assert.ok(wire.includes("[REDACTED]"), "opt-in: redaction marker present");
	assert.ok(!wire.includes(canary), "opt-in: canary value redacted before export");
	for (let i = 0; i + 8 <= canary.length; i++) assert.ok(!wire.includes(canary.slice(i, i + 8)), `opt-in: substring leak ${canary.slice(i, i + 8)}`);

	// opt-in tool IO: result bodies redacted too
	rmSync(exportPath, { force: true });
	pi = mockPi({ cwd: "/work/demo", sessionId: "s", model: { provider: "openrouter", id: "m" } });
	activate({ PI_OBS_CAPTURE_TOOL_IO: "1" });
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("before_agent_start", {});
	await pi.emit("turn_start", { turnIndex: 0 });
	await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	await pi.emit("tool_result", { toolCallId: "c1", content: `output token=${canary}`, isError: false });
	await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false, durationMs: 5 });
	await pi.emit("session_shutdown", { reason: "quit" });
	wire = readFileSync(exportPath, "utf8");
	assert.ok(!wire.includes(canary), "tool IO opt-in: canary redacted");
	assert.ok(wire.includes("[REDACTED]"));
});

test("help: lists every subcommand, env vars, and the standalone CLI pointer (R7)", async () => {
	activate();
	stdout = [];
	await pi.runCommand("pi-obs", "help");
	const text = stdout.join("\n");
	// every subcommand is listed with its /pi-obs <sub> form
	for (const sub of ["json", "all", "status", "flush", "report", "help"]) {
		assert.ok(text.includes(`/pi-obs ${sub}`), `help lists /pi-obs ${sub}`);
	}
	assert.ok(text.includes("piobs --help"), "help points to the standalone CLI");
	assert.ok(text.includes("PI_OBS_OTLP_ENDPOINT"), "help names the OTLP env var");
	assert.ok(text.includes("PI_OBS_FILE"), "help names the file-export env var");
});

test("stats retained: footer status with UI, /pi-obs json + all, print-mode stdout (R7)", async () => {
	activate();
	const branch = [
		{ type: "message", timestamp: "2024-12-03T14:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1733234401000 } },
		{ type: "message", timestamp: "2024-12-03T14:01:01.000Z", message: { role: "assistant", provider: "openrouter", model: "m", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } }, stopReason: "stop", timestamp: 1733234461000 } },
	];
	const shortBranch = [
		{ type: "message", timestamp: "2024-12-03T14:00:01.000Z", message: { role: "user", content: "quick", timestamp: 1733234401000 } },
		{ type: "message", timestamp: "2024-12-03T14:00:04.000Z", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.0002 } }, stopReason: "stop", timestamp: 1733234404000 } },
	];
	const uiCtx = mockContext({ mode: "tui", hasUI: true, branch, sessionId: "s", sessionDir: dir });
	await pi.emit("session_start", { reason: "startup" }, uiCtx);
	await pi.emit("turn_end", {}, uiCtx);
	const status = (pi.lastContext as unknown as { uiLog: { status: { key: string; value: string }[] } }).uiLog.status;
	assert.ok(status.some((s) => s.key === "pi-obs" && s.value.includes("tok") && s.value.includes("$")), `footer status line: ${JSON.stringify(status)}`);

	// a sub-minute session: bare report shows "3s" duration and sub-cent cost
	pi.contextOptions = { cwd: "/work/demo", sessionId: "s3", sessionDir: dir, branch: shortBranch };
	stdout = [];
	await pi.runCommand("pi-obs");
	assert.ok(stdout.some((l) => l.includes("duration: 3s")), `short duration format: ${stdout.join("|").slice(0, 160)}`);
	assert.ok(stdout.some((l) => l.includes("$0.0002")), "sub-cent cost in the report");

	// zero-usage branch: an empty branch clears the footer ("" — not stale text)
	const emptyCtx = mockContext({ mode: "tui", hasUI: true, branch: [], sessionId: "s2" });
	await pi.emit("session_start", { reason: "startup" }, emptyCtx);
	const cleared = (pi.lastContext as unknown as { uiLog: { status: { key: string; value: string }[] } }).uiLog.status;
	assert.ok(cleared.some((s) => s.key === "pi-obs" && s.value === ""), `zero usage clears the footer: ${JSON.stringify(cleared)}`);

	// /pi-obs json in print mode → stdout
	await pi.runCommand("pi-obs", "json");
	assert.ok(stdout.some((l) => l.includes('"totalTokens"')), "json stats on stdout");

	// /pi-obs all with a session dir containing one file (dedicated dir: the
	// export file also ends in .jsonl and must not be counted as a session)
	const sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir);
	writeSessionFile(join(sessionsDir, "one.jsonl"), branch);
	pi.contextOptions = { cwd: "/work/demo", sessionId: "s", sessionDir: sessionsDir };
	await pi.runCommand("pi-obs", "all");
	assert.ok(stdout.some((l) => l.includes("1 session")), `aggregate report: ${stdout.join("|").slice(0, 120)}`);
	assert.ok(!stdout.some((l) => l.includes("pi-obs.jsonl")), "the telemetry export file is not a session");
	assert.equal(pi.appendEntryCalls.length, 0);
});

test("defensive: every subscribed hook fires safely with garbage payloads and no session", async () => {
	activate();
	for (const hook of SUBSCRIBED_HOOKS) {
		await pi.emit(hook, {}); // no session open yet — guards must drop, never throw
		await pi.emit(hook, { garbage: true, nested: { junk: [1, 2, null] } }); // after nothing: still no session
	}
	await pi.emit("session_start", { reason: "startup" });
	for (const hook of SUBSCRIBED_HOOKS) {
		await pi.emit(hook, {}); // session open, empty payloads — defensive reads, never throw
	}
	await pi.emit("session_shutdown", { reason: "quit" });
	assert.equal(stderr.filter((l) => l.includes("handler failed")).length, 0, "no handler faulted on garbage");
	assert.equal(pi.appendEntryCalls.length, 0);
});

test("config errors are reported, never thrown; telemetry still activates", () => {
	stderr = [];
	activate({ PI_OBS_QUEUE_MAX: "not-a-number" });
	assert.ok(stderr.some((l) => l.includes("PI_OBS_QUEUE_MAX")), "invalid value reported by name");
	assert.equal(pi.subscribed().length, 38, "telemetry active with the default standing");
});

/** Write a session-shaped JSONL file for /pi-obs all. */
function writeSessionFile(path: string, branch: unknown[]): void {
	writeFileSync(path, branch.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("stats depth: rich branch drives computeStats/reportSession/format paths", async () => {
	activate();
	const iso = (seconds: number): string => new Date(Date.UTC(2024, 11, 3, 14, 0, seconds)).toISOString();
	const rich = [
		{ type: "message", timestamp: iso(0), message: { role: "user", content: "hello", timestamp: 1733234401000 } },
		{ type: "message", timestamp: iso(2), message: { role: "assistant", provider: "openrouter", model: "model-a", usage: { input: 900000, output: 800000, cacheRead: 500000, cacheWrite: 300000, reasoning: 200000, totalTokens: 2500000, cost: { total: 12.3456 } }, stopReason: "stop", timestamp: 1733234402000 } },
		{ type: "message", timestamp: iso(66), message: { role: "assistant", provider: "openrouter", model: "model-b", usage: { input: 100, output: 50, cost: { total: 0.001 } }, stopReason: "stop", timestamp: 1733234403000 } },
		{ type: "usage", kind: "cache_warm", provider: "openrouter", model: "model-a", usage: { cacheRead: 40960, totalTokens: 40960, cost: { total: 0.015 } } },
		{ type: "message", timestamp: iso(67), message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "ok", isError: false, timestamp: 1733234404000 } },
		{ type: "message", timestamp: iso(7300), message: { role: "assistant", usage: { input: 3, cost: { total: 0.00005 } }, stopReason: "stop", timestamp: 1733234405000 } }, // unknown model, sub-0.0001 cost
		{ type: "message", timestamp: iso(7302), message: { role: "assistant", provider: "openrouter", model: "model-a", usage: { input: 7 }, stopReason: "stop", timestamp: 1733234406000 } }, // 2nd model-a turn: plural, usage without cost/totalTokens
		{ type: "message", timestamp: iso(7303), message: { role: "assistant", stopReason: "stop", timestamp: 1733234407000 } }, // assistant without usage at all
		{ type: "message", timestamp: iso(7304), message: null }, // message entry with a null message (skipped)
		{ type: "message", timestamp: iso(7305), message: { role: "system", content: "ignored role", timestamp: 1733234408000 } }, // role outside user/assistant/toolResult
		{ type: "compaction", timestamp: iso(7306) }, // non-message, non-usage entry type
	];
	// footer over the rich branch (stats handler path)
	const uiCtx = mockContext({ mode: "tui", hasUI: true, branch: rich, sessionId: "s" });
	await pi.emit("session_start", { reason: "startup" }, uiCtx);
	const uiLog = (pi.lastContext as unknown as { uiLog: { status: { key: string; value: string }[] } }).uiLog;
	const footer = uiLog.status.find((st) => st.key === "pi-obs")?.value ?? "";
	assert.match(footer, /M tok/, `K/M formatting: "${footer}"`);
	assert.match(footer, /\$/);

	// /pi-obs (text report) over the rich branch: per-model lines, most expensive first
	stdout = [];
	pi = mockPi({ cwd: "/w", sessionId: "s", sessionDir: dir, branch: rich });
	piObs(pi as never);
	await pi.runCommand("pi-obs");
	const report = stdout.join("\n");
	assert.ok(report.includes("model-a"), `models reported: ${report.slice(0, 200)}`);
	assert.ok(report.includes("model-b"));
	assert.ok(report.indexOf("model-a") < report.indexOf("model-b"), "most expensive model first");
	assert.ok(report.includes("tokens: 2.54M"), `session total formatted: ${report.slice(0, 260)}`);
	assert.ok(report.includes("in 900.1k"), "per-kind token breakdown");
	assert.ok(report.includes("cost: $12.36"), "cost formatting");
	assert.ok(report.includes("duration: 2h 01m"), `duration across the ISO-timestamped entries: ${report.slice(0, 260)}`);
	assert.ok(report.includes("unknown/unknown"), "model-less assistant attributed to unknown");
	assert.ok(report.includes("2 turns"), "plural turn count for model-a");
	assert.ok(report.includes("<$0.0001"), "sub-cent cost formatting");
});

test("/pi-obs all edge paths: no dir, empty dir, unreadable entries, many files", async () => {
	activate();
	const branch = [{ type: "message", timestamp: "2024-12-03T14:00:01.000Z", message: { role: "assistant", provider: "p", model: "m", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } }, stopReason: "stop", timestamp: 1733234401000 } }];

	// no session directory at all (getSessionDir points nowhere) → report, not crash
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: join(dir, "does-not-exist") };
	await pi.runCommand("pi-obs", "all");
	assert.ok(stdout.some((l) => l.includes("no session")), `missing dir handled: ${stdout.join("|").slice(0, 100)}`);

	// empty directory → "no sessions found"
	const empty = join(dir, "empty");
	mkdirSync(empty);
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: empty };
	stdout = [];
	await pi.runCommand("pi-obs", "all");
	assert.ok(stdout.some((l) => l.includes("no sessions found")));

	// mixed content: a good file, a file with a malformed line, and a DIRECTORY named *.jsonl
	const mixed = join(dir, "mixed");
	mkdirSync(mixed);
	writeSessionFile(join(mixed, "good.jsonl"), branch);
	writeFileSync(join(mixed, "bad-line.jsonl"), '{"type":"message"\nnot json at all\n');
	mkdirSync(join(mixed, "sneaky.jsonl")); // readFileSync on a directory throws → skipped
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: mixed };
	stdout = [];
	await pi.runCommand("pi-obs", "all");
	assert.ok(stdout.some((l) => l.includes("2 session")), `good + empty-line file count; the unreadable dir does not: ${stdout.join("|").slice(0, 120)}`);
	assert.ok(!stdout.includes("sneaky.jsonl"), "a directory named *.jsonl is skipped");

	// more than 15 files → the "… and N more" line
	const many = join(dir, "many");
	mkdirSync(many);
	for (let i = 0; i < 17; i++) writeSessionFile(join(many, `s${i}.jsonl`), branch);
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: many };
	stdout = [];
	await pi.runCommand("pi-obs", "all");
	assert.ok(stdout.some((l) => l.includes("… and 2 more")), `overflow line: ${stdout.join("|").slice(0, 200)}`);
});

test("aborted runs record pi.run.aborted; stale model spans close at the next request", async () => {
	activate();
	const ctx = mockContext({ cwd: "/w", sessionId: "s", model: { provider: "openrouter", id: "m" } });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("before_agent_start", {}, ctx);
	await pi.emit("turn_start", { turnIndex: 0 }, ctx);
	await pi.emit("before_provider_request", { payload: {} }, ctx);
	await pi.emit("before_provider_request", { payload: {} }, ctx); // stale model: closed, second span opens
	await pi.emit("agent_settled", { aborted: true }, ctx); // aborted: pi.run.aborted event + close
	await pi.emit("session_shutdown", { reason: "quit" }, ctx);

	const roots = spans();
	const abortedRun = roots.find((sp) => sp.name === "pi.run");
	assert.ok(abortedRun?.events.some((e) => e.name === "pi.run.aborted"), "aborted flag recorded");
	assert.equal(roots.filter((sp) => sp.name === "pi.model").length, 2, "both model spans closed and exported");
});

test("both exporters active: OTLP to the receiver AND the file (config-driven)", async () => {
	const receiver = await startReceiver();
	try {
		process.env.PI_OBS_OTLP_ENDPOINT = receiver.url;
		activate();
		await pi.emit("session_start", { reason: "startup" });
		await pi.emit("input", { text: "dual export", source: "rpc" }, mockContext());
		await pi.emit("message_update", { message: { role: "assistant" } }); // metrics leg
		await pi.emit("session_shutdown", { reason: "quit" });
		const paths = receiver.requests.map((r) => r.path).sort();
		assert.ok(paths.includes("/v1/traces") && paths.includes("/v1/metrics"), `per-signal requests: ${paths.join(",")}`);
		assert.ok(spans().some((sp) => sp.name === "pi.session"), "file exporter leg also active");
	} finally {
		await receiver.close();
	}
});

test("settings.json pi-obs block merges (env absent): capturePrompts from settings", async () => {
	mkdirSync(join(dir, "agent"), { recursive: true });
	writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ "pi-obs": { capturePrompts: true } }));
	activate(); // PI_OBS_CAPTURE_PROMPTS NOT in env — the settings block applies
	await pi.emit("session_start", { reason: "startup" });
	await pi.emit("input", { text: "SECRET_CANARY=zz-redacted-from-settings", source: "interactive" }, mockContext());
	await pi.emit("session_shutdown", { reason: "quit" });
	const wire = readFileSync(exportPath, "utf8");
	assert.ok(wire.includes("[REDACTED]"), "settings-driven capturePrompts took effect (and redacted)");
	assert.ok(!wire.includes("zz-redacted-from-settings"));
});

test("harness spies: appendEntry records, unknown commands throw, notify path", async () => {
	activate(); // registers the stats feature + telemetry
	pi.appendEntry("sentinel"); // cover the spy body — the ONLY appendEntry call in these tests
	assert.equal(pi.appendEntryCalls.length, 1);
	assert.equal(pi.appendEntryCalls[0]?.[0], "sentinel");
	await assert.rejects(async () => pi.runCommand("no-such-command"), /no command/);
	// notify path: a command with a UI context emits via ui.notify
	pi.contextOptions = { cwd: "/w", sessionId: "s", sessionDir: dir, mode: "tui", hasUI: true };
	await pi.runCommand("pi-obs");
	const uiLog = (pi.lastContext as unknown as { uiLog: { notify: { text: string }[] } }).uiLog;
	assert.ok(uiLog.notify.some((n) => n.text.includes("pi-obs · session")), "UI notify emit path");
});

test("status: per-signal breakdown — spans vs metrics vs logs counted separately", async () => {
	activate();
	// emit events that generate all three signal kinds
	const branch = [
		{ type: "message", timestamp: "2024-12-03T14:00:01.000Z", message: { role: "user", content: "test question", timestamp: 1733234401000 } },
		{ type: "message", timestamp: "2024-12-03T14:01:01.000Z", message: { role: "assistant", provider: "openrouter", model: "m", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } }, stopReason: "stop", timestamp: 1733234461000 } },
	];
	const ctx = mockContext({ mode: "print", hasUI: false, branch, sessionId: "s-signals", sessionDir: dir });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("turn_end", {}, ctx);
	stdout = [];
	await pi.runCommand("pi-obs", "status");
	const text = stdout.join("\n");
	// the per-signal line must distinguish the three kinds
	assert.ok(text.includes("signals:"), `status has a signals line: ${text.slice(0, 300)}`);
	assert.match(text, /spans \d+/);
	assert.match(text, /metrics \d+/);
	assert.match(text, /logs \d+/);
	assert.match(text, /total/);
	// the total equals the sum of the three kinds
	const spans = Number(/spans (\d+)/.exec(text)?.[1] ?? 0);
	const metrics = Number(/metrics (\d+)/.exec(text)?.[1] ?? 0);
	const logs = Number(/logs (\d+)/.exec(text)?.[1] ?? 0);
	assert.equal(spans + metrics + logs, Number(/(\d+) total/.exec(text)?.[1] ?? 0), "total == spans + metrics + logs");
});
