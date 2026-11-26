#!/usr/bin/env node
/**
 * otel-watchdog — real-time alerting over the permanent OTLP archive.
 *
 * Companion service to the host `otlp-collector` (config/otelcol-watchdog.yaml):
 * tails the collector's raw OTLP/JSONL archive incrementally (byte offset,
 * persisted state) and alerts the operator on:
 *
 *   1. FAULTS   — pi-obs fault log records (severity ERROR): handler faults,
 *                 exporter failures, drop notices (R1/R4 fault signaling)
 *   2. ERRORS   — spans with status code ERROR (failed tools, aborted turns)
 *   3. SILENCE  — no OTLP data of any kind for WATCHDOG_QUIET_HOURS: the
 *                 collector may be up but nothing is flowing (misconfig,
 *                 stopped agents) — a gentle heartbeat alarm
 *   4. ARRIVALS — first span ever seen from a service (informational: an
 *                 agent just came online)
 *
 * Alerts go to stdout (the `docker compose logs -f otel-watchdog` feed on
 * the Mac) AND are appended durably to WATCHDOG_ALERTS (JSONL). Deliberately
 * dependency-free: fs + timers only, so the node:alpine image needs nothing.
 *
 * Tail mechanics: the archive is appended by the collector and rotated by
 * size (lumberjack: active file renamed to .1, a fresh one starts). The
 * watcher reads NEW bytes with positional readSync (readFileSync ignores
 * start/end), buffers torn lines as BYTES until their newline arrives
 * (multibyte-safe), and detects rotation by inode change — it then rewinds
 * and reads the new segment from its start. A duplicate alert across a
 * rotation is preferred over a missed one.
 */

import {
	appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync,
	renameSync, statSync, writeFileSync,
} from "node:fs";

// --- configuration ----------------------------------------------------------

const ARCHIVE = process.env.WATCHDOG_ARCHIVE ?? "/data/otel-archive.jsonl";
const STATE = process.env.WATCHDOG_STATE ?? "/data/watchdog-state.json";
const ALERTS = process.env.WATCHDOG_ALERTS ?? "/data/watchdog-alerts.jsonl";
const POLL_MS = Number(process.env.WATCHDOG_POLL_MS ?? 5000);
const QUIET_HOURS = Number(process.env.WATCHDOG_QUIET_HOURS ?? 6);
const QUIET_MS = QUIET_HOURS * 3600_000;
const READ_CAP = 16 * 1024 * 1024; // max bytes consumed per poll (rest next poll)
const HEARTBEAT_MS = 60 * 60_000;  // liveness line on stdout, hourly

// --- state (byte offset + per-service lastSeen) -------------------------------

const defaults = { offset: 0, services: {} };
let state = loadState();
if (!existsSync(STATE)) {
	// FIRST RUN: start at the current end of file — a fresh watchdog alerts on
	// the future, never replays history (an old fault is not a new incident).
	try { state.offset = statSync(ARCHIVE).size; } catch { state.offset = 0; }
	saveState();
}

function loadState() {
	try {
		const doc = JSON.parse(readFileSync(STATE, "utf8"));
		if (typeof doc.offset === "number" && doc.offset >= 0) return { ...defaults, ...doc };
	} catch { /* no state yet */ }
	return { ...defaults };
}

function saveState() {
	try {
		const tmp = `${STATE}.tmp`;
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, STATE); // atomic swap
	} catch { /* state persistence is best-effort: alerts are durable, state is not critical */ }
}

// --- alerting -----------------------------------------------------------------

let alertCount = 0;

function alert(kind, service, detail) {
	alertCount += 1;
	const ts = new Date().toISOString();
	const entry = { ts, kind, service, detail };
	console.log(`🚨 [watchdog] ${ts} ${kind.toUpperCase()} ${service ? `(${service}) ` : ""}${detail}`);
	try { appendFileSync(ALERTS, `${JSON.stringify(entry)}\n`); } catch { /* alert file best-effort */ }
}

function info(text) {
	console.log(`👁  [watchdog] ${new Date().toISOString()} ${text}`);
}

// --- evaluation ---------------------------------------------------------------

const seenServices = new Set(Object.keys(state.services));
let lastDataAt = Date.now(); // "silence" is measured from watcher start or last byte seen
let silenceWindowsFired = 0;  // one silence alarm per quiet window — never a flood
let eventsSeen = 0;

function processLine(line) {
	let doc;
	try { doc = JSON.parse(line); } catch { return; } // torn write across rotation: skip
	eventsSeen += 1;
	lastDataAt = Date.now();

	for (const rs of doc.resourceSpans ?? []) {
		const svc = attr(rs.resource?.attributes, "service.name") ?? "?";
		touch(svc);
		for (const ss of rs.scopeSpans ?? []) {
			for (const span of ss.spans ?? []) {
				if (String(span.status?.code ?? "").toUpperCase() === "ERROR") {
					alert("error-span", svc, `span ${span.name} ended with status ERROR`);
				}
			}
		}
	}
	for (const rl of doc.resourceLogs ?? []) {
		const svc = attr(rl.resource?.attributes, "service.name") ?? "?";
		touch(svc);
		for (const sl of rl.scopeLogs ?? []) {
			for (const rec of sl.logRecords ?? []) {
				if (String(rec.severityText ?? "").toUpperCase().startsWith("ERROR")) {
					alert("fault", svc, `fault log record: ${String(rec.body?.stringValue ?? "(no body)").slice(0, 200)}`);
				}
			}
		}
	}
	// metrics only advance the liveness clock (for the silence alarm)
	for (const rm of doc.resourceMetrics ?? []) {
		const svc = attr(rm.resource?.attributes, "service.name");
		if (svc) touch(svc);
	}
}

function touch(svc) {
	const now = Date.now();
	if (!seenServices.has(svc)) {
		seenServices.add(svc);
		info(`first data from service "${svc}" — agent came online`);
	}
	state.services[svc] = { lastSeen: now };
}

function attr(attributes, key) {
	const found = (attributes ?? []).find((a) => a.key === key);
	return found ? Object.values(found.value ?? {})[0] : undefined;
}

// --- tail: positional reads + byte-level line buffering ------------------------

let fd = null;
let fdIno = 0;
let remainder = Buffer.alloc(0); // torn line held as BYTES until its newline arrives

function openArchive() {
	if (fd !== null) {
		try {
			const ino = statSync(ARCHIVE).ino;
			if (ino !== fdIno) { closeSync(fd); fd = null; } // rotation: the fd points at the renamed segment
		} catch { return false; } // vanished mid-poll: skip
	}
	if (fd === null) {
		try {
			fd = openSync(ARCHIVE, "r");
			fdIno = statSync(ARCHIVE).ino;
		} catch { return false; } // not created yet: nothing to watch
	}
	return true;
}

/** Read the new bytes from `offset`; returns { bytes, end } (end = new offset). */
function readNew(offset) {
	const chunks = [];
	let total = 0;
	let pos = offset;
	const buf = Buffer.alloc(1 << 16);
	for (;;) {
		const n = readSync(fd, buf, 0, buf.length, pos);
		if (n === 0) break;
		chunks.push(Buffer.from(buf.subarray(0, n))); // copy: buf is reused
		total += n;
		pos += n;
		if (total >= READ_CAP) break; // rest is picked up next poll
	}
	return { bytes: Buffer.concat(chunks), end: pos };
}

function poll() {
	let st;
	try { st = statSync(ARCHIVE); } catch { return; } // not created yet: nothing to watch
	if (!openArchive()) return;

	if (st.size < state.offset) {
		// rotation or truncation: the active segment restarted — rewind
		info(`archive rotated/truncated (${state.offset} → ${st.size} bytes) — rewinding to read the new segment`);
		state.offset = 0;
		remainder = Buffer.alloc(0);
	}
	if (st.size > state.offset) {
		const { bytes, end } = readNew(state.offset);
		state.offset = end;
		lastDataAt = Date.now();
		const all = remainder.length === 0 ? bytes : Buffer.concat([remainder, bytes]);
		let start = 0;
		for (;;) {
			const nl = all.indexOf(10, start); // \n — process only complete lines
			if (nl === -1) break;
			const line = all.subarray(start, nl).toString("utf8");
			start = nl + 1;
			if (line.trim()) processLine(line);
		}
		remainder = all.subarray(start);
		silenceWindowsFired = 0; // data arrived: the quiet streak restarts
		saveState();
	}

	const quietWindows = QUIET_MS > 0 ? Math.floor((Date.now() - lastDataAt) / QUIET_MS) : 0;
	if (quietWindows > silenceWindowsFired) {
		silenceWindowsFired = quietWindows;
		alert("silence", "", `no OTLP data for ${Math.floor((Date.now() - lastDataAt) / 3600_000)}h — collector up but nothing flowing (agents idle or the pipeline is broken)`);
	}
}

// the POLL interval keeps the process alive (ref'd) — unref'ing it would
// let the event loop drain and the watcher exit silently right after start
setInterval(poll, POLL_MS);
setInterval(() => info(`alive — ${eventsSeen} event(s) seen, ${alertCount} alert(s) raised, ${seenServices.size} known service(s)`), HEARTBEAT_MS).unref();
info(`watching ${ARCHIVE} from byte ${state.offset} (poll ${POLL_MS}ms, quiet-hours ${QUIET_HOURS}, alerts → ${ALERTS} + stdout)`);

process.on("SIGTERM", () => { saveState(); info("SIGTERM — state saved, bye"); process.exit(0); });
process.on("SIGINT", () => { saveState(); info("SIGINT — state saved, bye"); process.exit(0); });
