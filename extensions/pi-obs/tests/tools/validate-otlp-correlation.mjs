#!/usr/bin/env node
/**
 * validate-otlp-correlation.mjs — validates that the telemetry captured
 * from a live pi-obs run correlates the prompt with the LLM's answer.
 *
 * Reads the capture file (one JSON line per OTLP/HTTP request, as written
 * by otlp-capture-receiver.mjs), extracts all spans and span events, and
 * checks:
 *   1. a `pi.user.input` record whose `pi.content.text` contains the
 *      expected prompt substring
 *   2. a `pi.model` span whose `pi.content.text` contains the expected
 *      answer substring
 *   3. both records share the same W3C traceId — the prompt and the
 *      answer belong to the same trace
 *
 * Usage:
 *   node validate-otlp-correlation.mjs <capture.jsonl> <prompt-substr> <answer-substr>
 * Exit: 0 correlated · 1 missing/mismatched (details on stderr)
 */
import { readFileSync } from "node:fs";

const [captureFile, promptSubstr, answerSubstr] = process.argv.slice(2);
if (!captureFile || promptSubstr === undefined || answerSubstr === undefined) {
  console.error("usage: node validate-otlp-correlation.mjs <capture.jsonl> <prompt-substr> <answer-substr>");
  process.exit(2);
}

// attribute extraction from OTLP/JSON ({key, value:{stringValue|int_value…}})
const attrOf = (attrs, key) => {
  for (const a of attrs ?? []) {
    if (a.key !== key) continue;
    const v = a.value ?? {};
    return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return undefined;
};

// collect every span and every span event, flattened:
//   { traceId, name, kind: "span"|"event", contentText }
const records = [];
for (const line of readFileSync(captureFile, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let req;
  try { req = JSON.parse(line); } catch { continue; }
  let body;
  try { body = JSON.parse(req.body ?? "{}"); } catch { continue; }
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        records.push({
          traceId: sp.traceId, name: sp.name, kind: "span",
          contentText: attrOf(sp.attributes, "pi.content.text"),
        });
        for (const ev of sp.events ?? []) {
          records.push({
            traceId: sp.traceId, name: ev.name, kind: "event",
            contentText: attrOf(ev.attributes, "pi.content.text"),
          });
        }
      }
    }
  }
}

const problems = [];
const promptRec = records.find((r) => r.name === "pi.user.input" && typeof r.contentText === "string" && r.contentText.includes(promptSubstr));
if (!promptRec) problems.push(`no pi.user.input record with content containing "${promptSubstr}" (records with content: ${records.filter((r) => r.contentText).length})`);

const modelRecs = records.filter((r) => r.name === "pi.model" && typeof r.contentText === "string" && r.contentText.includes(answerSubstr));
if (modelRecs.length === 0) problems.push(`no pi.model span with content containing "${answerSubstr}"`);

let correlationOk = false;
if (promptRec && modelRecs.length > 0) {
  correlationOk = modelRecs.some((m) => m.traceId === promptRec.traceId);
  if (!correlationOk) problems.push("prompt and answer found but on DIFFERENT traceIds — no correlation");
}

if (problems.length) {
  console.error("CORRELATION FAILED:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  promptTraceId: promptRec.traceId,
  answerTraceId: promptRec.traceId,
  promptExcerpt: promptRec.contentText.slice(0, 80),
  answerExcerpt: modelRecs.find((m) => m.traceId === promptRec.traceId).contentText.slice(0, 80),
}));
