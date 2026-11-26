/**
 * pi-obs — file exporter tests (SPECS R2/R5 ACs, DEV_PLAN Step 4).
 *
 *   - every written line parses as JSON and is a valid OTLP/JSON
 *     export-request body (resourceSpans / resourceMetrics /
 *     resourceLogs), with hex ids, string int64s, enum names;
 *   - rotation with a tiny byte limit produces exactly N files total,
 *     oldest dropped, newest records retained (SPECS R5 AC);
 *   - unreadable / read-only target directory → error report + drop
 *     counter, never a throw (R1);
 *   - session-dir target rejected at construction with the R2 message;
 *   - R2 redaction applied before write: the canary value (nor any
 *     ≥ 8-char substring of it) never reaches the file;
 *   - concurrent appends from the queue drain stay line-atomic;
 *   - counters observable for Step 8's /pi-obs status.
 *
 * Each test works in its own mkdtemp'd directory and cleans it up —
 * no leftovers, POSIX-safe paths.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FileExporter, assertNotSessionDir } from "../../../src/exporters/file.ts";
import { exportRequestLine, redact } from "../../../src/exporters/otlp-json.ts";
import {
	addEvent,
	counter,
	endSpan,
	histogram,
	logRecord,
	startModelSpan,
	startSessionSpan,
	startToolSpan,
	startTurnSpan,
	toUnixNano,
	type SpanData,
} from "../../../src/model.ts";
import type { TelemetryItem } from "../../../src/queue.ts";

const RESOURCE = { "service.name": "pi-agent", "pi.cwd": "/work/demo" } as Record<string, string | number | boolean>;
const T0 = 1_700_000_000_000;

const dirs: string[] = [];
const freshDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-obs-file-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? ".", { recursive: true, force: true });
});

/** A representative span tree item (session > turn > tool, with event + status). */
function spanItem(): TelemetryItem {
	const session = startSessionSpan({ "pi.session.id": "sess-1", "pi.cwd": "/work/demo" }, { nowMs: T0 });
	const turn = startTurnSpan(session, 0, undefined, { nowMs: T0 + 1 });
	const tool = startToolSpan(turn, "bash", undefined, { nowMs: T0 + 2 });
	addEvent(tool, "pi.tool.outcome", { "pi.outcome": "failed" }, T0 + 3);
	endSpan(tool, { code: "error", message: "exit 1", nowMs: T0 + 10 });
	return { kind: "span", span: tool };
}

function modelSpanItem(): TelemetryItem {
	const session = startSessionSpan({}, { nowMs: T0 });
	const turn = startTurnSpan(session, 1, undefined, { nowMs: T0 });
	const model = startModelSpan(turn, { "gen_ai.system": "openrouter", "gen_ai.usage.input_tokens": 1523, "pi.cost.total": 0.001234 }, { nowMs: T0 });
	endSpan(model, { nowMs: T0 + 500 });
	return { kind: "span", span: model };
}

const metricItems = (): TelemetryItem[] => [
	{ kind: "metric", metric: counter("pi.tokens", 40960, { "pi.token.type": "cacheRead" }, T0) },
	{ kind: "metric", metric: counter("pi.cost.total", 0.002468, undefined, T0) },
	{ kind: "metric", metric: histogram("pi.model.duration", 812.5, undefined, T0) },
];

const logItem = (): TelemetryItem => ({ kind: "log", log: logRecord("WARN", "batch dropped", { "pi.exporter.name": "file", "pi.dropped.count": 3 }, T0) });

const exporterAt = (dir: string, opts?: Partial<ConstructorParameters<typeof FileExporter>[0]>) =>
	new FileExporter({
		path: join(dir, "obs", "pi-obs.jsonl"),
		maxBytes: 10 * 1024 * 1024,
		maxFiles: 5,
		resource: RESOURCE,
		...opts,
	});

const linesOf = (path: string): string[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "");

test("every written line is a valid OTLP/JSON export-request body (spans, metrics, logs)", async () => {
	const dir = freshDir();
	const exp = exporterAt(dir);
	const toolSpanItem = spanItem();
	await exp.export([toolSpanItem, modelSpanItem(), ...metricItems(), logItem()]);
	assert.equal(exp.counters.written, 6);
	assert.equal(exp.counters.dropped, 0);
	assert.ok(exp.counters.lastExportAt !== null, "health: last export timestamp recorded");
	assert.equal(exp.counters.lastError, null, "health: no failure ever");
	assert.ok(exp.counters.lastExportAt !== null, "health: last export timestamp recorded");

	const lines = linesOf(join(dir, "obs", "pi-obs.jsonl"));
	assert.equal(lines.length, 6);
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), "each line must parse as JSON");

	// --- span record: resourceSpans, hex ids, string int64s, enum names ---
	const spanJson = JSON.parse(lines[0]) as {
		resourceSpans: {
			resource: { attributes: { key: string; value: { stringValue?: string } }[] };
			scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[];
		}[];
	};
	const rs = spanJson.resourceSpans[0];
	assert.deepEqual(
		rs.resource.attributes.find((a) => a.key === "service.name"),
		{ key: "service.name", value: { stringValue: "pi-agent" } },
	);
	const span = rs.scopeSpans[0].spans[0];
	assert.equal(span.name, "pi.tool bash");
	assert.equal(span.kind, "SPAN_KIND_INTERNAL");
	assert.equal(span.traceId, (toolSpanItem as { span: SpanData }).span.traceId);
	assert.match(String(span.traceId), /^[0-9a-f]{32}$/, "trace ids are hex on the wire (OTLP/JSON spec)");
	assert.equal(span.startTimeUnixNano, toUnixNano(T0 + 2));
	assert.equal((span.status as { code: string }).code, "STATUS_CODE_ERROR");
	assert.equal((span.status as { message?: string }).message, "exit 1");
	const event = (span.events as { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[])[0];
	assert.equal(event.name, "pi.tool.outcome");
	assert.deepEqual(event.attributes, [{ key: "pi.outcome", value: { stringValue: "failed" } }]);
	// int64 attribute values are JSON STRINGS (protobuf-JSON rule)
	const modelJson = JSON.parse(lines[1]) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] };
	const attrs = Object.fromEntries(modelJson.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, a.value]));
	assert.deepEqual(attrs["gen_ai.usage.input_tokens"], { intValue: "1523" });
	assert.deepEqual(attrs["pi.cost.total"], { doubleValue: 0.001234 });

	// --- metric records ---
	const counterJson = JSON.parse(lines[2]) as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum: { dataPoints: Record<string, unknown>[]; aggregationTemporality: string } }[] }[] }[] };
	const cm = counterJson.resourceMetrics[0].scopeMetrics[0].metrics[0];
	assert.equal(cm.name, "pi.tokens");
	assert.equal(cm.sum.dataPoints[0]?.asInt, "40960");
	assert.equal(cm.sum.aggregationTemporality, "AGGREGATION_TEMPORALITY_DELTA");
	assert.deepEqual(
		(cm.sum.dataPoints[0] as { attributes: unknown }).attributes,
		[{ key: "pi.token.type", value: { stringValue: "cacheRead" } }],
		"breakdown attributes ride under the data point's attributes array",
	);
	const costJson = JSON.parse(lines[3]) as { resourceMetrics: { scopeMetrics: { metrics: { sum: { dataPoints: Record<string, unknown>[] } }[] }[] }[] };
	assert.equal(costJson.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]?.asDouble, 0.002468);
	// histogram record — a dedicated export (the mixed batch above has no histogram)
	const dir2 = freshDir();
	const exp2 = exporterAt(dir2);
	await exp2.export([{ kind: "metric", metric: histogram("pi.model.duration", 812.5, undefined, T0) }]);
	type HistPoint = { count: string; sum: number; min: number; max: number };
	type HistMetric = { histogram: { dataPoints: HistPoint[] } };
	type HistRecord = { resourceMetrics: { scopeMetrics: { metrics: HistMetric[] }[] }[] };
	const hist = JSON.parse(linesOf(join(dir2, "obs", "pi-obs.jsonl"))[0] ?? "{}") as HistRecord;
	const hp = hist.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
	assert.deepEqual([hp?.count, hp?.sum, hp?.min, hp?.max], ["1", 812.5, 812.5, 812.5]);

	// --- log record ---
	const dir3 = freshDir();
	const exp3 = exporterAt(dir3);
	await exp3.export([logItem()]);
	const logJson = JSON.parse(linesOf(join(dir3, "obs", "pi-obs.jsonl"))[0]) as { resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] };
	const rec = logJson.resourceLogs[0].scopeLogs[0].logRecords[0];
	assert.equal(rec.severityText, "WARN");
	assert.equal(rec.severityNumber, 13);
	assert.deepEqual(rec.body, { stringValue: "batch dropped" });
});

test("rotation with a tiny byte limit: exactly N files total, oldest dropped, newest retained", async () => {
	const dir = freshDir();
	const path = join(dir, "pi-obs.jsonl");
	const exp = new FileExporter({ path, maxBytes: 150, maxFiles: 3, resource: RESOURCE });
	// each line is far larger than 150 bytes → one record per file
	for (let i = 0; i < 10; i++) {
		await exp.export([{ kind: "log", log: logRecord("INFO", `record ${i}`, undefined, T0 + i) }]);
	}

	const files = readdirSync(dir).sort();
	assert.deepEqual(files, ["pi-obs.jsonl", "pi-obs.jsonl.1", "pi-obs.jsonl.2"], "exactly N=3 files total (active + rotated)");
	const newest = linesOf(path).map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue);
	const mid = linesOf(`${path}.1`).map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue);
	const oldestKept = linesOf(`${path}.2`).map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue);
	assert.deepEqual(newest, ["record 9"]);
	assert.deepEqual(mid, ["record 8"]);
	assert.deepEqual(oldestKept, ["record 7"], "records 0-6 dropped oldest-first");
	assert.equal(exp.counters.written, 10);
	assert.equal(exp.counters.dropped, 0);
	assert.ok(exp.counters.lastExportAt !== null);

	// maxFiles=1: the active file alone — rotation drops it and starts fresh
	const dir1 = freshDir();
	const exp1 = new FileExporter({ path: join(dir1, "pi-obs.jsonl"), maxBytes: 150, maxFiles: 1, resource: RESOURCE });
	for (let i = 0; i < 4; i++) {
		await exp1.export([{ kind: "log", log: logRecord("INFO", `solo ${i}`, undefined, T0 + i) }]);
	}
	assert.deepEqual(readdirSync(dir1), ["pi-obs.jsonl"]);
	const last = linesOf(join(dir1, "pi-obs.jsonl"));
	assert.equal(last.length, 1);
	assert.match(last[0] ?? "", /solo 3/);
});

test("unreadable/read-only target → error report + drop counter, never a throw (R1)", async () => {
	const dir = freshDir();
	const ro = join(dir, "readonly");
	// a read-only DIRECTORY blocks both mkdir of children and file creation
	mkdirSync(ro, { recursive: true });
	chmodSync(ro, 0o555);
	const errors: unknown[] = [];
	const drops: number[] = [];
	try {
		const exp = new FileExporter({
			path: join(ro, "obs", "pi-obs.jsonl"),
			maxBytes: 1024,
			maxFiles: 2,
			resource: RESOURCE,
			onError: (error, dropped) => {
				errors.push(error);
				drops.push(dropped);
			},
		});
		await assert.doesNotThrow(() => exp.export([spanItem(), logItem()]));
		assert.equal(exp.counters.written, 0);
		assert.equal(exp.counters.dropped, 2);
		assert.equal(exp.counters.lastExportAt, null, "health: no successful write yet");
		assert.match(exp.counters.lastError ?? "", /EACCES|EPERM|denied/i, "health: the failure is recorded");
		assert.equal(errors.length, 2, "one report per failed record");
		assert.deepEqual(drops, [1, 2], "the running drop total is reported");
	} finally {
		chmodSync(ro, 0o755); // restore so afterEach cleanup can remove it
	}

	// a path THROUGH a regular file fails with ENOTDIR — same R1 posture
	const dir2 = freshDir();
	const blocker = join(dir2, "blocker");
	writeFileSync(blocker, "not a directory");
	const exp2 = new FileExporter({ path: join(blocker, "obs", "pi-obs.jsonl"), maxBytes: 1024, maxFiles: 2, resource: RESOURCE });
	await assert.doesNotThrow(() => exp2.export([logItem()]));
	assert.equal(exp2.counters.written, 0);
	assert.equal(exp2.counters.dropped, 1);
	assert.equal(exp2.counters.lastExportAt, null);
	assert.match(exp2.counters.lastError ?? "", /ENOTDIR/);
});

test("session-dir targets are rejected at construction with the R2 message", () => {
	for (const bad of [
		"/home/u/.pi/agent/sessions/my-workspace/0193.jsonl",
		"/home/u/.pi/agent/sessions/my-workspace/obs/pi-obs.jsonl",
		"/data/sessions/archived-project/report.jsonl",
	]) {
		assert.throws(() => assertNotSessionDir(bad), (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match((err as Error).message, /is inside a session directory/);
			assert.match((err as Error).message, /\(R2\)/);
			return true;
		}, `expected rejection for ${bad}`);
		assert.throws(() => new FileExporter({ path: bad, maxBytes: 10, maxFiles: 2, resource: RESOURCE }), /inside a session directory/);
	}
	// legitimate targets pass
	for (const ok of ["/home/u/.pi/obs/pi-obs.jsonl", "/srv/otel/pi-obs.jsonl", "/home/u/.pi/agent/settings.json"]) {
		assert.doesNotThrow(() => assertNotSessionDir(ok));
	}
	// construction validates the numeric bounds too
	assert.throws(() => new FileExporter({ path: "/tmp/x.jsonl", maxBytes: 0, maxFiles: 2, resource: RESOURCE }), /maxBytes/);
	assert.throws(() => new FileExporter({ path: "/tmp/x.jsonl", maxBytes: 10, maxFiles: 0, resource: RESOURCE }), /maxFiles/);
});

test("R2 redaction before write: canary value never reaches the file (nor any ≥ 8-char substring)", async () => {
	const dir = freshDir();
	const path = join(dir, "pi-obs.jsonl");
	const canary = "zlX9.trap-Canary_q7r8s9t0u1"; // ≥ 8 chars, never to appear (disjoint from the hash below)
	const exp = new FileExporter({ path, maxBytes: 1 << 20, maxFiles: 2, resource: RESOURCE });

	const session = startSessionSpan({}, { nowMs: T0 });
	const turn = startTurnSpan(session, 0, undefined, { nowMs: T0 });
	const tool = startToolSpan(turn, "bash", undefined, { nowMs: T0 });
	addEvent(tool, "pi.user.input", { "pi.source": "interactive", "pi.content.hash": "f1e2d3c4b5a6", "pi.content.text": `please help with SECRET_CANARY=${canary} and key sk-AbCdEf1234567890 now` }, T0);
	await exp.export([{ kind: "span", span: tool }, { kind: "log", log: logRecord("ERROR", `fault report token=${canary} bearer AbCdEfGhIjKlMnOp`, { "pi.hook": "input" }, T0) }]);

	const file = readFileSync(path, "utf8");
	assert.ok(file.includes("[REDACTED]"), "redaction marker present");
	assert.ok(!file.includes(canary), "the canary value must not appear");
	for (let i = 0; i + 8 <= canary.length; i++) {
		assert.ok(!file.includes(canary.slice(i, i + 8)), `canary substring ≥ 8 chars leaked: ${canary.slice(i, i + 8)}`);
	}
	assert.ok(!file.includes("sk-AbCdEf1234567890"), "sk- style keys redacted");
	assert.ok(!file.includes("AbCdEfGhIjKlMnOp"), "bearer tokens redacted");
	assert.ok(file.includes("f1e2d3c4b5a6"), "content hashes are NOT mangled by redaction");
	assert.ok(file.includes("SECRET_CANARY=[REDACTED]"), "the key= part is kept, the value redacted");

	// the redact() primitive directly: patterns keep capture groups, others full-replace
	assert.equal(redact("x sk-AbCdEf1234567890 y"), "x [REDACTED] y");
	assert.equal(redact("Authorization: Bearer Zm9vYmFyMTIzNDU2"), "Authorization: Bearer [REDACTED]");
	assert.equal(redact("password=hunter2secret"), "password=[REDACTED]");
	assert.equal(redact("plain text stays"), "plain text stays");

	// JSON-shaped assignments (compact JSON.stringify output — the tool-input
	// capture shape): quoted keys/values and JSON-in-JSON escaped quotes
	// redact, not just shell/YAML key=value shapes
	assert.equal(redact('{"api_key":"sk-AbCdEf123456"}'), '{"api_key":"[REDACTED]"}');
	assert.equal(redact('{"api_key": "sk-AbCdEf123456"}'), '{"api_key": "[REDACTED]"}');
	assert.equal(redact('{"Authorization":"Bearer Zm9vYmFyMTIzNDU2"}'), '{"Authorization":"Bearer [REDACTED]"}');
	// escaped-quote nesting: the value class swallows the trailing backslash,
	// the outer closing quote survives — the secret itself never does
	assert.equal(redact('\\"api_key\\": \\"sk-AbCdEf123456\\"'), '\\"api_key\\": \\"[REDACTED]"');
	assert.ok(!redact(String.raw`{"password": "hunter2secret"}`).includes("hunter2secret"));
});

test("concurrent appends from the queue drain stay line-atomic", async () => {
	const dir = freshDir();
	const path = join(dir, "pi-obs.jsonl");
	const exp = new FileExporter({ path, maxBytes: 1 << 20, maxFiles: 3, resource: RESOURCE });
	const batch = (prefix: string): TelemetryItem[] =>
		Array.from({ length: 25 }, (_, i) => ({ kind: "log", log: logRecord("INFO", `${prefix}-${i}`, undefined, T0 + i) }));
	await Promise.all([exp.export(batch("a")), exp.export(batch("b")), exp.export(batch("c"))]);
	const lines = linesOf(path);
	assert.equal(lines.length, 75, "every record landed");
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), "no interleaved/partial lines");
	// each batch's records keep their internal order
	for (const prefix of ["a", "b", "c"]) {
		const idx = lines
			.map((l) => (JSON.parse(l) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue)
			.filter((body) => body.startsWith(`${prefix}-`))
			.map((body) => Number(body.slice(2)));
		assert.deepEqual(idx, idx.slice().sort((x, y) => x - y), `${prefix} batch order preserved`);
	}
});

test("unserializable items are dropped and reported, never thrown (R1)", async () => {
	const dir = freshDir();
	const errors: string[] = [];
	const exp = new FileExporter({
		path: join(dir, "pi-obs.jsonl"),
		maxBytes: 1024,
		maxFiles: 2,
		resource: RESOURCE,
		onError: (error) => errors.push(String(error)),
	});
	const forged = { kind: "mystery" } as unknown as TelemetryItem;
	await assert.doesNotThrow(() => exp.export([forged, logItem()]));
	assert.equal(exp.counters.written, 1);
	assert.equal(exp.counters.dropped, 1);
	assert.match(exp.counters.lastError ?? "", /unserializable/);
	assert.ok(exp.counters.lastExportAt !== null, "the later success still records its timestamp (error stays sticky)");
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /unserializable telemetry item/);
});

test("exportRequestLine: shared serializer dispatch (also exercised directly for Step 5)", () => {
	const line = exportRequestLine(spanItem(), RESOURCE);
	assert.ok(line !== null && line.startsWith('{"resourceSpans":'));
	assert.ok(exportRequestLine(metricItems()[0], RESOURCE)?.startsWith('{"resourceMetrics":'));
	assert.ok(exportRequestLine(logItem(), RESOURCE)?.startsWith('{"resourceLogs":'));
	assert.equal(exportRequestLine({ kind: "mystery" } as unknown as TelemetryItem, RESOURCE), null);
});
