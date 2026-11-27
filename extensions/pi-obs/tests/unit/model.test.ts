/**
 * pi-obs — OTel entity-builder tests (SPECS R4 + R3b ACs, DEV_PLAN Step 2).
 *
 *   - ID format/length/uniqueness (W3C, crypto RNG);
 *   - hierarchy parent/child invariants for the R3 span tree;
 *   - the EXACT GenAI attribute set for a fixture `message_end` payload
 *     (SPECS R4 AC), plus minimal and malformed payloads;
 *   - metric builder conformance: registry-enforced names, kinds,
 *     breakdown attributes, value sanity;
 *   - log-record severities;
 *   - deterministic ID derivation (R3b): same inputs → byte-identical
 *     ids across calls — the unit-level determinism AC;
 *   - malformed payload → never throws (R1 fault isolation starts here);
 *   - internal contract violations DO throw (fail closed): unregistered
 *     or mistyped names/attributes are programming bugs.
 *
 * Fixtures are checked in under tests/fixtures/ (realistic, minimal,
 * malformed `message_end` payload shapes).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	SEVERITY,
	addEvent,
	startSpan,
	contentText,
	counter,
	deriveSpanId,
	deriveTraceId,
	endSpan,
	genaiAttributes,
	histogram,
	logRecord,
	newSpanId,
	newTraceId,
	startModelSpan,
	startRunSpan,
	startSessionSpan,
	startToolSpan,
	startTurnSpan,
	toUnixNano,
	tokenCounters,
	type MessageEndPayload,
	type SpanData,
} from "../../src/model.ts";
import { lookupAttribute, lookupEntity, SemconvError } from "../../src/semconv.ts";

const T0 = 1_700_000_000_000; // fixed clock for deterministic assertions

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", `${name}.json`), "utf8"));

test("ID format, length, uniqueness (W3C, crypto RNG)", () => {
	assert.match(newTraceId(), /^[0-9a-f]{32}$/);
	assert.match(newSpanId(), /^[0-9a-f]{16}$/);
	assert.notEqual(newTraceId(), "0".repeat(32));
	assert.notEqual(newSpanId(), "0".repeat(16));
	const traces = new Set(Array.from({ length: 1000 }, () => newTraceId()));
	const spans = new Set(Array.from({ length: 1000 }, () => newSpanId()));
	assert.equal(traces.size, 1000, "trace ids must be unique");
	assert.equal(spans.size, 1000, "span ids must be unique");

	// the W3C all-zero guard: a rigged RNG proves the redraw (p ≈ 2^-128 live)
	const hex = (n: number, fill: string) => Buffer.from(fill.repeat(n), "hex");
	const zeroThen = (fill: string) => {
		let calls = 0;
		return (n: number) => (calls++ === 0 ? hex(n, "00") : hex(n, fill));
	};
	assert.equal(newTraceId(zeroThen("ab")), "ab".repeat(16));
	assert.equal(newSpanId(zeroThen("cd")), "cd".repeat(8));
	assert.notEqual(newTraceId(zeroThen("ab")), "0".repeat(32));
});

test("hierarchy: pi.session → pi.run → pi.turn → { pi.model, pi.tool <name> }", () => {
	const session = startSessionSpan({ "pi.session.id": "sess-1" }, { nowMs: T0 });
	const run = startRunSpan(session, undefined, { nowMs: T0 + 1 });
	const turn = startTurnSpan(run, 0, undefined, { nowMs: T0 + 2 });
	const model = startModelSpan(turn, undefined, { nowMs: T0 + 3 });
	const tool = startToolSpan(turn, "bash", undefined, { nowMs: T0 + 4 });

	assert.equal(session.name, "pi.session");
	assert.equal(session.parentSpanId, null);
	assert.equal(run.name, "pi.run");
	assert.equal(run.parentSpanId, session.spanId);
	assert.equal(turn.name, "pi.turn");
	assert.equal(turn.parentSpanId, run.spanId);
	assert.equal(turn.attributes["pi.turn.index"], 0);
	assert.equal(model.name, "pi.model");
	assert.equal(model.parentSpanId, turn.spanId);
	assert.equal(tool.name, "pi.tool bash");
	assert.equal(tool.parentSpanId, turn.spanId);
	assert.equal(tool.attributes["pi.tool.name"], "bash");

	const all: SpanData[] = [session, run, turn, model, tool];
	for (const span of all) {
		assert.equal(span.traceId, session.traceId, "one trace per session lifetime");
		assert.equal(span.status.code, "unset");
		assert.equal(span.endTimeUnixNano, null);
	}
});

test("every name and attribute the builders emit is registered (the table is the contract)", () => {
	const session = startSessionSpan({ "pi.session.id": "s" }, { nowMs: T0 });
	const run = startRunSpan(session, undefined, { nowMs: T0 });
	const turn = startTurnSpan(run, 3, undefined, { nowMs: T0 });
	const model = startModelSpan(turn, genaiAttributes(fixture("message_end") as MessageEndPayload), { nowMs: T0 });
	const tool = startToolSpan(turn, "edit", undefined, { nowMs: T0 });
	addEvent(session, "pi.user.input", { "pi.source": "interactive", "pi.content.length": 12, "pi.content.hash": "abc123def456", "pi.streaming": false }, T0);
	addEvent(tool, "pi.tool.outcome", { "pi.outcome": "ok" }, T0);

	for (const span of [session, run, turn, model, tool]) {
		const base = span.name.split(" ")[0] ?? span.name;
		assert.equal(lookupEntity(base)?.kind, "span", `${span.name} must be a registered span`);
		for (const name of Object.keys(span.attributes)) {
			assert.ok(lookupAttribute(name) !== undefined, `${span.name}: attribute "${name}" must be registered`);
		}
		for (const event of span.events) {
			assert.equal(lookupEntity(event.name)?.kind, "event");
			for (const name of Object.keys(event.attributes)) {
				assert.ok(lookupAttribute(name) !== undefined, `${event.name}: attribute "${name}" must be registered`);
			}
		}
	}
});

test("span mechanics: end timestamps, status, events, injectable clock", () => {
	const span = startToolSpan(
		startTurnSpan(startRunSpan(startSessionSpan({}, { nowMs: T0 }), undefined, { nowMs: T0 }), 0, undefined, { nowMs: T0 }),
		"bash",
		undefined,
		{ nowMs: T0 },
	);
	addEvent(span, "pi.tool.outcome", { "pi.outcome": "failed" }, T0 + 5);
	endSpan(span, { code: "error", message: "tool exited 1", nowMs: T0 + 10 });
	assert.equal(span.endTimeUnixNano, toUnixNano(T0 + 10));
	assert.deepEqual(span.status, { code: "error", message: "tool exited 1" });
	assert.equal(span.events[0]?.name, "pi.tool.outcome");
	assert.equal(span.events[0]?.timeUnixNano, toUnixNano(T0 + 5));
	assert.deepEqual(span.events[0]?.attributes, { "pi.outcome": "failed" });

	// defaults: status stays unset without opts; Date.now() when no clock
	const plain = endSpan(startSessionSpan({}, { nowMs: T0 }));
	assert.deepEqual(plain.status, { code: "unset" });
	assert.ok(plain.endTimeUnixNano !== null && Number(plain.endTimeUnixNano) > Number(toUnixNano(T0)));
});

test("GenAI attribute set for a fixture message_end payload (SPECS R4 AC — exact)", () => {
	const attrs = genaiAttributes(fixture("message_end") as MessageEndPayload);
	assert.deepEqual(attrs, {
		"gen_ai.operation.name": "generate_content",
		"gen_ai.system": "openrouter",
		"gen_ai.request.model": "nvidia/nemotron-3.5-lightning",
		"gen_ai.response.model": "nvidia/nemotron-3.5-lightning",
		"gen_ai.response.id": "gen-9f2c1a7e4d",
		"gen_ai.usage.input_tokens": 1523,
		"gen_ai.usage.output_tokens": 287,
		"pi.stop_reason": "end_turn",
		"pi.cost.total": 0.001234,
	});
});

test("minimal payload: only the constant + present fields", () => {
	const attrs = genaiAttributes(fixture("message_end_minimal") as MessageEndPayload);
	assert.deepEqual(attrs, {
		"gen_ai.operation.name": "generate_content",
		"gen_ai.system": "openrouter",
		"gen_ai.request.model": "nvidia/nemotron-3-ultra-550b-a55b",
		"pi.stop_reason": "end_turn",
	});
});

test("malformed payload → never throws, garbage skipped (R1)", () => {
	let attrs: Record<string, unknown> = {};
	assert.doesNotThrow(() => {
		attrs = genaiAttributes(fixture("message_end_malformed") as MessageEndPayload);
	});
	assert.deepEqual(attrs, { "gen_ai.operation.name": "generate_content" });
	assert.doesNotThrow(() => {
		attrs = genaiAttributes(null as unknown as MessageEndPayload);
	});
	assert.deepEqual(attrs, { "gen_ai.operation.name": "generate_content" });
	assert.doesNotThrow(() => {
		attrs = genaiAttributes({ usage: { input: "x", output: Infinity, cost: { total: "free" } } });
	});
	assert.deepEqual(attrs, { "gen_ai.operation.name": "generate_content" }, "non-finite/garbage usage fields skipped");
});

test("token counters: type-distinguished pi.tokens from fixture usage", () => {
	const countersFromFixture = tokenCounters((fixture("message_end") as { usage?: unknown }).usage, T0);
	assert.deepEqual(
		countersFromFixture.map((c) => [c.attributes["pi.token.type"], c.value, c.type, c.timeUnixNano]),
		[
			["input", 1523, "counter", toUnixNano(T0)],
			["output", 287, "counter", toUnixNano(T0)],
			["cacheRead", 40960, "counter", toUnixNano(T0)],
			["reasoning", 512, "counter", toUnixNano(T0)], // cacheWrite is 0 → nothing to count
		],
	);
	assert.deepEqual(tokenCounters("banana"), [], "malformed usage → no counters, no throw");
	assert.deepEqual(tokenCounters(null), []);
	assert.deepEqual(tokenCounters({ input: "x", output: {} }), []);
});

test("metric builders: registry-enforced names, kinds, breakdowns, value sanity", () => {
	assert.deepEqual(counter("pi.model.requests", 1, undefined, T0), {
		name: "pi.model.requests",
		type: "counter",
		unit: "{request}",
		value: 1,
		attributes: {},
		timeUnixNano: toUnixNano(T0),
	});
	assert.equal(histogram("pi.model.duration", 812.5, undefined, T0).value, 812.5);
	assert.deepEqual(counter("pi.tokens", 40960, { "pi.token.type": "cacheRead" }, T0).attributes, { "pi.token.type": "cacheRead" });
	assert.deepEqual(counter("pi.tool.calls", 2, { "pi.tool.name": "bash" }, T0).attributes, { "pi.tool.name": "bash" });
	assert.deepEqual(counter("pi.messages", 1, { "pi.role": "assistant" }, T0).attributes, { "pi.role": "assistant" });

	// kind mismatch
	assert.throws(() => counter("pi.model.duration", 1), SemconvError);
	assert.throws(() => histogram("pi.tokens", 1, { "pi.token.type": "input" }), SemconvError);
	// value sanity
	assert.throws(() => counter("pi.model.requests", -1), SemconvError);
	assert.throws(() => counter("pi.model.requests", Number.NaN), /finite/);
	assert.throws(() => histogram("pi.turn.duration", -3), SemconvError);
	assert.throws(() => histogram("pi.turn.duration", Number.POSITIVE_INFINITY), /finite/);
	// breakdown attributes are required, registered, and typed
	assert.throws(() => counter("pi.tokens", 5), /missing breakdown attribute "pi\.token\.type"/);
	assert.throws(() => histogram("pi.tool.duration", 5), /missing breakdown attribute "pi\.tool\.name"/);
	assert.deepEqual(histogram("pi.tool.duration", 41, { "pi.tool.name": "edit" }, T0).attributes, { "pi.tool.name": "edit" });
	assert.throws(() => counter("pi.tokens", 5, { "pi.token.type": 7 }), /expects string/);
	// extra attributes are allowed when registered (pi.hook is) — no error
	assert.doesNotThrow(() => counter("pi.messages", 1, { "pi.role": "assistant", "pi.hook": "input" }));
});

test("log records: severities map to OTel numbers, attrs validated", () => {
	const rec = logRecord("WARN", "batch dropped", { "pi.exporter.name": "otlp", "pi.dropped.count": 3 }, T0);
	assert.deepEqual(rec, {
		timeUnixNano: toUnixNano(T0),
		severityText: "WARN",
		severityNumber: 13,
		body: "batch dropped",
		attributes: { "pi.exporter.name": "otlp", "pi.dropped.count": 3 },
	});
	assert.deepEqual(SEVERITY, { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 });
	for (const severity of ["DEBUG", "INFO", "WARN", "ERROR"] as const) {
		assert.equal(logRecord(severity, "x", undefined, T0).severityNumber, SEVERITY[severity]);
	}
	assert.throws(() => logRecord("ERROR", "x", { "pi.dropped.count": "many" }), /expects number/);
});

test("deterministic derivation (R3b): same inputs → byte-identical ids across calls", () => {
	const t1 = deriveTraceId("0193a2f5-7c1b-7de2-9f0a-2b6c8d4e5f60");
	const t2 = deriveTraceId("0193a2f5-7c1b-7de2-9f0a-2b6c8d4e5f60");
	assert.equal(t1, t2, "same session id → identical trace id");
	assert.match(t1, /^[0-9a-f]{32}$/);
	assert.notEqual(t1, deriveTraceId("another-session"), "different session → different trace");

	const s1 = deriveSpanId("sess", "entry-42");
	const s2 = deriveSpanId("sess", "entry-42");
	assert.equal(s1, s2, "same session+entry → identical span id");
	assert.match(s1, /^[0-9a-f]{16}$/);
	assert.notEqual(s1, deriveSpanId("sess", "entry-43"));
	assert.notEqual(s1, deriveSpanId("other", "entry-42"));

	// byte-stable replay: a whole span tree re-derived from ids is JSON-identical
	const replayTree = () => {
		const traceId = deriveTraceId("sess");
		const session = startSessionSpan({ "pi.session.id": "sess" }, { traceId, spanId: deriveSpanId("sess", "root"), nowMs: T0 });
		const run = startRunSpan(session, undefined, { spanId: deriveSpanId("sess", "run-1"), nowMs: T0 + 1 });
		const turn = startTurnSpan(run, 0, undefined, { spanId: deriveSpanId("sess", "turn-1"), nowMs: T0 + 2 });
		const model = startModelSpan(turn, { "gen_ai.system": "openrouter" }, { spanId: deriveSpanId("sess", "model-1"), nowMs: T0 + 3 });
		endSpan(model, { nowMs: T0 + 9000 });
		return JSON.stringify([session, run, turn, model]);
	};
	assert.equal(replayTree(), replayTree(), "same derivation inputs → byte-identical serialized tree");
});

test("internal contract violations fail closed (SemconvError, never silent)", () => {
	assert.throws(() => startSpan("pi.nope", { traceId: "t" }), /unknown span name/);
	assert.throws(() => startSpan("pi.run bash", { traceId: "t" }), /only pi\.tool takes a name suffix/);
	assert.throws(() => addEvent(startSessionSpan({}, { nowMs: T0 }), "pi.session", {}), /unknown span-event name/);
	assert.throws(() => addEvent(startSessionSpan({}, { nowMs: T0 }), "pi.model", {}), /unknown span-event name/);
	assert.throws(() => startSessionSpan({ "pi.mystery": "x" }), /unknown attribute/);
	assert.throws(() => startSessionSpan({ "pi.session.id": 7 }), /expects string/);
	assert.throws(() => counter("pi.mystery", 1), SemconvError);
});

test("contentText: mixed arrays keep only text blocks (R1: external shapes are not trusted)", () => {
	// the filter's two rejection arms: non-object blocks and non-text blocks
	assert.equal(
		contentText([42, null, { type: "image", url: "x" }, { type: "text", text: "hello" }, { type: "text" }]),
		"hello",
	);
	// non-string text field on a text block is rejected too
	assert.equal(contentText([{ type: "text", text: 7 }]), undefined);
});

test("genaiAttributes: usage.cost that is not an object yields no pi.cost.total", () => {
	const base = { provider: "openrouter", model: "m/x", stopReason: "stop", usage: { input: 10, output: 5 } };
	assert.equal(genaiAttributes({ ...base, usage: { ...base.usage, cost: 5 } })["pi.cost.total"], undefined);
	assert.equal(genaiAttributes({ ...base, usage: { ...base.usage, cost: null } })["pi.cost.total"], undefined);
});

test("contentText: non-string non-array content and empty text arrays yield undefined", () => {
	assert.equal(contentText(42), undefined);
	assert.equal(contentText(null), undefined);
	assert.equal(contentText([]), undefined);
});
