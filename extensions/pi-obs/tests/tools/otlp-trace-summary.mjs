#!/usr/bin/env node
/**
 * otlp-trace-summary.mjs — render the span tree captured by
 * otlp-capture-receiver.mjs as a markdown block: one line per span with
 * its duration, content excerpts and key attributes — the visual proof of
 * what the pi-obs OTLP capture actually contains.
 *
 * Usage: node otlp-trace-summary.mjs <capture.jsonl> [--max=<chars>]
 * Output (stdout): a ```-fenced tree, one per trace; empty when no spans.
 *
 * Tree shape (pi-obs hierarchy):
 *   pi.session (total)
 *   └─ pi.run (total)
 *      └─ pi.turn (total)
 *         ├─ ◆ pi.user.input — "…"          (span event, content excerpt)
 *         ├─ pi.model [provider/model] (ms) — in N · out N · $C — "…"
 *         └─ pi.tool <name> (ms) — "…"
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const maxArg = args.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.slice(6)) : 64;
if (!file) {
  console.error("usage: node otlp-trace-summary.mjs <capture.jsonl> [--max=<chars>]");
  process.exit(2);
}

const attrOf = (attrs, key) => {
  for (const a of attrs ?? []) {
    if (a.key !== key) continue;
    const v = a.value ?? {};
    return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return undefined;
};
const excerpt = (s) => {
  if (typeof s !== "string" || !s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX ? one.slice(0, MAX - 1) + "…" : one;
};
const dur = (start, end) => {
  const ms = Math.round((Number(end) - Number(start)) / 1e6);
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};

// parse every capture line into spans (keyed by spanId)
const spans = new Map();
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let body;
  try { body = JSON.parse(JSON.parse(line).body ?? "{}"); } catch { continue; }
  for (const rs of body.resourceSpans ?? []) {
    const service = attrOf(rs.resource?.attributes, "service.name") ?? "unknown";
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        spans.set(sp.spanId, {
          spanId: sp.spanId,
          name: sp.name,
          parent: sp.parentSpanId,
          traceId: sp.traceId,
          service,
          start: sp.startTimeUnixNano,
          end: sp.endTimeUnixNano,
          content: attrOf(sp.attributes, "pi.content.text"),
          provider: attrOf(sp.attributes, "gen_ai.system"),
          model: attrOf(sp.attributes, "gen_ai.request.model"),
          in: attrOf(sp.attributes, "gen_ai.usage.input_tokens"),
          out: attrOf(sp.attributes, "gen_ai.usage.output_tokens"),
          cost: attrOf(sp.attributes, "pi.cost.total"),
          toolName: attrOf(sp.attributes, "pi.tool.name"),
          events: (sp.events ?? []).map((ev) => ({
            name: ev.name,
            content: attrOf(ev.attributes, "pi.content.text"),
          })),
        });
      }
    }
  }
}
if (spans.size === 0) {
  console.log("(no spans captured)");
  process.exit(0);
}

// group by trace; render each trace's tree
const byTrace = new Map();
for (const sp of spans.values()) {
  if (!byTrace.has(sp.traceId)) byTrace.set(sp.traceId, []);
  byTrace.get(sp.traceId).push(sp);
}

const renderSpan = (sp, list, prefix, depth, isLast, out, visited) => {
  if (visited.has(sp.spanId)) return; // cycle guard
  visited.add(sp.spanId);
  const branch = depth === 0 ? "" : (isLast ? "└─ " : "├─ ");
  const durStr = dur(sp.start, sp.end);
  let label = sp.name;
  if (sp.name === "pi.tool" && sp.toolName) label += ` <${sp.toolName}>`;
  if (sp.name === "pi.model" && (sp.model || sp.provider)) label += ` [${sp.provider ?? "?"}/${sp.model ?? "?"}]`;
  let detail = "";
  if (sp.name === "pi.model") {
    const parts = [];
    if (sp.in !== undefined) parts.push(`in ${Number(sp.in).toLocaleString("en-US")}`);
    if (sp.out !== undefined) parts.push(`out ${Number(sp.out).toLocaleString("en-US")}`);
    if (sp.cost !== undefined) parts.push(`$${sp.cost}`);
    if (parts.length) detail = ` — ${parts.join(" · ")}`;
  }
  const content = sp.content ? ` — "${excerpt(sp.content)}"` : "";
  out.push(`${prefix}${branch}${label} (${durStr})${detail}${content}`);
  // children (same trace only) + span events, interleaved by timestamp:
  // events (◆) render inline — pi.user.input carries the prompt text right
  // where it happened, next to the pi.model span carrying the answer.
  const children = list.filter((s) => s.parent === sp.spanId);
  const childPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : "│  ");
  const nodes = [
    ...(sp.events ?? []).map((ev) => ({
      t: Number(ev.timeUnixNano ?? 0), kind: "event", ev,
    })),
    ...children.map((c) => ({ t: Number(c.start), kind: "span", c })),
  ].sort((a, b) => a.t - b.t);
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    if (n.kind === "event") {
      const branch = depth === 0 ? "◆ " : last ? "└─ ◆ " : "├─ ◆ ";
      const evContent = n.ev.content ?? attrOf(n.ev.attributes, "pi.tool.command") ?? attrOf(n.ev.attributes, "pi.tool.path");
      out.push(`${childPrefix}${branch}${n.ev.name}${evContent ? ` — "${excerpt(evContent)}"` : ""}`);
    } else {
      renderSpan(n.c, list, childPrefix, depth + 1, last, out, visited);
    }
  });
};

for (const [traceId, list] of byTrace) {
  // roots: spans in this trace whose parent is absent/zero/outside the trace
  const inTrace = new Set(list.map((sp) => sp.spanId));
  const roots = list.filter((sp) => !sp.parent || /^[0]+$/.test(sp.parent) || !inTrace.has(sp.parent));
  console.log(`trace ${traceId.slice(0, 16)}… — ${list.length} span(s)`);
  console.log("```");
  const visited = new Set();
  for (const root of roots) {
    const out = [];
    renderSpan(root, list, "", 0, true, out, visited);
    console.log(out.join("\n"));
  }
  // any spans not reachable from roots (broken parent chains) — list flat
  for (const sp of list) {
    if (!visited.has(sp.spanId)) {
      const content = sp.content ? ` — "${excerpt(sp.content)}"` : "";
      console.log(`   (unlinked) ${sp.name} (${dur(sp.start, sp.end)})${content}`);
    }
  }
  console.log("```");
  console.log();
}
