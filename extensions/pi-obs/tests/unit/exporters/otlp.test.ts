/**
 * pi-obs — OTLP/HTTP exporter tests (SPECS R5 ACs, DEV_PLAN Step 5),
 * driven against the in-process test receiver (tests/otlp_receiver.ts).
 *
 *   - batches arrive as valid OTLP/JSON on the right per-signal paths,
 *     with the expected spans/attributes, content-type, extra headers;
 *   - batch boundaries: batch=N splits a larger export into ⌈k/N⌉
 *     requests with the remainder as the last one;
 *   - non-2xx → exponential-backoff retry → success on a later attempt
 *     (retries counted), and → drop-and-count when the endpoint keeps
 *     failing (never rejects to the caller — the queue's error path);
 *   - connection refused → bounded retries → drop, never a hang;
 *   - hanging endpoint → the per-request timeout bounds every attempt;
 *   - killing the receiver mid-run never rejects to the caller;
 *   - http:// endpoints warn ONCE per origin; https:// never warns;
 *   - R2 redaction applies on this leg too (canary never reaches the
 *     receiver payload);
 *   - endpoint URL derivation (bare base gains /v1/<signal>; an
 *     explicit /v1/traces is rewritten per signal).
 *
 * All timings are bounded and generous (≤ a few hundred ms per case).
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { OtlpExporter, signalUrl } from "../../../src/exporters/otlp.ts";
import { startReceiver, type OtlpReceiver } from "../../otlp_receiver.ts";
import {
	addEvent,
	counter,
	genaiAttributes,
	histogram,
	logRecord,
	startModelSpan,
	startSessionSpan,
	startToolSpan,
	startTurnSpan,
	type MessageEndPayload,
} from "../../../src/model.ts";

const RESOURCE = { "service.name": "pi-agent", "pi.cwd": "/work/demo" } as Record<string, string | number | boolean>;
const T0 = 1_700_000_000_000;

const receivers: OtlpReceiver[] = [];
afterEach(async () => {
	while (receivers.length > 0) await receivers.pop()?.close();
});

const receiver = async (): Promise<OtlpReceiver> => {
	const r = await startReceiver();
	receivers.push(r);
	return r;
};

const toolSpanItem = () => {
	const session = startSessionSpan({ "pi.session.id": "s" }, { nowMs: T0 });
	const turn = startTurnSpan(session, 0, undefined, { nowMs: T0 + 1 });
	const tool = startToolSpan(turn, "bash", undefined, { nowMs: T0 + 2 });
	addEvent(tool, "pi.tool.outcome", { "pi.outcome": "ok" }, T0 + 3);
	return { kind: "span" as const, span: tool };
};

const modelSpanItem = () => {
	const session = startSessionSpan({}, { nowMs: T0 });
	const turn = startTurnSpan(session, 0, undefined, { nowMs: T0 });
	const model = startModelSpan(
		turn,
		genaiAttributes({
			provider: "openrouter",
			model: "nvidia/nemotron-3.5-lightning",
			usage: { input: 1523, output: 287, cost: { total: 0.001234 } },
		} as MessageEndPayload),
		{ nowMs: T0 + 4 },
	);
	return { kind: "span" as const, span: model };
};

const logItem = (body: string) => ({ kind: "log" as const, log: logRecord("INFO", body, { "pi.hook": "input" }, T0) });

test("batches arrive at the receiver as valid OTLP/JSON on the right signal paths", async () => {
	const r = await receiver();
	const exp = new OtlpExporter({
		endpoint: r.url,
		resource: RESOURCE,
		headers: { "x-pi-obs": "test" },
		batch: 64,
		timeoutMs: 1000,
		attempts: 1,
	});
	await exp.export([toolSpanItem(), modelSpanItem(), { kind: "metric", metric: counter("pi.tokens", 40960, { "pi.token.type": "cacheRead" }, T0) }, logItem("hello")]);

	assert.deepEqual(r.requests.map((q) => q.path).sort(), ["/v1/logs", "/v1/metrics", "/v1/traces"]);
	for (const q of r.requests) {
		assert.equal(q.headers["content-type"], "application/json");
		assert.equal(q.headers["x-pi-obs"], "test", "extra headers are injected");
		assert.doesNotThrow(() => JSON.parse(q.body), `${q.path} body parses`);
	}

	const traces = r.requests.find((q) => q.path === "/v1/traces");
	assert.ok(traces !== undefined);
	const body = JSON.parse(traces.body) as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] };
	const spans = body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
	assert.equal(spans.length, 2, "one request merges both spans");
	assert.deepEqual(spans.map((s) => s.name).sort(), ["pi.model", "pi.tool bash"]);
	const modelAttrs = Object.fromEntries(spans.find((s) => s.name === "pi.model")?.attributes.map((a) => [a.key, a.value]) ?? []);
	assert.deepEqual(modelAttrs["gen_ai.system"], { stringValue: "openrouter" });
	assert.deepEqual(modelAttrs["gen_ai.usage.input_tokens"], { intValue: "1523" });
	assert.deepEqual(modelAttrs["pi.cost.total"], { doubleValue: 0.001234 });

	const metrics = r.requests.find((q) => q.path === "/v1/metrics");
	const mbody = JSON.parse(metrics?.body ?? "{}") as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum: { dataPoints: { asInt: string }[] } }[] }[] }[] };
	assert.equal(mbody.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.name, "pi.tokens");
	assert.equal(mbody.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum.dataPoints[0]?.asInt, "40960");

	assert.equal(exp.counters.exported, 4);
	assert.equal(exp.counters.requests, 3);
	assert.ok(exp.counters.lastExportAt !== null, "health: last export timestamp recorded");
	assert.equal(exp.counters.lastError, null, "health: no failure ever");
});

test("batch boundaries: batch=N splits the export; remainder rides last", async () => {
	const r = await receiver();
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, batch: 3, timeoutMs: 1000, attempts: 1 });
	await exp.export(Array.from({ length: 7 }, (_, i) => logItem(`n${i}`)));
	const logRequests = r.requests.filter((q) => q.path === "/v1/logs");
	assert.equal(logRequests.length, 3, "ceil(7/3) requests");
	const counts = logRequests.map((q) => (JSON.parse(q.body) as { resourceLogs: unknown[][] }).resourceLogs.length);
	assert.deepEqual(counts, [3, 3, 1]);
});

test("non-2xx: retry with backoff succeeds on a later attempt (retries counted)", async () => {
	const r = await receiver();
	r.fail(2, 500); // first two requests fail, the third succeeds
	const errors: unknown[] = [];
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, attempts: 3, backoffMs: 1, timeoutMs: 1000, onError: (e) => errors.push(e) });
	await exp.export([logItem("once more")]);
	assert.equal(exp.counters.exported, 1);
	assert.equal(exp.counters.retries, 2);
	assert.ok(exp.counters.lastExportAt !== null);
	assert.match(exp.counters.lastError ?? "", /answered 500/, "health: the sticky error survives the successful retry");
	assert.equal(errors.length, 0);
	assert.equal(r.requests.length, 3, "the receiver saw every attempt");
});

test("non-2xx forever: bounded attempts, then drop-and-count — never rejects to the caller", async () => {
	const r = await receiver();
	r.fail(99, 503);
	const errors: Array<[unknown, number]> = [];
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, attempts: 3, backoffMs: 1, timeoutMs: 1000, onError: (e, d) => errors.push([e, d]) });
	await assert.doesNotReject(exp.export([logItem("a"), logItem("b")]));
	assert.equal(exp.counters.dropped, 2);
	assert.ok(exp.counters.lastExportAt === null && exp.counters.lastError !== null, "health: the failure is recorded");
	assert.equal(errors.length, 1, "one report per dropped chunk");
	assert.match(String(errors[0]?.[0]), /answered 503/);
	assert.equal(errors[0]?.[1], 2, "the running drop total is reported");
});

test("connection refused: bounded retries, drop, never a hang", async () => {
	const dead = await receiver(); // grab a port, then close it — nothing listens there
	const port = dead.port;
	await dead.close();
	const errors: unknown[] = [];
	const exp = new OtlpExporter({ endpoint: `http://127.0.0.1:${port}`, resource: RESOURCE, attempts: 2, backoffMs: 1, timeoutMs: 500, onError: (e) => errors.push(e) });
	const t0 = performance.now();
	await assert.doesNotReject(exp.export([logItem("x")]));
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 2000, `refused connection took ${elapsed.toFixed(0)}ms — not bounded`);
	assert.equal(exp.counters.dropped, 1);
	assert.ok(exp.counters.lastExportAt === null && exp.counters.lastError !== null);
	assert.match(String(errors[0]), /fetch failed|ECONNREFUSED|Connection/i);
});

test("hanging endpoint: the per-request timeout bounds every attempt", async () => {
	const r = await receiver();
	r.hang(99); // never answers
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, attempts: 2, backoffMs: 1, timeoutMs: 50 });
	const t0 = performance.now();
	await assert.doesNotReject(exp.export([logItem("slow")]));
	const elapsed = performance.now() - t0;
	assert.ok(elapsed >= 100 && elapsed < 2000, `two timed-out attempts took ${elapsed.toFixed(0)}ms (expected ~2×50ms)`);
	assert.equal(exp.counters.dropped, 1);
	assert.ok(exp.counters.lastExportAt === null && exp.counters.lastError !== null, "health: timeout failures recorded");
});

test("killing the receiver mid-run never rejects to the caller (the queue's error path)", async () => {
	const r = await receiver();
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, attempts: 2, backoffMs: 1, timeoutMs: 300 });
	const first = exp.export([logItem("before")]);
	await first;
	await r.close(); // kill it
	const survivors = await Promise.all([exp.export([logItem("a")]), exp.export([logItem("b")])]);
	assert.equal(survivors.length, 2, "every export resolved");
	assert.ok(exp.counters.dropped >= 2, `drops counted (${JSON.stringify(exp.counters)})`);
});

test("http:// endpoints warn ONCE per origin; https:// never warns", async () => {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(m);
	new OtlpExporter({ endpoint: "http://collector.example:4318", resource: RESOURCE }, warn);
	assert.equal(warnings.length, 1, "first http construction warns");
	assert.match(warnings[0] ?? "", /plain http:\/\//);
	new OtlpExporter({ endpoint: "http://collector.example:4318/v1/traces", resource: RESOURCE }, warn);
	assert.equal(warnings.length, 1, "same origin never warns again");
	new OtlpExporter({ endpoint: "http://other.example:4318", resource: RESOURCE }, warn);
	assert.equal(warnings.length, 2, "a different origin warns once");
	new OtlpExporter({ endpoint: "https://collector.example:4318", resource: RESOURCE }, warn);
	assert.equal(warnings.length, 2, "https:// never warns");
	new OtlpExporter({ endpoint: "not a url", resource: RESOURCE }, warn);
	assert.equal(warnings.length, 2, "invalid endpoints are the wiring's validation problem — no warning");
});

test("endpoint URL derivation: bare base gains /v1/<signal>; /v1/traces is rewritten per signal", () => {
	assert.equal(signalUrl("http://h:4318", "traces"), "http://h:4318/v1/traces");
	assert.equal(signalUrl("http://h:4318", "metrics"), "http://h:4318/v1/metrics");
	assert.equal(signalUrl("http://h:4318", "logs"), "http://h:4318/v1/logs");
	assert.equal(signalUrl("http://h:4318/", "traces"), "http://h:4318/v1/traces", "trailing slash trimmed");
	assert.equal(signalUrl("http://h:4318/v1/traces", "metrics"), "http://h:4318/v1/metrics");
	assert.equal(signalUrl("http://h:4318/v1/traces", "logs"), "http://h:4318/v1/logs");
	assert.equal(signalUrl("http://h:4318/v1/metrics", "traces"), "http://h:4318/v1/traces");
});

test("R2 redaction on the OTLP leg: canary never reaches the receiver payload", async () => {
	const r = await receiver();
	const exp = new OtlpExporter({ endpoint: r.url, resource: RESOURCE, timeoutMs: 1000, attempts: 1 });
	const canary = "zlX9.trap-Canary_q7r8s9t0u1";
	const session = startSessionSpan({}, { nowMs: T0 });
	const turn = startTurnSpan(session, 0, undefined, { nowMs: T0 });
	const tool = startToolSpan(turn, "bash", undefined, { nowMs: T0 });
	addEvent(tool, "pi.user.input", { "pi.content.hash": "f1e2d3c4b5a6", "pi.content.text": `SECRET_CANARY=${canary}` }, T0);
	await exp.export([{ kind: "span", span: tool }, { kind: "metric", metric: histogram("pi.model.duration", 12.5, undefined, T0) }]);
	const wire = r.requests.map((q) => q.body).join("\n");
	assert.ok(wire.includes("[REDACTED]"));
	assert.ok(!wire.includes(canary));
	assert.ok(wire.includes("f1e2d3c4b5a6"), "hashes are not mangled");
});
