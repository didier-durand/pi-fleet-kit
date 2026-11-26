/**
 * pi-obs — shared OTLP/JSON record serialization (SPECS R4/R5, DEV_PLAN
 * Step 4). The single encoding path for BOTH exporters: the file exporter
 * (Step 4) writes these records one per line, and the OTLP/HTTP exporter
 * (Step 5) POSTs them as export-request bodies. No parallel formatting
 * code path exists (R4's single-path rule).
 *
 * Encoding follows OTLP/JSON v1 (protobuf-JSON):
 *   - trace/span ids → HEX strings (the OTLP/JSON spec overrides
 *     protobuf-JSON's base64 rule for ids);
 *   - 64-bit integers (timestamps, int attribute values, counters) →
 *     JSON STRINGS (the protobuf-JSON rule for int64/fixed64);
 *   - enums → their protobuf names ("SPAN_KIND_INTERNAL",
 *     "STATUS_CODE_ERROR", "AGGREGATION_TEMPORALITY_DELTA");
 *   - one record line per item: {resourceSpans:[…]} | {resourceMetrics:[…]}
 *     | {resourceLogs:[…]} — a complete export-request body.
 *
 * R2 redaction lives here too (the application point "before export"):
 * a documented pattern list is applied to every emitted STRING (safety
 * first — R2 outranks R4; the opt-in capture attributes are additionally
 * the only ones that ever carry raw text). Redaction is pure, so
 * deterministic replays stay byte-stable.
 *
 * Pure module: no pi imports, no I/O.
 */

import type { AttrValue, LogRecordData, MetricData, SpanData } from "../model.ts";
import type { TelemetryItem } from "../queue.ts";
import { PI_OBS_VERSION } from "../semconv.ts";

// ---------------------------------------------------------------------------
// R2 redaction — the documented list (extend via options; never shrink).
// ---------------------------------------------------------------------------

/**
 * The documented R2 redaction patterns, applied to every emitted string:
 * key=value/colon assignments whose key name looks like a credential
 * (an optional Bearer/Basic/Digest scheme word is kept, the credential
 * after it is redacted), OpenAI-style `sk-` keys, raw `Bearer` tokens,
 * and AWS access-key ids. Matched bytes are replaced by `[REDACTED]`.
 *
 * The assignment pattern tolerates JSON quoting between the key, the
 * separator and the value — compact `JSON.stringify` output (tool-input
 * captures: `"api_key":"sk-…"`) and JSON-in-JSON escaped quotes
 * (`\"api_key\": \"sk-…\"`) both redact, not just shell/YAML
 * `key=value` shapes.
 */
export const DEFAULT_REDACTIONS: readonly RegExp[] = [
	/((?:api[_-]?key|secret|token|password|passwd|authorization|credential)[a-z0-9_-]*\\?["']?\s*[:=]\s*\\?["']?(?:(?:bearer|basic|digest)\s+)?)[^\s,;"']+/gi,
	/\bsk-[a-zA-Z0-9_-]{8,}\b/g,
	/\b(bearer\s+)[a-zA-Z0-9._~+/=-]{8,}/gi,
	/\bAKIA[0-9A-Z]{16}\b/g,
];

/** Apply the redaction list to one string (pure; patterns with /g are stateless per call). */
export function redact(text: string, patterns: readonly RegExp[] = DEFAULT_REDACTIONS): string {
	let out = text;
	for (const pattern of patterns) {
		out = out.replace(pattern, (match, ...groups) => {
			// keep a leading capture group (the key= part), redact the rest
			return groups.length > 1 && typeof groups[0] === "string" ? `${groups[0]}[REDACTED]` : "[REDACTED]";
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

/**
 * OTLP/JSON encodes trace/span ids as HEX strings (the OTLP spec's
 * documented override of protobuf-JSON's base64 rule — caught by the
 * Step 9 Collector conformance check). Our ids are already hex.
 */
export function idOnWire(hex: string): string {
	return hex;
}

/** OTel attribute value oneof (int64 → JSON string per protobuf-JSON). */
function anyValue(value: AttrValue, patterns: readonly RegExp[]): { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } {
	if (typeof value === "string") return { stringValue: redact(value, patterns) };
	if (typeof value === "boolean") return { boolValue: value };
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

/** An attribute record → OTLP attribute array (insertion order preserved). */
function toAttributes(record: Record<string, AttrValue>, patterns: readonly RegExp[]): { key: string; value: ReturnType<typeof anyValue> }[] {
	return Object.entries(record).map(([key, value]) => ({ key, value: anyValue(value, patterns) }));
}

/** The OTLP resource block (service.name etc. + pi.* identifying attrs), nested as the `resource` field. */
function resourceField(resource: Record<string, AttrValue>, patterns: readonly RegExp[]): { resource: { attributes: { key: string; value: ReturnType<typeof anyValue> }[] } } {
	return { resource: { attributes: toAttributes(resource, patterns) } };
}

/** The instrumentation scope every pi-obs record is emitted under. */
const scope = (kind: "scopeSpans" | "scopeMetrics" | "scopeLogs"): { scope: { name: string; version: string } } => ({
	scope: { name: `pi-obs ${kind.slice(5).toLowerCase()}`, version: PI_OBS_VERSION },
});

// ---------------------------------------------------------------------------
// Item → one OTLP/JSON export-request body line.
// ---------------------------------------------------------------------------

/** Encode a span as a complete {resourceSpans:[…]} export-request body. */
export function spanRecord(span: SpanData, resource: Record<string, AttrValue>, patterns: readonly RegExp[] = DEFAULT_REDACTIONS): string {
	const out: Record<string, unknown> = {
		traceId: idOnWire(span.traceId),
		spanId: idOnWire(span.spanId),
		name: span.name,
		kind: "SPAN_KIND_INTERNAL",
		startTimeUnixNano: span.startTimeUnixNano,
		attributes: toAttributes(span.attributes, patterns),
		events: span.events.map((event) => ({
			name: event.name,
			timeUnixNano: event.timeUnixNano,
			attributes: toAttributes(event.attributes, patterns),
		})),
		status: { code: `STATUS_CODE_${span.status.code.toUpperCase()}`, ...(span.status.message !== undefined ? { message: span.status.message } : {}) },
	};
	if (span.parentSpanId !== null) out.parentSpanId = idOnWire(span.parentSpanId);
	if (span.endTimeUnixNano !== null) out.endTimeUnixNano = span.endTimeUnixNano;
	return JSON.stringify({ resourceSpans: [{ ...resourceField(resource, patterns), scopeSpans: [{ ...scope("scopeSpans"), spans: [out] }] }] });
}

/** Encode a metric point as a complete {resourceMetrics:[…]} export-request body. */
export function metricRecord(metric: MetricData, resource: Record<string, AttrValue>, patterns: readonly RegExp[] = DEFAULT_REDACTIONS): string {
	const point = { attributes: toAttributes(metric.attributes, patterns), timeUnixNano: metric.timeUnixNano };
	const body =
		metric.type === "counter"
			? {
					sum: {
						dataPoints: [{ ...point, ...(Number.isInteger(metric.value) ? { asInt: String(metric.value) } : { asDouble: metric.value }) }],
						aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
						isMonotonic: true, // OTLP: without this, consumers read the sum as an up-down counter (caught by the Step 9 Collector/Weaver conformance)
					},
				}
			: {
					histogram: {
						dataPoints: [{ ...point, count: "1", sum: metric.value, min: metric.value, max: metric.value }],
						aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
					},
				};
	return JSON.stringify({ resourceMetrics: [{ ...resourceField(resource, patterns), scopeMetrics: [{ ...scope("scopeMetrics"), metrics: [{ name: metric.name, unit: metric.unit, ...body }] }] }] });
}

/** Encode a log record as a complete {resourceLogs:[…]} export-request body. */
export function logRecordLine(log: LogRecordData, resource: Record<string, AttrValue>, patterns: readonly RegExp[] = DEFAULT_REDACTIONS): string {
	return JSON.stringify({
		resourceLogs: [
			{
				...resourceField(resource, patterns),
				scopeLogs: [
					{
						...scope("scopeLogs"),
						logRecords: [
							{
								timeUnixNano: log.timeUnixNano,
								severityText: log.severityText,
								severityNumber: log.severityNumber,
								body: { stringValue: redact(log.body, patterns) },
								attributes: toAttributes(log.attributes, patterns),
							},
						],
					},
				],
			},
		],
	});
}

/**
 * One finished telemetry item → one OTLP/JSON export-request body (a
 * single line for the file exporter, a body for the HTTP exporter).
 * Unknown item kinds yield null — the caller drops and reports (R1).
 */
export function exportRequestLine(item: TelemetryItem, resource: Record<string, AttrValue>, patterns: readonly RegExp[] = DEFAULT_REDACTIONS): string | null {
	if (item.kind === "span") return spanRecord(item.span, resource, patterns);
	if (item.kind === "metric") return metricRecord(item.metric, resource, patterns);
	if (item.kind === "log") return logRecordLine(item.log, resource, patterns);
	return null;
}
