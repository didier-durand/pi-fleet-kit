#!/usr/bin/env node
/**
 * pi-obs — traces-to-html: render an otelcol file-exporter JSONL (or any
 * OTLP/JSON-per-line stream, e.g. `piobs report` output) as ONE self-
 * contained HTML page, and a markdown rendition for job summaries.
 *
 * HTML mode (default): a GLOBAL summary (totals for the whole file) followed
 * by ONE EXPANDABLE SECTION PER SESSION (native <details>, no JavaScript).
 * Sessions are identified by traceId — one trace per pi session — and the
 * human-readable session id / file come from the pi.session root span's
 * attributes (pi.session.id, pi.session.file). Each section repeats the
 * full pattern: cards, span table with a proportional Gantt timeline
 * (session-local window), and the session's metrics table. OTLP metrics
 * carry no trace linkage, so per-session metrics are attributed by export
 * order (exact for sequential sessions; noted on multi-session pages).
 *
 * Markdown mode (--markdown): the flat single-page rendition (tables +
 * unicode timeline) for surfaces that render markdown natively — e.g. a
 * GitHub Actions job summary, where artifacts are always zips and cannot
 * be viewed in place.
 *
 * Zero dependencies; node >= 23.6.
 *
 * Usage:
 *   node utils/traces-to-html.ts <collected.jsonl> [out.html]
 *     (default out: <input>.html next to the input)
 *   node utils/traces-to-html.ts --markdown <collected.jsonl> <out.md>
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Attr { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } }
interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano?: string; attributes?: Attr[]; status?: { code?: number } }
interface ScopeSpan { scope?: { name?: string }; spans?: Span[] }
interface ResourceSpans { resource?: { attributes?: Attr[] }; scopeSpans?: ScopeSpan[] }
interface Metric { name: string; unit?: string; sum?: { dataPoints?: { asInt?: string; asDouble?: number }[] }; histogram?: { dataPoints?: { sum?: number }[] } }
interface ScopeMetric { metrics?: Metric[] }
interface ResourceMetrics { scopeMetrics?: ScopeMetric[] }

const argv = process.argv.slice(2);
const MARKDOWN = argv[0] === "--markdown";
const rest = MARKDOWN ? argv.slice(1) : argv;
const [input, outputArg] = rest;
if (!input) {
	console.error("usage: node utils/traces-to-html.ts [--markdown] <collected.jsonl> [out]");
	process.exit(2);
}

interface Row { traceId: string; spanId: string; parentId: string; name: string; service: string; scope: string; startMs: number; durMs: number; status: number }
interface MetricEntry { unit: string; value: number; count: number }
interface Session { traceId: string; sessionId: string; sessionFile: string; spans: Row[]; metrics: Map<string, MetricEntry>; order: number }

const attrStr = (attrs: Attr[] | undefined, key: string): string => {
	const a = attrs?.find((x) => x.key === key);
	return a ? String(a.value.stringValue ?? "") : "";
};

const allRows: Row[] = [];
const globalMetrics = new Map<string, MetricEntry>();
const unattributedMetrics = new Map<string, MetricEntry>(); // seen before any span
const sessions = new Map<string, Session>();
let sessionOrder = 0;
let currentSession: Session | null = null; // metric attribution by export order

const sessionFor = (traceId: string): Session => {
	let s = sessions.get(traceId);
	if (!s) {
		s = { traceId, sessionId: "", sessionFile: "", spans: [], metrics: new Map(), order: sessionOrder++ };
		sessions.set(traceId, s);
	}
	return s;
};

for (const line of readFileSync(input, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const rec = JSON.parse(line) as Partial<{ resourceSpans: ResourceSpans[]; resourceMetrics: ResourceMetrics[] }>;
	for (const rs of rec.resourceSpans ?? []) {
		const service = attrStr(rs.resource?.attributes, "service.name") || "unknown";
		for (const ss of rs.scopeSpans ?? []) {
			const scope = ss.scope?.name ?? "";
			for (const sp of ss.spans ?? []) {
				const session = sessionFor(sp.traceId);
				currentSession = session;
				const startMs = Number(sp.startTimeUnixNano) / 1e6;
				const endMs = sp.endTimeUnixNano ? Number(sp.endTimeUnixNano) / 1e6 : startMs;
				const row: Row = {
					traceId: sp.traceId, spanId: sp.spanId, parentId: sp.parentSpanId ?? "",
					name: sp.name, service, scope, startMs, durMs: Math.max(endMs - startMs, 0),
					status: sp.status?.code === 2 || sp.status?.code === 3 ? 2 : 0, // ERROR
				};
				session.spans.push(row);
				allRows.push(row);
				if (sp.name === "pi.session") {
					session.sessionId = attrStr(sp.attributes, "pi.session.id");
					session.sessionFile = attrStr(sp.attributes, "pi.session.file");
				}
			}
		}
	}
	for (const rm of rec.resourceMetrics ?? []) {
		for (const sm of rm.scopeMetrics ?? []) {
			for (const m of sm.metrics ?? []) {
				// counters: sum.dataPoints[].asInt/asDouble — histograms (the
				// duration metrics): histogram.dataPoints[].sum. A metric with
				// no recognizable points is NOT recorded (never as a fake 0).
				let value = 0;
				let points = 0;
				for (const dp of m.sum?.dataPoints ?? []) { value += Number(dp.asInt ?? dp.asDouble ?? 0); points += 1; }
				for (const dp of m.histogram?.dataPoints ?? []) { value += Number(dp.sum ?? 0); points += 1; }
				if (points === 0) continue;
				const merge = (map: Map<string, MetricEntry>) => {
					const e = map.get(m.name) ?? { unit: m.unit ?? "", value: 0, count: 0 };
					e.value += value; e.count += points;
					map.set(m.name, e);
				};
				merge(globalMetrics);
				if (currentSession !== null) merge(currentSession.metrics);
				else merge(unattributedMetrics);
			}
		}
	}
}

// A single session makes early (pre-span) metric records unambiguously its
// own: fold them in so the session table matches the global totals.
if (sessions.size === 1) {
	const only = [...sessions.values()][0];
	for (const [name, e] of unattributedMetrics) {
		const t = only.metrics.get(name) ?? { unit: e.unit, value: 0, count: 0 };
		t.value += e.value; t.count += e.count;
		only.metrics.set(name, t);
	}
}

const sessionList = [...sessions.values()].sort((a, b) => {
	const a0 = a.spans.length ? Math.min(...a.spans.map((r) => r.startMs)) : Infinity;
	const b0 = b.spans.length ? Math.min(...b.spans.map((r) => r.startMs)) : Infinity;
	return a0 - b0;
});

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);
const color = (s: string): string => {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h}, 65%, 45%)`;
};
const windowOf = (rows: Row[]): { t0: number; span: number } => {
	if (rows.length === 0) return { t0: 0, span: 1 };
	const t0 = Math.min(...rows.map((r) => r.startMs));
	const tMax = Math.max(...rows.map((r) => r.startMs + r.durMs));
	return { t0, span: Math.max(tMax - t0, 1) };
};

// ---------------- markdown mode: the flat rendition (unchanged behavior) --
if (MARKDOWN) {
	const traceIds = new Set(allRows.map((r) => r.traceId));
	const { t0, span } = windowOf(allRows);
	const TL = 24;
	const bar = (r: Row): string => {
		const left = Math.min(TL, Math.round((r.startMs - t0) / span * TL));
		const len = Math.max(1, Math.min(TL - left, Math.round(r.durMs / span * TL)));
		return "·".repeat(left) + "█".repeat(len) + "·".repeat(Math.max(0, TL - left - len));
	};
	const md = [
		"### pi-obs — collected traces (rendered)",
		"",
		`**${allRows.length} spans · ${traceIds.size} traces · ${fmt(span)} window · ${globalMetrics.size} metrics** — timeline: 24 cells across the window`,
		"",
		"| span | service | duration | offset | timeline |",
		"|---|---|---:|---:|---|",
		...allRows.map((r) => `| ${r.name}${r.status === 2 ? " ⚠️" : ""} | ${r.service} | ${fmt(r.durMs)} | ${fmt(r.startMs - t0)} | \`${bar(r)}\` |`),
		...(globalMetrics.size ? ["", "**metrics (summed data points)**", "", "| metric | value | unit | points |", "|---|---:|---|---:|"] : []),
		...[...globalMetrics.entries()].map(([name, e]) => `| ${name} | ${e.value.toLocaleString()} | ${e.unit} | ${e.count} |`),
	].join("\n") + "\n";
	const mdOut = outputArg ?? `${input}.md`;
	writeFileSync(mdOut, md);
	console.log(`${allRows.length} span(s) · ${traceIds.size} trace(s) · ${globalMetrics.size} metric(s) → ${mdOut} (markdown)`);
	process.exit(0);
}

// ---------------- HTML mode: global summary + expandable sessions -------
const metricTable = (map: Map<string, MetricEntry>, title: string): string =>
	map.size ? `<h3>${title}</h3><table><tr><th>metric</th><th class="num">value</th><th>unit</th><th class="num">points</th></tr>${
		[...map.entries()].map(([name, e]) => `<tr><td>${esc(name)}</td><td class="num">${e.value.toLocaleString()}</td><td>${esc(e.unit)}</td><td class="num">${e.count}</td></tr>`).join("\n")
	}</table>` : "";

const spanTable = (rows: Row[]): string => {
	if (rows.length === 0) return "";
	const { t0, span } = windowOf(rows);
	const sorted = [...rows].sort((a, b) => a.startMs - b.startMs || b.durMs - a.durMs);
	const bars = sorted.map((r) => {
		const left = ((r.startMs - t0) / span) * 100;
		const width = Math.max((r.durMs / span) * 100, 0.3);
		const c = color(r.service);
		const tip = `${esc(r.name)} · ${esc(r.service)}${r.scope ? " · " + esc(r.scope) : ""} — ${fmt(r.durMs)} (offset ${fmt(r.startMs - t0)})`;
		return `<tr class="${r.status === 2 ? "err" : ""}"><td>${esc(r.name)}</td><td>${esc(r.service)}</td><td class="mono">${esc(r.traceId.slice(0, 8))}…</td><td class="mono">${esc(r.parentId.slice(0, 8)) || "root"}</td><td class="num">${fmt(r.durMs)}</td><td class="num">${fmt(r.startMs - t0)}</td><td class="tl"><div class="bar" style="margin-left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${c}" title="${tip}"></div></td></tr>`;
	}).join("\n");
	return `<table>
 <tr><th>span</th><th>service</th><th>trace</th><th>parent</th><th class="num">duration</th><th class="num">offset</th><th>timeline</th></tr>
 ${bars}
</table>`;
};

const gw = windowOf(allRows);
const totalErrors = allRows.filter((r) => r.status === 2).length;
const multi = sessionList.length > 1;

const sessionSection = (s: Session, open: boolean): string => {
	const { t0: s0, span: sSpan } = windowOf(s.spans);
	const errors = s.spans.filter((r) => r.status === 2).length;
	const sid = s.sessionId || s.traceId;
	const label = s.sessionId ? `<span class="mono">${esc(s.sessionId)}</span>` : `<span class="mono">${esc(s.traceId.slice(0, 16))}…</span>`;
	return `<details class="session"${open ? " open" : ""}>
<summary>${label} · ${s.spans.length} span${s.spans.length === 1 ? "" : "s"} · ${fmt(sSpan)}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}${s.sessionFile ? ` · <span class="dim">${esc(s.sessionFile)}</span>` : ""}</summary>
<div class="cards">
 <div class="card"><b>${s.spans.length}</b><span>spans</span></div>
 <div class="card"><b>${fmt(sSpan)}</b><span>session window</span></div>
 <div class="card"><b>${errors}</b><span>errors</span></div>
 <div class="card"><b>${s.metrics.size}</b><span>metrics</span></div>
</div>
${spanTable(s.spans)}
${metricTable(s.metrics, "metrics (this session)")}
</details>`;
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pi-obs — collected traces</title>
<style>
 body{font:13px/1.45 -apple-system,system-ui,sans-serif;margin:24px;color:#1a1a2e;background:#fafafa}
 h1{font-size:18px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px} h3{font-size:13px;margin:16px 0 8px}
 .sub{color:#666;margin-bottom:16px}
 .cards{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
 .card{background:#fff;border:1px solid #e2e2ea;border-radius:8px;padding:10px 16px}
 .card b{display:block;font-size:20px} .card span{color:#666;font-size:12px}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e2e2ea;border-radius:8px}
 th,td{padding:5px 10px;text-align:left;border-bottom:1px solid #eee}
 th{background:#f3f3f8;font-size:12px;position:sticky;top:0}
 .mono{font-family:ui-monospace,monospace;font-size:12px;color:#555}
 .dim{color:#999;font-size:12px}
 .num{text-align:right;font-variant-numeric:tabular-nums}
 .tl{width:34%} .bar{height:12px;border-radius:3px;min-width:2px;position:relative}
 tr.err td{color:#b00020}
 details.session{background:#fff;border:1px solid #e2e2ea;border-radius:8px;margin:10px 0;padding:0}
 details.session>summary{padding:10px 14px;cursor:pointer;list-style:revert;font-size:13px}
 details.session[open]>summary{border-bottom:1px solid #eee;background:#f9f9fd;border-radius:8px 8px 0 0}
 details.session>summary::-webkit-details-marker{color:#888}
 details.session>:not(summary){margin:14px}
 .note{color:#777;font-size:12px;margin:8px 0}
</style></head><body>
<h1>pi-obs — collected traces</h1>
<div class="sub">${esc(input)} · rendered ${new Date().toISOString()}</div>
<h2>Global summary — the whole file</h2>
<div class="cards">
 <div class="card"><b>${sessionList.length}</b><span>session${sessionList.length === 1 ? "" : "s"}</span></div>
 <div class="card"><b>${allRows.length}</b><span>spans</span></div>
 <div class="card"><b>${fmt(gw.span)}</b><span>window</span></div>
 <div class="card"><b>${globalMetrics.size}</b><span>metrics</span></div>
 <div class="card"><b>${totalErrors}</b><span>errors</span></div>
</div>
${metricTable(globalMetrics, "totals — metrics (whole file)")}
${multi ? '<p class="note">OTLP metrics carry no trace linkage: per-session metrics below are attributed by export order (exact for sequential sessions).</p>' : ""}
<h2>Sessions — one expandable section each</h2>
${sessionList.map((s) => sessionSection(s, !multi)).join("\n") || '<p class="note">no spans in the input</p>'}
</body></html>`;

const output = outputArg ?? `${input}.html`;
writeFileSync(output, html);
console.log(`${allRows.length} span(s) · ${sessionList.length} session(s) · ${globalMetrics.size} metric(s) → ${output}`);
