/**
 * pi-obs — OTel entity builders (SPECS R4, DEV_PLAN Step 2).
 *
 * The single formatting path everything else uses — live capture (Step 6)
 * and offline replay (Step 7) share these builders, never parallel code:
 *
 *   - spans: W3C trace/span IDs minted from the crypto RNG; hierarchy
 *     helpers `pi.session` → `pi.run` → `pi.turn` → { `pi.model`,
 *     `pi.tool <name>` }; attributes, events, status, timing;
 *   - metrics: counters/histograms per the R4 table, breakdown
 *     attributes enforced against the semconv registry;
 *   - log records: severities for exporter-health and fault reports;
 *   - GenAI application from pi payload shapes (`message_end` usage),
 *     defensively — malformed payloads never throw (R1 starts here);
 *   - deterministic ID derivation for R3b: session id + entry ids →
 *     stable trace/span ids (hash-based), so replays are byte-stable.
 *
 * Contract split (deliberate):
 *   - EXTERNAL data (pi payload shapes) is never trusted — malformed
 *     input yields partial output, never a throw (R1 fault isolation);
 *   - INTERNAL contract violations (unregistered or mistyped names and
 *     attributes — programming bugs) throw SemconvError: fail closed in
 *     tests; in production the capture wrapper's fault isolation (R1,
 *     Step 6) catches, reports once, and disables that emission.
 *
 * Pure module: no pi imports. Time is injectable (`nowMs`) so tests are
 * deterministic; the default is Date.now().
 */

import { createHash, randomBytes } from "node:crypto";
import { SemconvError, mustLookupAttribute, mustLookupMetric, lookupEntity } from "./semconv.ts";

/** Attribute value on the wire. */
export type AttrValue = string | number | boolean;

/** OTel span event. */
export interface SpanEventData {
	name: string;
	timeUnixNano: string;
	attributes: Record<string, AttrValue>;
}

/** OTel span status (R4: `error` on failed tool results, aborted runs, provider errors). */
export interface SpanStatus {
	code: "unset" | "ok" | "error";
	message?: string;
}

/** A built span — the internal shape exporters serialize to OTLP/JSON. */
export interface SpanData {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	startTimeUnixNano: string;
	endTimeUnixNano: string | null;
	attributes: Record<string, AttrValue>;
	events: SpanEventData[];
	status: SpanStatus;
}

/** A built metric point. */
export interface MetricData {
	name: string;
	type: "counter" | "histogram";
	/** OTel unit (from the semconv metric table). */
	unit: string;
	/** Counter increment, or the observed value for histograms. */
	value: number;
	attributes: Record<string, AttrValue>;
	timeUnixNano: string;
}

/** A built log record (exporter health, drops, handler faults). */
export interface LogRecordData {
	timeUnixNano: string;
	severityText: "DEBUG" | "INFO" | "WARN" | "ERROR";
	/** OTel severity number (DEBUG 5, INFO 9, WARN 13, ERROR 17). */
	severityNumber: number;
	body: string;
	attributes: Record<string, AttrValue>;
}

/** OTel severity numbers for the four levels pi-obs uses. */
export const SEVERITY = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;
export type Severity = keyof typeof SEVERITY;

/** Milliseconds since epoch → nanoseconds since epoch (OTLP string form). */
export function toUnixNano(ms: number): string {
	return String(Math.round(ms * 1e6));
}

// ---------------------------------------------------------------------------
// IDs — W3C: 16-byte trace ids, 8-byte span ids, never all-zero.
// ---------------------------------------------------------------------------

const ALL_ZERO_32 = "0".repeat(32);
const ALL_ZERO_16 = "0".repeat(16);

/** Injectable RNG so tests can drive the (otherwise p ≈ 2^-128) all-zero retry. */
export type Rng = (bytes: number) => Buffer;

/** Mint a fresh W3C trace id (32 lowercase hex) from the crypto RNG. */
export function newTraceId(rng: Rng = randomBytes): string {
	const id = rng(16).toString("hex");
	if (id === ALL_ZERO_32) return rng(16).toString("hex"); // all-zero is W3C-illegal — redraw
	return id;
}

/** Mint a fresh W3C span id (16 lowercase hex) from the crypto RNG. */
export function newSpanId(rng: Rng = randomBytes): string {
	const id = rng(8).toString("hex");
	if (id === ALL_ZERO_16) return rng(8).toString("hex");
	return id;
}

/** Deterministic trace id for R3b replay: stable for the same session id. */
export function deriveTraceId(sessionId: string): string {
	return createHash("sha256").update(`pi-obs:trace:${sessionId}`).digest("hex").slice(0, 32);
}

/** Deterministic span id for R3b replay: stable for session id + entry id. */
export function deriveSpanId(sessionId: string, entryId: string): string {
	return createHash("sha256").update(`pi-obs:span:${sessionId}:${entryId}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Validation — the semconv registry is load-bearing for builders.
// ---------------------------------------------------------------------------

/** Set one attribute, validated against the registry (name AND type). */
function setAttr(target: Record<string, AttrValue>, name: string, value: AttrValue): void {
	const spec = mustLookupAttribute(name);
	if (typeof value !== spec.type) {
		throw new SemconvError(`attribute "${name}" expects ${spec.type}, got ${typeof value}`);
	}
	target[name] = value;
}

/** Validate a whole attribute record (used for span events and metrics). */
function setAttrs(target: Record<string, AttrValue>, attributes: Record<string, AttrValue>): void {
	for (const [name, value] of Object.entries(attributes)) setAttr(target, name, value);
}

/** Span names: registered, span-kind; only `pi.tool` carries a ` <name>` suffix. */
function checkSpanName(name: string): void {
	const space = name.indexOf(" ");
	const base = space === -1 ? name : name.slice(0, space);
	const spec = lookupEntity(base);
	if (spec === undefined || spec.kind !== "span") {
		throw new SemconvError(`unknown span name "${name}" — extend the semconv table (R4: add-only)`);
	}
	if (space !== -1 && base !== "pi.tool") {
		throw new SemconvError(`span name "${name}": only pi.tool takes a name suffix`);
	}
}

/** Event names: registered, event-kind. */
function checkEventName(name: string): void {
	const spec = lookupEntity(name);
	if (spec === undefined || spec.kind !== "event") {
		throw new SemconvError(`unknown span-event name "${name}" — extend the semconv table (R4: add-only)`);
	}
}

// ---------------------------------------------------------------------------
// Span builders.
// ---------------------------------------------------------------------------

/** Options shared by span starts. */
export interface SpanStart {
	traceId: string;
	parentSpanId?: string | null;
	/** Pre-minted span id (R3b derives its own); random when omitted. */
	spanId?: string;
	attributes?: Record<string, AttrValue>;
	/** Injectable clock (ms since epoch); Date.now() when omitted. */
	nowMs?: number;
}

/** Start a span by (registered) name — the generic core. */
export function startSpan(name: string, opts: SpanStart): SpanData {
	checkSpanName(name);
	const attributes: Record<string, AttrValue> = {};
	if (opts.attributes !== undefined) setAttrs(attributes, opts.attributes);
	return {
		name,
		traceId: opts.traceId,
		spanId: opts.spanId ?? newSpanId(),
		parentSpanId: opts.parentSpanId ?? null,
		startTimeUnixNano: toUnixNano(opts.nowMs ?? Date.now()),
		endTimeUnixNano: null,
		attributes,
		events: [],
		status: { code: "unset" },
	};
}

/** End a span: end timestamp, optional status code and message. */
export function endSpan(span: SpanData, opts?: { code?: SpanStatus["code"]; message?: string; nowMs?: number }): SpanData {
	span.endTimeUnixNano = toUnixNano(opts?.nowMs ?? Date.now());
	if (opts?.code !== undefined) {
		span.status = opts.message !== undefined ? { code: opts.code, message: opts.message } : { code: opts.code };
	}
	return span;
}

/** Add a span event (registered name, validated attributes). */
export function addEvent(span: SpanData, name: string, attributes?: Record<string, AttrValue>, nowMs?: number): SpanData {
	checkEventName(name);
	const attrs: Record<string, AttrValue> = {};
	if (attributes !== undefined) setAttrs(attrs, attributes);
	span.events.push({ name, timeUnixNano: toUnixNano(nowMs ?? Date.now()), attributes: attrs });
	return span;
}

// --- the R3 hierarchy ------------------------------------------------------

/** Options for the hierarchy helpers: a pre-derived span id (R3b) and an injectable clock. */
export interface SpanOpts {
	spanId?: string;
	nowMs?: number;
}

/** Root span `pi.session` — mints the trace (or takes a derived id for replay). */
export function startSessionSpan(attributes: Record<string, AttrValue>, opts?: SpanOpts & { traceId?: string }): SpanData {
	return startSpan("pi.session", {
		traceId: opts?.traceId ?? newTraceId(),
		spanId: opts?.spanId,
		attributes,
		nowMs: opts?.nowMs,
	});
}

/** `pi.run` — child of the session span. */
export function startRunSpan(session: SpanData, attributes?: Record<string, AttrValue>, opts?: SpanOpts): SpanData {
	return startSpan("pi.run", { traceId: session.traceId, parentSpanId: session.spanId, attributes, spanId: opts?.spanId, nowMs: opts?.nowMs });
}

/** `pi.turn` — child of the run span; carries `pi.turn.index`. */
export function startTurnSpan(run: SpanData, index: number, attributes?: Record<string, AttrValue>, opts?: SpanOpts): SpanData {
	return startSpan("pi.turn", {
		traceId: run.traceId,
		parentSpanId: run.spanId,
		attributes: { "pi.turn.index": index, ...attributes },
		spanId: opts?.spanId,
		nowMs: opts?.nowMs,
	});
}

/** `pi.model` — child of the turn span. */
export function startModelSpan(turn: SpanData, attributes?: Record<string, AttrValue>, opts?: SpanOpts): SpanData {
	return startSpan("pi.model", { traceId: turn.traceId, parentSpanId: turn.spanId, attributes, spanId: opts?.spanId, nowMs: opts?.nowMs });
}

/** `pi.tool <name>` — child of the turn span; carries `pi.tool.name`. */
export function startToolSpan(turn: SpanData, toolName: string, attributes?: Record<string, AttrValue>, opts?: SpanOpts): SpanData {
	return startSpan(`pi.tool ${toolName}`, {
		traceId: turn.traceId,
		parentSpanId: turn.spanId,
		attributes: { "pi.tool.name": toolName, ...attributes },
		spanId: opts?.spanId,
		nowMs: opts?.nowMs,
	});
}

// ---------------------------------------------------------------------------
// Metric builders.
// ---------------------------------------------------------------------------

/** Build a counter point (non-negative, breakdown attributes enforced). */
export function counter(name: string, value: number, attributes?: Record<string, AttrValue>, nowMs?: number): MetricData {
	const spec = mustLookupMetric(name);
	if (spec.type !== "counter") throw new SemconvError(`metric "${name}" is a ${spec.type}, not a counter`);
	if (!Number.isFinite(value) || value < 0) throw new SemconvError(`counter "${name}": value must be a finite number ≥ 0, got ${value}`);
	const attrs: Record<string, AttrValue> = {};
	if (attributes !== undefined) setAttrs(attrs, attributes);
	for (const required of spec.attributes) {
		if (!(required in attrs)) throw new SemconvError(`counter "${name}": missing breakdown attribute "${required}"`);
	}
	return { name, type: "counter", unit: spec.unit, value, attributes: attrs, timeUnixNano: toUnixNano(nowMs ?? Date.now()) };
}

/** Build a histogram observation (finite value ≥ 0, breakdown attributes enforced). */
export function histogram(name: string, value: number, attributes?: Record<string, AttrValue>, nowMs?: number): MetricData {
	const spec = mustLookupMetric(name);
	if (spec.type !== "histogram") throw new SemconvError(`metric "${name}" is a ${spec.type}, not a histogram`);
	if (!Number.isFinite(value) || value < 0) throw new SemconvError(`histogram "${name}": value must be a finite number ≥ 0, got ${value}`);
	const attrs: Record<string, AttrValue> = {};
	if (attributes !== undefined) setAttrs(attrs, attributes);
	for (const required of spec.attributes) {
		if (!(required in attrs)) throw new SemconvError(`histogram "${name}": missing breakdown attribute "${required}"`);
	}
	return { name, type: "histogram", unit: spec.unit, value, attributes: attrs, timeUnixNano: toUnixNano(nowMs ?? Date.now()) };
}

// ---------------------------------------------------------------------------
// Log-record builder.
// ---------------------------------------------------------------------------

/** Build a log record for exporter health, drops, and handler faults. */
export function logRecord(severity: Severity, body: string, attributes?: Record<string, AttrValue>, nowMs?: number): LogRecordData {
	const attrs: Record<string, AttrValue> = {};
	if (attributes !== undefined) setAttrs(attrs, attributes);
	return {
		timeUnixNano: toUnixNano(nowMs ?? Date.now()),
		severityText: severity,
		severityNumber: SEVERITY[severity],
		body,
		attributes: attrs,
	};
}

// ---------------------------------------------------------------------------
// GenAI application from pi payload shapes — defensive, never throws (R1).
// ---------------------------------------------------------------------------

/** A pi `message_end`-shaped payload — every field untrusted. */
export interface MessageEndPayload {
	provider?: unknown;
	model?: unknown;
	/** The model that served the response, when pi reports it. */
	responseModel?: unknown;
	/** Provider response id, when pi provides one. */
	responseId?: unknown;
	usage?: unknown;
	stopReason?: unknown;
}

/** The `usage` object as pi reports it — untrusted. */
interface UsageShape {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	reasoning?: unknown;
	totalTokens?: unknown;
	cost?: unknown;
}

/** A usable number, or undefined (never NaN/Infinity/negative-nonNumbers). */
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A usable string, or undefined. */
function usableString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GenAI + custom attributes for a `pi.model` span from a pi
 * `message_end`-shaped payload (R4). Malformed fields are skipped —
 * this function NEVER throws (R1: external data is not trusted).
 */
export function genaiAttributes(payload: MessageEndPayload): Record<string, AttrValue> {
	const attrs: Record<string, AttrValue> = { "gen_ai.operation.name": "generate_content" };
	if (typeof payload !== "object" || payload === null) return attrs; // garbage in → constant only, never a throw
	const system = usableString(payload.provider);
	if (system !== undefined) attrs["gen_ai.system"] = system;
	const requestModel = usableString(payload.model);
	if (requestModel !== undefined) attrs["gen_ai.request.model"] = requestModel;
	const responseModel = usableString(payload.responseModel);
	if (responseModel !== undefined) attrs["gen_ai.response.model"] = responseModel;
	const responseId = usableString(payload.responseId);
	if (responseId !== undefined) attrs["gen_ai.response.id"] = responseId;
	const stopReason = usableString(payload.stopReason);
	if (stopReason !== undefined) attrs["pi.stop_reason"] = stopReason;

	const usage = payload.usage as UsageShape | null | undefined;
	if (typeof usage === "object" && usage !== null) {
		const input = finiteNumber(usage.input);
		if (input !== undefined) attrs["gen_ai.usage.input_tokens"] = input;
		const output = finiteNumber(usage.output);
		if (output !== undefined) attrs["gen_ai.usage.output_tokens"] = output;
		const cost =
			typeof usage.cost === "object" && usage.cost !== null ? finiteNumber((usage.cost as { total?: unknown }).total) : undefined;
		if (cost !== undefined) attrs["pi.cost.total"] = cost;
	}
	return attrs;
}

/**
 * Token counters (`pi.tokens`, by token type) from a pi usage payload —
 * the type-distinguished counters of R4 (input/output/cacheRead/
 * cacheWrite/reasoning). Malformed usage yields no counters, never a
 * throw (R1).
 */
export function tokenCounters(usage: unknown, nowMs?: number): MetricData[] {
	if (typeof usage !== "object" || usage === null) return [];
	const u = usage as UsageShape;
	const types: [string, unknown][] = [
		["input", u.input],
		["output", u.output],
		["cacheRead", u.cacheRead],
		["cacheWrite", u.cacheWrite],
		["reasoning", u.reasoning],
	];
	const counters: MetricData[] = [];
	for (const [type, raw] of types) {
		const value = finiteNumber(raw);
		if (value === undefined || value === 0) continue; // absent or zero: nothing to count
		counters.push(counter("pi.tokens", value, { "pi.token.type": type }, nowMs));
	}
	return counters;
}
