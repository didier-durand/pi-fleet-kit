/**
 * pi-obs — post-mortem replay (SPECS R3b, DEV_PLAN Step 7).
 *
 * Generates an OTel-formatted report for a FINISHED session — selected
 * by session id (resolved against a session directory by scanning file
 * HEADERS: the header wins over the file name) or by file path —
 * without running the agent, replaying the session's own append-only
 * JSONL entries through the SAME entity builders as live capture
 * (model.ts): no parallel formatting path.
 *
 *   - entry timestamps become span timestamps;
 *   - assistant messages open/close `pi.model` spans (provider/model/
 *     usage/stopReason from the entry); tool results become `pi.tool`
 *     spans; user messages become `pi.user.input` events;
 *     `usage` / `compaction` / `model_change` / `thinking_level_change` /
 *     `tree` entries become their R3 entities;
 *   - W3C trace/span ids are RE-DERIVED deterministically from the
 *     session id + entry ids (hash-based) — a re-run of the report is
 *     byte-stable;
 *   - live-only data is OMITTED, never fabricated (no streaming
 *     deltas, no time-to-first-token, no durations): the resource
 *     carries `pi.replay=true` and `pi.replay.source`;
 *   - branch handling: the active branch is rebuilt from the entry
 *     tree (`id`/`parentId`) exactly as pi replays it — the default
 *     leaf is the file's last entry; `--branch=<entry-id>` selects the
 *     branch ending at that entry; abandoned-branch entries are
 *     excluded from the report;
 *   - R2 parity: the same redaction/opt-in rules govern replayed
 *     content, applied to entry message bodies;
 *   - output: OTLP/JSON export-request bodies, one per line (the same
 *     encoding as the file exporter) — pipes straight into otelcol or
 *     jq. Posting to a backend / writing a file is Step 8's command
 *     surface over these same items.
 *
 * Replay is a user-initiated COMMAND, not a hook: resolution and
 * input problems throw `ReplayError` with actionable messages (the
 * command layer maps them to stderr + non-zero exit). Pure module: no
 * pi imports; malformed lines are skipped, never fatal.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addEvent,
	counter,
	deriveSpanId,
	deriveTraceId,
	endSpan,
	genaiAttributes,
	startModelSpan,
	startSessionSpan,
	startToolSpan,
	tokenCounters,
	type AttrValue,
	type MetricData,
} from "./model.ts";
import type { TelemetryItem } from "./queue.ts";
import { DEFAULT_REDACTIONS, exportRequestLine, redact } from "./exporters/otlp-json.ts";
import { PI_OBS_VERSION } from "./semconv.ts";

/** One session JSONL entry — external data, read defensively. */
export type ReplayEntry = Record<string, unknown>;

/** A loaded session file. */
export interface SessionFile {
	/** The file path (verbatim for path mode; resolved for id mode). */
	path: string;
	/** The session id from the file's header (authoritative). */
	sessionId: string;
	/** All non-header entries, file order. */
	entries: ReplayEntry[];
}

/** Replay options (R2 parity + branch selection). */
export interface ReplayOptions {
	/** R2 opt-in: verbatim user/assistant text (redacted before export). */
	capturePrompts?: boolean;
	/** R2 opt-in: tool result bodies (redacted before export). */
	captureToolIo?: boolean;
	/** `--branch=<entry-id>`: the branch ending at this entry. Default: the file's last entry. */
	branchEntryId?: string;
	/** R2 redaction patterns (defaults: the documented list). */
	redactions?: readonly RegExp[];
	/** OTel `service.name` for the report resource (default `pi-agent`). */
	resourceService?: string;
}

/** Actionable replay failure (resolution, unreadable input, bad branch). */
export class ReplayError extends Error {
	constructor(message: string) {
		super(`pi-obs replay: ${message}`);
		this.name = "ReplayError";
	}
}

// --- defensive readers (entries are external data — never trust) -----------

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const tsOf = (entry: ReplayEntry, fallback: number): number => {
	const parsed = Date.parse(String(entry.timestamp ?? ""));
	return Number.isFinite(parsed) ? parsed : fallback;
};

/** Extract text from a pi message content (string or block array). */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
			.join("");
	}
	return "";
}

const hash12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

// --- loading + resolution ---------------------------------------------------

/** Load one session JSONL file (path used verbatim); malformed lines are skipped. */
export function loadSessionFile(path: string): SessionFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ReplayError(`cannot read session file "${path}" (${String(error)})`);
	}
	const entries: ReplayEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as ReplayEntry);
		} catch {
			// malformed line: skip — a damaged line never sinks the report
		}
	}
	if (entries.length === 0) throw new ReplayError(`session file "${path}" is empty (or every line is malformed)`);
	const header = entries.find((entry) => entry.type === "session");
	const sessionId = str(header?.id);
	if (header === undefined || sessionId === undefined) {
		throw new ReplayError(`session file "${path}" has no session header ({"type":"session","id":…}) — not a pi session file`);
	}
	return { path, sessionId, entries: entries.filter((entry) => entry !== header) };
}

/**
 * Resolve a session id to a file by scanning a session directory's
 * file HEADERS (the header id is authoritative — file names are not).
 * Zero matches, ambiguous matches, and an unreadable directory are
 * distinct, actionable errors.
 */
export function resolveSessionId(sessionDir: string, sessionId: string): string {
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch (error) {
		throw new ReplayError(`cannot read session directory "${sessionDir}" (${String(error)})`);
	}
	const matches: string[] = [];
	for (const file of files) {
		const path = join(sessionDir, file);
		try {
			const first = readFileSync(path, "utf8").split("\n").find((line) => line.trim() !== "");
			if (first === undefined) continue;
			const header = JSON.parse(first) as ReplayEntry;
			if (header.type === "session" && header.id === sessionId) matches.push(path);
		} catch {
			// unreadable or malformed file during the scan: skip it — other files may match
		}
	}
	if (matches.length === 0) {
		throw new ReplayError(`no session with id ${sessionId} under ${sessionDir} (${files.length} session file(s) scanned by header)`);
	}
	if (matches.length > 1) {
		throw new ReplayError(`ambiguous session id ${sessionId}: matches ${matches.length} files (${matches.map((m) => join("..", m.split(/[\\/]/).pop() as string)).join(", ")}) — pass a file path instead`);
	}
	return matches[0];
}

// --- branch selection --------------------------------------------------------

/** The set of entry ids on the selected branch: from the leaf up the parentId chain. */
export function branchIds(file: SessionFile, branchEntryId?: string): Set<string> {
	const byId = new Map(file.entries.map((entry) => [str(entry.id) ?? "", entry] as const));
	let leaf: ReplayEntry | undefined;
	if (branchEntryId !== undefined) {
		leaf = byId.get(branchEntryId);
		if (leaf === undefined) throw new ReplayError(`--branch entry "${branchEntryId}" not found in ${file.path}`);
	} else {
		// the active branch: the file's last entry that HAS an id (an id-less trailing
		// entry cannot anchor a branch — defensive against damaged files)
		for (let i = file.entries.length - 1; i >= 0; i--) {
			if (str(file.entries[i].id) !== undefined) {
				leaf = file.entries[i];
				break;
			}
		}
	}
	const ids = new Set<string>();
	let current: ReplayEntry | undefined = leaf;
	while (current !== undefined) {
		const id = str(current.id);
		if (id === undefined || ids.has(id)) break; // defensive: id-less or cyclic entries end the walk
		ids.add(id);
		current = byId.get(str(current.parentId) ?? "");
	}
	return ids;
}

// --- the replay engine -------------------------------------------------------

/** Replay a loaded session file into telemetry items (the same builders as live capture). */
export function replayEntries(file: SessionFile, opts: ReplayOptions = {}): TelemetryItem[] {
	const patterns = opts.redactions ?? DEFAULT_REDACTIONS;
	const items: TelemetryItem[] = [];
	const metric = (point: MetricData): void => {
		items.push({ kind: "metric", metric: point });
	};

	/** Add a root event with only-defined attributes (entries are external data). */
	const eventOn = (name: string, attrs: Record<string, AttrValue | undefined>, nowMs: number): void => {
		const clean: Record<string, AttrValue> = {};
		for (const [key, value] of Object.entries(attrs)) if (value !== undefined) clean[key] = value;
		addEvent(root, name, clean, nowMs);
	};

	const branch = branchIds(file, opts.branchEntryId);
	const firstTs = tsOf(file.entries[0] ?? {}, Date.parse("2024-01-01T00:00:00.000Z"));
	let clock = firstTs;

	const root = startSessionSpan(
		{ "pi.session.id": file.sessionId, "pi.session.file": file.path },
		{ traceId: deriveTraceId(file.sessionId), spanId: deriveSpanId(file.sessionId, "root"), nowMs: firstTs },
	);

	for (const entry of file.entries) {
		const id = str(entry.id);
		if (id === undefined || !branch.has(id)) continue; // abandoned-branch entries are excluded
		clock = tsOf(entry, clock);
		const type = str(entry.type);

		if (type === "message") {
			const message = entry.message;
			if (typeof message !== "object" || message === null) continue;
			const role = (message as { role?: unknown }).role;
			if (role === "user") {
				const text = textOf((message as { content?: unknown }).content);
				const attrs: Record<string, AttrValue> = { "pi.content.length": text.length, "pi.content.hash": hash12(text) };
				if (opts.capturePrompts === true) attrs["pi.content.text"] = redact(text, patterns); // R2 parity on entry bodies
				eventOn("pi.user.input", attrs, clock);
			} else if (role === "assistant") {
				const payload = message as { provider?: unknown; model?: unknown; usage?: unknown; stopReason?: unknown };
				const span = startModelSpan(root, genaiAttributes(payload), { spanId: deriveSpanId(file.sessionId, id), nowMs: clock });
				endSpan(span, { nowMs: clock }); // entry timestamps are the span timestamps; duration is live-only
				items.push({ kind: "span", span });
				metric(counter("pi.model.requests", 1, undefined, clock));
				for (const tokenCounter of tokenCounters(payload.usage, clock)) metric(tokenCounter);
			} else if (role === "toolResult") {
				const payload = message as { toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown };
				const toolName = str(payload.toolName) ?? "unknown";
				const span = startToolSpan(root, toolName, undefined, { spanId: deriveSpanId(file.sessionId, id), nowMs: clock });
				if (payload.isError === true) span.attributes["pi.tool.is_error"] = true;
				if (opts.captureToolIo === true) {
					const body = textOf(payload.content);
					if (body !== "") span.attributes["pi.tool.result"] = redact(body, patterns); // R2 parity
				}
				endSpan(span, { code: payload.isError === true ? "error" : undefined, nowMs: clock });
				items.push({ kind: "span", span });
				metric(counter("pi.tool.calls", 1, { "pi.tool.name": toolName }, clock));
			}
			// role "system" and anything else: not agent activity — skipped
		} else if (type === "usage") {
			// model-attributed usage without an assistant message (e.g. cache warming)
			metric(counter("pi.model.requests", 1, undefined, clock));
			for (const tokenCounter of tokenCounters(entry.usage, clock)) metric(tokenCounter);
			eventOn("pi.model.cache_warming", { "pi.decision": str(entry.kind) ?? "usage" }, clock);
		} else if (type === "compaction") {
			const attrs: Record<string, AttrValue> = {};
			const tokensBefore = (entry as { tokensBefore?: unknown }).tokensBefore;
			if (typeof tokensBefore === "number" && Number.isFinite(tokensBefore)) attrs["pi.tokens.before"] = tokensBefore;
			eventOn("pi.session.compact", attrs, clock);
			for (const tokenCounter of tokenCounters(entry.usage, clock)) metric(tokenCounter);
		} else if (type === "model_change") {
			eventOn("pi.session.model_change", { "pi.provider": str(entry.provider), "pi.model.id": str(entry.modelId) }, clock);
		} else if (type === "thinking_level_change") {
			eventOn("pi.session.thinking_level_change", { "pi.level": str(entry.thinkingLevel) }, clock);
		} else if (type === "tree") {
			eventOn("pi.session.tree", { "pi.target": str(entry.targetId) ?? id }, clock);
		}
		// unknown entry types: skipped (forward-compatible, add-only)
	}

	endSpan(root, { nowMs: clock });
	items.push({ kind: "span", span: root });
	return items;
}

// --- the report ---------------------------------------------------------------

/** Where the report comes from: a file path (verbatim) or a session id under a directory. */
export type ReplaySource = { path: string } | { sessionDir: string; sessionId: string };

/** A finished report: the items, their resource, and the OTLP/JSON encoding. */
export interface ReplayReport {
	file: SessionFile;
	items: TelemetryItem[];
	/** The resource every line carries (pi.replay marking) — reuse it for --file/--otlp sinks. */
	resource: Record<string, AttrValue>;
	/** OTLP/JSON export-request bodies, one per line — pipes into otelcol or jq. */
	lines: string[];
}

/** Replay one session (path or id) into a full report. */
export function replayReport(source: ReplaySource, opts: ReplayOptions = {}): ReplayReport {
	const file = "path" in source ? loadSessionFile(source.path) : loadSessionFile(resolveSessionId(source.sessionDir, source.sessionId));
	const items = replayEntries(file, opts);
	const resource: Record<string, AttrValue> = {
		"service.name": opts.resourceService ?? "pi-agent",
		"service.version": PI_OBS_VERSION,
		"pi.version": PI_OBS_VERSION,
		"pi.replayed": true,
		"pi.replay.source": "path" in source ? source.path : source.sessionId,
	};
	const lines: string[] = [];
	for (const item of items) {
		const line = exportRequestLine(item, resource, opts.redactions ?? DEFAULT_REDACTIONS);
		if (line !== null) lines.push(line);
	}
	return { file, items, resource, lines };
}