#!/usr/bin/env node
/**
 * validate-external-otel.mjs — structural validation of an external OTLP/JSON
 * dataset (ground truth for the pi-obs OTel-compliance workflow).
 *
 * The dataset (tests/fixtures/data/traces.json.gz — a real OpenTelemetry-demo
 * trace export) is THIRD-PARTY OTLP: pi-obs tooling must accept any
 * standards-compliant payload, not only pi-generated session files. This
 * script independently parses the dataset and checks the OTLP/JSON wire
 * shape, then emits stats (JSON on stdout) that the compliance workflow
 * cross-checks against the parser's own reported counts.
 *
 * Checks (every record must conform):
 *   - line parses as JSON
 *   - carries at least one of resourceSpans / resourceMetrics / resourceLogs
 *   - every resource span has: resource.attributes (incl. service.name),
 *     scopeSpans[].spans[] with traceId, spanId, name, startTimeUnixNano
 *   - every span's traceId is 32 hex chars, spanId 16 hex chars
 *
 * Usage: node validate-external-otel.mjs <traces.jsonl|traces.json.gz>
 * Exit: 0 valid · 1 invalid (message on stderr)
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const HEX = /^[0-9a-f]+$/;
const path = process.argv[2];
if (!path) {
  console.error("usage: node validate-external-otel.mjs <otlp-jsonl|otlp-jsonl.gz>");
  process.exit(2);
}

const raw = readFileSync(path);
const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");

const lines = text.split("\n").filter((l) => l.trim());
const stats = { records: lines.length, spans: 0, traces: 0, services: new Set(), invalid: [] };
const traceIds = new Set();

for (let i = 0; i < lines.length; i++) {
  let rec;
  try {
    rec = JSON.parse(lines[i]);
  } catch (e) {
    stats.invalid.push(`line ${i + 1}: not JSON (${e.message})`);
    continue;
  }
  const spans = (rec.resourceSpans ?? []).flatMap((rs) =>
    (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
  );
  for (const rs of rec.resourceSpans ?? []) {
    const attrs = rs.resource?.attributes ?? [];
    const svc = attrs.find((a) => a.key === "service.name")?.value?.stringValue;
    if (!svc) stats.invalid.push(`line ${i + 1}: resourceSpans entry without service.name`);
    else stats.services.add(svc);
  }
  for (const sp of spans) {
    stats.spans++;
    if (traceIds.has(sp.traceId)) continue;
    traceIds.add(sp.traceId);
    if (sp.traceId?.length !== 32 || !HEX.test(sp.traceId ?? ""))
      stats.invalid.push(`line ${i + 1}: bad traceId ${JSON.stringify(sp.traceId)}`);
    if (sp.spanId?.length !== 16 || !HEX.test(sp.spanId ?? ""))
      stats.invalid.push(`line ${i + 1}: bad spanId ${JSON.stringify(sp.spanId)}`);
    if (!sp.name) stats.invalid.push(`line ${i + 1}: span without name`);
    if (!sp.startTimeUnixNano) stats.invalid.push(`line ${i + 1}: span without startTimeUnixNano`);
  }
  if (!rec.resourceSpans && !rec.resourceMetrics && !rec.resourceLogs)
    stats.invalid.push(`line ${i + 1}: no OTLP signal (resourceSpans/Metrics/Logs)`);
}
stats.traceIds = traceIds.size;
stats.services = [...stats.services].sort();

if (stats.invalid.length) {
  console.error(`INVALID — ${stats.invalid.length} problem(s):`);
  for (const m of stats.invalid.slice(0, 20)) console.error("  " + m);
  process.exit(1);
}
console.log(JSON.stringify({ records: stats.records, spans: stats.spans, traces: stats.traceIds, services: stats.services }));
