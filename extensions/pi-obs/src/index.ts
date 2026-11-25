/**
 * pi-obs — pi coding agent extension entry (DEV_PLAN Step 6).
 *
 * The only file pi loads. Two features, one entry:
 *
 *   1. The RETAINED stats feature (R7): a footer status line
 *      (tokens · cost, live-updated per turn) and the `/pi-obs`
 *      command (report of the current session's active branch,
 *      `/pi-obs json`, `/pi-obs all`) — these work regardless of
 *      telemetry configuration.
 *
 *   2. The R3 live capture: when telemetry is ACTIVE (R6 master rule
 *      — an exporter is configured), subscriptions for exactly the
 *      A ∪ B hooks of the usage inventory (hooks.ts, 38 of 41; the 3
 *      category-D hooks are deliberately absent). Every handler is
 *      wrapped in R1 fault isolation: a throw is caught, reported
 *      once on stderr, becomes an OTel log record, and disables that
 *      hook's emission — pi NEVER sees an exception. All 12
 *      category-C handlers are inert (return undefined — observe
 *      only). Synchronous work per hook is attribute assembly +
 *      enqueue (the ≤ 1 ms R1 budget; everything else is the queue's
 *      asynchronous drain). R2 at capture time: header NAMES only;
 *      content length + SHA-256-12 hash by default; verbatim text
 *      only under the opt-ins, REDACTED before it ever reaches the
 *      queue. `session_shutdown` closes the root span and flushes
 *      (bounded) — normal exit never silently loses telemetry.
 *      `pi.appendEntry` is never called: observation only.
 *
 * pi types are `import type` only (erased at runtime) — the module
 * runs under the mock harness (tests/harness.ts) without the pi
 * package installed, and inside pi via jiti in production.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, readSettingsPiObsBlock, type ConfigResult } from "./config.ts";
import { SUBSCRIBED_HOOKS } from "./hooks.ts";
import {
	addEvent,
	counter,
	endSpan,
	genaiAttributes,
	histogram,
	logRecord,
	startModelSpan,
	startRunSpan,
	startSessionSpan,
	startToolSpan,
	startTurnSpan,
	tokenCounters,
	type AttrValue,
	type MetricData,
	type SpanData,
} from "./model.ts";
import { TelemetryQueue, type Exporter, type TelemetryItem } from "./queue.ts";
import { replayReport } from "./replay.ts";
import { FileExporter } from "./exporters/file.ts";
import { OtlpExporter } from "./exporters/otlp.ts";
import { redact } from "./exporters/otlp-json.ts";
import { PI_OBS_VERSION } from "./semconv.ts";
import { computeStats, formatCost, formatTokens, reportSession, type EntryLike } from "./stats.ts";

/** Bounded flush at shutdown (R5: shutdown is never hung by a dead backend). */
export const FLUSH_TIMEOUT_MS = 5000;

const STATUS_KEY = "pi-obs";

/**
 * pi's `on()` overloads are per-event (specific event payloads and ctx);
 * pi-obs handlers are uniformly loose (events are external data, read
 * defensively). This adapter is the single typed escape at the boundary.
 */
type LoosePi = { on(hook: string, handler: (event: never, ctx: never) => unknown): void };
const onAny = (pi: ExtensionAPI, hook: string, handler: (event: unknown, ctx: CtxLike) => unknown): void => {
	(pi as unknown as LoosePi).on(hook, handler as (event: never, ctx: never) => unknown);
};

// --- loose shapes: pi payloads are EXTERNAL data, read defensively (R1) ----

/** The fields of pi's ExtensionContext pi-obs reads. */
interface CtxLike {
	mode?: string;
	hasUI?: boolean;
	cwd?: string;
	sessionManager?: {
		getBranch?(): unknown[];
		getSessionDir?(): string | undefined;
		getSessionFile?(): string | null | undefined;
		getSessionId?(): string | null | undefined;
	};
	ui?: {
		setStatus?(key: string, value: string): void;
		notify?(text: string, level: string): void;
	};
	model?: { provider?: string; id?: string };
}

/** A usable string, or undefined. */
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
/** A usable finite number, or undefined. */
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/** SHA-256 of the text, first 12 hex chars (R2 default in place of text). */
const hash12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** Resolve telemetry configuration; report (never throw on) invalid values. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const result = loadConfig(env, readSettingsPiObsBlock());
	for (const error of result.errors) console.error(`pi-obs config: ${error}`);
	return result;
}

// ---------------------------------------------------------------------------
// The retained stats feature (R7) — works regardless of telemetry config.
// ---------------------------------------------------------------------------

/** Emit command output: notify with UI, plain stdout without (print/JSON modes). */
const emit = (ctx: CtxLike, text: string) => {
	if (ctx.hasUI === true && ctx.ui?.notify !== undefined) ctx.ui.notify(text, "info");
	else console.log(text);
};

/** Parse one session JSONL file into entries; unreadable lines are skipped. */
const readSessionEntries = (path: string): EntryLike[] => {
	const entries: EntryLike[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as EntryLike);
		} catch {
			// malformed line: skip — observation must never fail the session
		}
	}
	return entries;
};

/** Register the footer status line hooks (R7, retained). The command lives in registerPiObsCommand. */
function registerStatsFeature(pi: ExtensionAPI): void {
	const updateStatus = (ctx: CtxLike) => {
		if (ctx.hasUI !== true || ctx.ui?.setStatus === undefined) return;
		const stats = computeStats((ctx.sessionManager?.getBranch?.() ?? []) as EntryLike[]);
		ctx.ui.setStatus(
			STATUS_KEY,
			stats.usage.totalTokens > 0 ? `${formatTokens(stats.usage.totalTokens)} tok · ${formatCost(stats.cost)}` : "",
		);
	};

	onAny(pi, "session_start", (_event: unknown, ctx: CtxLike) => updateStatus(ctx));
	onAny(pi, "session_tree", (_event: unknown, ctx: CtxLike) => updateStatus(ctx));
	onAny(pi, "turn_end", (_event: unknown, ctx: CtxLike) => updateStatus(ctx));
	onAny(pi, "agent_settled", (_event: unknown, ctx: CtxLike) => updateStatus(ctx));

}

/** Wiring state the command surface reads (null when telemetry is inactive). */
interface TelemetryState {
	readonly queue: TelemetryQueue;
	readonly exporters: Exporter[];
	readonly capturePrompts: boolean;
	readonly captureToolIo: boolean;
	readonly otlpEndpoint: string | null;
	readonly fileMaxBytes: number | null;
	readonly fileMaxFiles: number | null;
}

/** Register the /pi-obs command: retained stats subs + status/flush/report (R7). */
function registerPiObsCommand(pi: ExtensionAPI, telemetry: TelemetryState | null): void {
	pi.registerCommand("pi-obs", {
		description: "Session observability: tokens, cost, models, telemetry (usage: /pi-obs [help|json|all|status|flush|report <id|path> [--otlp] [--file=<path>] [--branch=<id>]])",
		// the same loose-context boundary as onAny: pi's ExtensionCommandContext
		// is a superset our handler reads defensively
		handler: (async (args: string, ctx: CtxLike) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";

			if (sub === "help") {
				helpView(ctx);
				return;
			}
			if (sub === "status") {
				statusView(ctx, telemetry);
				return;
			}
			if (sub === "flush") {
				await flushView(ctx, telemetry);
				return;
			}
			if (sub === "report") {
				await reportView(args.trim().split(/\s+/).slice(1), ctx, telemetry);
				return;
			}
			if (sub === "all") {
				const dir = ctx.sessionManager?.getSessionDir?.();
				let files: string[] = [];
				try {
					files = dir !== undefined ? readdirSync(dir).filter((file) => file.endsWith(".jsonl")) : [];
				} catch {
					emit(ctx, "pi-obs: no session directory (no sessions yet)");
					return;
				}

				const summaries = files
					.map((file) => {
						const path = join(dir ?? ".", file);
						let entries: EntryLike[] = [];
						let modifiedMs = 0;
						try {
							entries = readSessionEntries(path);
							modifiedMs = statSync(path).mtimeMs;
						} catch {
							return null; // unreadable file: skip entirely
						}
						return { file, modifiedMs, stats: computeStats(entries) };
					})
					.filter((s): s is NonNullable<typeof s> => s !== null)
					.sort((a, b) => b.modifiedMs - a.modifiedMs);

				if (summaries.length === 0) {
					emit(ctx, "pi-obs: no sessions found");
					return;
				}

				let totalTokens = 0;
				let totalCost = 0;
				for (const { stats } of summaries) {
					totalTokens += stats.usage.totalTokens;
					totalCost += stats.cost;
				}

				const lines = [
					`pi-obs · ${summaries.length} session${summaries.length === 1 ? "" : "s"} · total ${formatTokens(totalTokens)} tok · ${formatCost(totalCost)}`,
					"",
					...summaries.slice(0, 15).map(({ file, modifiedMs, stats }) => {
						const when = new Date(modifiedMs).toISOString().replace("T", " ").slice(0, 16);
						return `${when} · ${formatTokens(stats.usage.totalTokens)} tok · ${formatCost(stats.cost)} · ${file}`;
					}),
				];
				if (summaries.length > 15) lines.push(`… and ${summaries.length - 15} more`);
				emit(ctx, lines.join("\n"));
				return;
			}

			const stats = computeStats((ctx.sessionManager?.getBranch?.() ?? []) as EntryLike[]);
			if (sub === "json") {
				emit(ctx, JSON.stringify(stats, null, 2));
				return;
			}
			emit(ctx, ["pi-obs · session", ...reportSession(stats)].join("\n"));
		}) as never, // loose-context boundary, like onAny above
	});
}

/** `help` — the in-session usage surface: every subcommand, one line each (R7). */
function helpView(ctx: CtxLike): void {
	emit(ctx, [
		"pi-obs · commands",
		"  /pi-obs                                  session stats: tokens, cost, duration, models, tools",
		"  /pi-obs json                             the same session stats as JSON",
		"  /pi-obs all                              all sessions in the session dir (15 most recent)",
		"  /pi-obs status                           telemetry health: exporters, queue, counters, last errors",
		"  /pi-obs flush                            drain the telemetry queue now (bounded)",
		"  /pi-obs report <id|path> [session-dir]   post-mortem replay → OTLP/JSON (R3b)",
		"      [--otlp] [--file=<path>] [--branch=<entry-id>]",
		"  /pi-obs help                             this list",
		"  env: PI_OBS_OTLP_ENDPOINT (OTLP/HTTP) · PI_OBS_FILE=1 + PI_OBS_FILE_PATH (file export)",
		"  standalone CLI: piobs --help (post-mortem report outside pi, real exit codes)",
	].join("\n"));
}

/** `status` — exporter activity, queue depth, counters, last export times and errors (R7). */
function statusView(ctx: CtxLike, telemetry: TelemetryState | null): void {
	if (telemetry === null) {
		emit(ctx, "pi-obs telemetry: inactive (no exporter configured — set PI_OBS_OTLP_ENDPOINT or PI_OBS_FILE=1; the stats commands work regardless)");
		return;
	}
	const at = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toISOString());
	const lines = [`pi-obs telemetry: active (${telemetry.exporters.length} exporter(s))`];
	for (const exporter of telemetry.exporters) {
		if (exporter instanceof FileExporter) {
			const c = exporter.counters;
			lines.push(`  file: ${exporter.targetPath} — written ${c.written} · dropped ${c.dropped} · last export ${at(c.lastExportAt)} · last error ${c.lastError ?? "—"}`);
		} else if (exporter instanceof OtlpExporter) {
			const c = exporter.counters;
			lines.push(`  otlp: ${exporter.endpointUrl} — exported ${c.exported} · dropped ${c.dropped} · requests ${c.requests} · retries ${c.retries} · last export ${at(c.lastExportAt)} · last error ${c.lastError ?? "—"}`);
		}
	}
	const q = telemetry.queue.counters;
	lines.push(`  queue: depth ${telemetry.queue.pending} · enqueued ${q.enqueued} · drained ${q.drained} · dropped ${q.dropped}`);
	emit(ctx, lines.join("\n"));
}

/** `flush` — bounded forced drain; reports what was flushed (R7). */
async function flushView(ctx: CtxLike, telemetry: TelemetryState | null): Promise<void> {
	if (telemetry === null) {
		emit(ctx, "pi-obs flush: no telemetry queue (telemetry inactive)");
		return;
	}
	const before = telemetry.queue.pending;
	const drained = await telemetry.queue.flush(FLUSH_TIMEOUT_MS);
	if (drained) {
		emit(ctx, `pi-obs flush: queue drained (${before} pending item(s) → ${telemetry.queue.pending})`);
	} else {
		emit(ctx, `pi-obs flush: timed out after ${FLUSH_TIMEOUT_MS}ms (${telemetry.queue.pending} still pending — a dead backend only ever costs telemetry)`);
	}
}

/** `report <session-id | path> [dir] [--otlp] [--file=<path>] [--branch=<entry-id>]` — the R3b post-mortem (R7). */
async function reportView(tokens: string[], ctx: CtxLike, telemetry: TelemetryState | null): Promise<void> {
	const usage = "usage: /pi-obs report <session-id | path> [session-dir] [--otlp] [--file=<path>] [--branch=<entry-id>]";
	let target: string | undefined;
	let sessionDirArg: string | undefined;
	let otlp = false;
	let filePath: string | undefined;
	let branch: string | undefined;
	for (const token of tokens) {
		if (token === "") continue;
		if (token === "--otlp") otlp = true;
		else if (token.startsWith("--file=")) filePath = token.slice("--file=".length);
		else if (token.startsWith("--branch=")) branch = token.slice("--branch=".length);
		else if (token.startsWith("--")) {
			emit(ctx, `pi-obs report: unknown flag "${token}" — ${usage}`);
			return;
		} else if (target === undefined) target = token;
		else if (sessionDirArg === undefined) sessionDirArg = token;
		else {
			emit(ctx, `pi-obs report: unexpected argument "${token}" — ${usage}`);
			return;
		}
	}
	if (target === undefined) {
		emit(ctx, `pi-obs report: missing <session-id | path> — ${usage}`);
		return;
	}
	const isPath = target.includes("/") || target.endsWith(".jsonl");
	if (sessionDirArg !== undefined && isPath) {
		emit(ctx, `pi-obs report: unexpected argument "${sessionDirArg}" (a [session-dir] may only follow a session ID) — ${usage}`);
		return;
	}
	try {
		const report = replayReport(
			isPath ? { path: target } : { sessionDir: sessionDirArg ?? ctx.sessionManager?.getSessionDir?.() ?? "", sessionId: target },
			{
				branchEntryId: branch,
				capturePrompts: telemetry?.capturePrompts ?? false,
				captureToolIo: telemetry?.captureToolIo ?? false,
			},
		);
		emit(ctx, report.lines.join("\n")); // stdout is always emitted; flags add sinks
		if (otlp) {
			if (telemetry?.otlpEndpoint == null) {
				emit(ctx, "pi-obs report: no OTLP endpoint configured (set PI_OBS_OTLP_ENDPOINT or the otlpEndpoint setting)");
			} else {
				const exporter = new OtlpExporter({ endpoint: telemetry.otlpEndpoint, resource: report.resource });
				await exporter.export(report.items);
				emit(ctx, `pi-obs report: posted ${report.items.length} record(s) to ${telemetry.otlpEndpoint}`);
			}
		}
		if (filePath !== undefined) {
			const exporter = new FileExporter({
				path: filePath,
				maxBytes: telemetry?.fileMaxBytes ?? 10485760,
				maxFiles: telemetry?.fileMaxFiles ?? 5,
				resource: report.resource,
			});
			await exporter.export(report.items);
			emit(ctx, `pi-obs report: wrote ${report.lines.length} line(s) to ${filePath}`);
		}
	} catch (error) {
		emit(ctx, error instanceof Error ? error.message : String(error)); // distinct, actionable (ReplayError / R2 session-dir rule)
	}
}

// ---------------------------------------------------------------------------
// The live capture (R3): one handler per subscribed hook, all inert.
// ---------------------------------------------------------------------------

/** Per-session capture state (spans are enqueued when they CLOSE — finished telemetry). */
class LiveCapture {
	session: SpanData | null = null;
	run: SpanData | null = null;
	turn: SpanData | null = null;
	model: SpanData | null = null;
	#modelStartMs = 0;
	#firstDelta = false;
	#pendingHeaderNames: string | null = null;
	#tools = new Map<string, SpanData>();
	#promptStarts = new Map<string, number>();

	private readonly capturePrompts: boolean;
	private readonly captureToolIo: boolean;
	private readonly enqueue: (item: TelemetryItem) => void;
	private readonly flush: () => Promise<unknown>;

	constructor(capturePrompts: boolean, captureToolIo: boolean, enqueue: (item: TelemetryItem) => void, flush: () => Promise<unknown>) {
		this.capturePrompts = capturePrompts;
		this.captureToolIo = captureToolIo;
		this.enqueue = enqueue;
		this.flush = flush;
	}

	/** The handler for one subscribed hook (all return undefined — inert). */
	handlerFor(hook: string): (event: unknown, ctx: CtxLike) => unknown {
		switch (hook) {
			case "session_start":
				return (event, ctx) => this.onSessionStart(event, ctx);
			case "session_shutdown":
				return async (event, _ctx) => {
					if (this.session !== null) {
						endSpan(this.session);
						this.enqueue({ kind: "span", span: this.session });
						this.session = null;
					}
					await this.flush(); // R1: normal exit never silently loses telemetry
					return undefined;
				};
			case "session_info_changed":
				return () => this.rootEvent("pi.session.renamed", {});
			case "session_before_switch":
				return (event) => this.rootEvent("pi.session.switch", { "pi.reason": str((event as { reason?: unknown }).reason), "pi.target": str((event as { targetSessionFile?: unknown }).targetSessionFile) });
			case "session_before_fork":
				return (event) => this.rootEvent("pi.session.fork", { "pi.reason": str((event as { position?: unknown }).position), "pi.target": str((event as { entryId?: unknown }).entryId) });
			case "session_before_compact":
				return (event) => this.rootEvent("pi.session.compact", { "pi.reason": str((event as { reason?: unknown }).reason), "pi.tokens.before": num((event as { preparation?: { tokensBefore?: unknown } }).preparation?.tokensBefore) });
			case "session_compact":
				return (event) => this.rootEvent("pi.session.compact", { "pi.reason": str((event as { reason?: unknown }).reason), "pi.outcome": "ok" });
			case "session_compact_failed":
				return (event) => this.rootEvent("pi.session.compact", { "pi.reason": str((event as { reason?: unknown }).reason), "pi.outcome": "failed" });
			case "session_before_tree":
				return (event) => this.rootEvent("pi.session.tree", { "pi.target": str((event as { preparation?: { targetId?: unknown } }).preparation?.targetId) });
			case "session_tree":
				return (event) => this.rootEvent("pi.session.tree", { "pi.target": str((event as { newLeafId?: unknown }).newLeafId), "pi.summary": (event as { summaryEntry?: unknown }).summaryEntry != null });
			case "project_trust":
			case "resources_discover":
				return (event) =>
					this.rootEvent("pi.resources", {
						"pi.reason": str((event as { reason?: unknown }).reason) ?? (hook === "project_trust" ? "trust" : "startup"),
						"pi.cwd": str((event as { cwd?: unknown }).cwd),
					});
			case "input":
				return (event) => {
					const text = str((event as { text?: unknown }).text) ?? "";
					const attrs: Record<string, AttrValue> = {
						"pi.source": str((event as { source?: unknown }).source) ?? "unknown",
						"pi.streaming": (event as { streamingBehavior?: unknown }).streamingBehavior !== undefined,
						"pi.content.length": text.length,
						"pi.content.hash": hash12(text),
					};
					if (this.capturePrompts) attrs["pi.content.text"] = redact(text); // R2: opt-in AND redacted before the queue
					return this.rootEvent("pi.user.input", attrs);
				};
			case "user_bash":
				return (event) => this.rootEvent("pi.user.bash", { "pi.tool.command": str((event as { command?: unknown }).command) });
			case "ui_prompt_start":
				return (event) => {
					const kind = str((event as { kind?: unknown }).kind) ?? "custom";
					this.#promptStarts.set(kind, Date.now());
					return this.rootEvent("pi.ui.prompt", { "pi.kind": kind });
				};
			case "ui_prompt_end":
				return (event) => {
					const kind = str((event as { kind?: unknown }).kind) ?? "custom";
					const started = this.#promptStarts.get(kind);
					this.#promptStarts.delete(kind);
					const attrs: Record<string, AttrValue> = { "pi.kind": kind };
					if (started !== undefined) attrs["pi.duration.ms"] = Date.now() - started;
					return this.rootEvent("pi.ui.prompt", attrs);
				};
			case "before_agent_start":
				return () => {
					if (this.session === null) return undefined;
					this.closeRun();
					this.run = startRunSpan(this.session);
					return undefined;
				};
			case "agent_start":
			case "agent_end":
			case "agent_before_settle":
				return () => undefined; // the run span IS the entity; lifecycle detail is below
			case "agent_settled":
				return (event) => {
					if ((event as { aborted?: unknown }).aborted === true && this.run !== null) {
						addEvent(this.run, "pi.run.aborted", { "pi.aborted": true });
					}
					this.closeRun();
					return undefined;
				};
			case "turn_start":
				return (event) => {
					if (this.run === null) return undefined;
					this.closeTurn();
					this.turn = startTurnSpan(this.run, num((event as { turnIndex?: unknown }).turnIndex) ?? 0);
					return undefined;
				};
			case "turn_end":
				return () => {
					this.closeTurn();
					return undefined;
				};
			case "before_provider_headers":
				return (event) => {
					const headers = (event as { headers?: Record<string, unknown> }).headers;
					this.#pendingHeaderNames = headers !== undefined && headers !== null ? Object.keys(headers).join(",") : ""; // R2: NAMES only
					return undefined;
				};
			case "before_provider_request":
				return (_event, ctx) => {
					if (this.turn === null) return undefined;
					this.closeModel();
					this.model = startModelSpan(this.turn, genaiAttributes({ provider: ctx?.model?.provider, model: ctx?.model?.id }));
					this.#modelStartMs = Date.now();
					this.#firstDelta = false;
					if (this.#pendingHeaderNames !== null) {
						addEvent(this.model, "pi.model.headers", { "pi.header.names": this.#pendingHeaderNames });
						this.#pendingHeaderNames = null;
					}
					return undefined;
				};
			case "after_provider_response":
				return (event) => {
					if (this.model !== null) {
						addEvent(this.model, "pi.model.response_status", { "pi.status": String((event as { status?: unknown }).status) });
					}
					return undefined;
				};
			case "message_update":
				return () => {
					this.metric(counter("pi.messages", 1, { "pi.role": "assistant" }));
					if (this.model !== null && !this.#firstDelta) {
						this.#firstDelta = true;
						this.metric(histogram("pi.model.time_to_first_token", Date.now() - this.#modelStartMs));
					}
					return undefined;
				};
			case "message_end":
				return (event) => {
					const message = (event as { message?: unknown }).message as Record<string, unknown> | undefined;
					if (message === undefined || message.role !== "assistant") return undefined;
					if (this.model !== null) {
						const model = this.model;
						for (const [key, value] of Object.entries(genaiAttributes({ provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason }))) {
							model.attributes[key] = value;
						}
						endSpan(model);
						this.enqueue({ kind: "span", span: model });
						this.model = null;
					}
					this.metric(counter("pi.model.requests", 1));
					for (const tokenCounter of tokenCounters(message.usage)) this.metric(tokenCounter);
					this.metric(histogram("pi.model.duration", Date.now() - this.#modelStartMs));
					return undefined;
				};
			case "model_select":
				return (event) => {
					const model = (event as { model?: { provider?: unknown; id?: unknown } }).model;
					return this.rootEvent("pi.session.model_change", { "pi.provider": str(model?.provider), "pi.model.id": str(model?.id) });
				};
			case "thinking_level_select":
				return (event) => this.rootEvent("pi.session.thinking_level_change", { "pi.level": str((event as { level?: unknown }).level) });
			case "cache_warming_decision":
				return (event) => this.rootEvent("pi.model.cache_warming", { "pi.decision": str((event as { action?: unknown }).action) });
			case "context":
			case "context_with_system":
				return (event) => {
					const messages = (event as { messages?: unknown[] }).messages;
					const count = Array.isArray(messages) ? messages.length : 0;
					return this.rootEvent("pi.context", { "pi.messages.in": count, "pi.messages.out": count }); // inert: out == in
				};
			case "tool_execution_start":
				return (event) => {
					const toolName = str((event as { toolName?: unknown }).toolName) ?? "unknown";
					this.metric(counter("pi.tool.calls", 1, { "pi.tool.name": toolName }));
					if (this.turn !== null) {
						this.#tools.set(str((event as { toolCallId?: unknown }).toolCallId) ?? "", startToolSpan(this.turn, toolName));
					}
					return undefined;
				};
			case "tool_call":
				return (event) => {
					const tool = this.#tools.get(str((event as { toolCallId?: unknown }).toolCallId) ?? "");
					if (tool === undefined) return undefined;
					const input = (event as { input?: Record<string, unknown> }).input;
					const attrs: Record<string, AttrValue> = { "pi.outcome": "allowed" }; // inert: we never block or mutate
					const path = str(input?.path);
					if (path !== undefined) attrs["pi.tool.path"] = path; // R2: paths are the work being observed
					const command = str(input?.command);
					if (command !== undefined) attrs["pi.tool.command"] = command;
					addEvent(tool, "pi.tool.outcome", attrs);
					return undefined;
				};
			case "tool_result":
				return (event) => {
					const tool = this.#tools.get(str((event as { toolCallId?: unknown }).toolCallId) ?? "");
					if (tool === undefined) return undefined;
					if ((event as { isError?: unknown }).isError === true) tool.attributes["pi.tool.is_error"] = true;
					if (this.captureToolIo) {
						const content = (event as { content?: unknown }).content;
						if (typeof content === "string") tool.attributes["pi.tool.result"] = redact(content); // R2: opt-in AND redacted before the queue
					}
					return undefined;
				};
			case "tool_execution_end":
				return (event) => {
					const toolCallId = str((event as { toolCallId?: unknown }).toolCallId) ?? "";
					const tool = this.#tools.get(toolCallId);
					if (tool !== undefined) {
						const isError = (event as { isError?: unknown }).isError === true;
						endSpan(tool, isError ? { code: "error" } : undefined);
						this.enqueue({ kind: "span", span: tool });
						this.#tools.delete(toolCallId);
					}
					const toolName = str((event as { toolName?: unknown }).toolName);
					const durationMs = num((event as { durationMs?: unknown }).durationMs);
					if (toolName !== undefined && durationMs !== undefined) {
						this.metric(histogram("pi.tool.duration", durationMs, { "pi.tool.name": toolName }));
					}
					return undefined;
				};
			case "tool_execution_update":
				return (event) => {
					const toolName = str((event as { toolName?: unknown }).toolName) ?? "unknown";
					this.metric(counter("pi.tool.updates", 1, { "pi.tool.name": toolName }));
					return undefined;
				};
			default:
				return () => undefined; // unreachable: SUBSCRIBED_HOOKS covers the switch exactly
		}
	}

	/** Enqueue one metric point (wrapped as a queue item). */
	private metric(point: MetricData): void {
		this.enqueue({ kind: "metric", metric: point });
	}

	/** Add an event to the root span (dropped when no session is open — defensive). */
	private rootEvent(name: string, attrs: Record<string, AttrValue | undefined>): undefined {
		if (this.session === null) return undefined;
		const clean: Record<string, AttrValue> = {};
		for (const [key, value] of Object.entries(attrs)) if (value !== undefined) clean[key] = value;
		addEvent(this.session, name, clean);
		return undefined;
	}

	private onSessionStart(event: unknown, ctx: CtxLike): undefined {
		if (this.session !== null) {
			endSpan(this.session); // stale (defensive): close and flush before minting a new trace
			this.enqueue({ kind: "span", span: this.session });
			this.session = null;
		}
		const attrs: Record<string, AttrValue> = { "pi.session.reason": str((event as { reason?: unknown }).reason) ?? "unknown", "pi.cwd": ctx.cwd ?? "" };
		const sessionId = str(ctx.sessionManager?.getSessionId?.());
		if (sessionId !== undefined) attrs["pi.session.id"] = sessionId;
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		if (sessionFile !== undefined && sessionFile !== null) attrs["pi.session.file"] = sessionFile;
		this.session = startSessionSpan(attrs);
		return undefined;
	}

	/** Close the run span — cascades: an open turn (and its model) never dangles. */
	private closeRun(): void {
		this.closeTurn();
		if (this.run !== null) {
			endSpan(this.run);
			this.enqueue({ kind: "span", span: this.run });
			this.run = null;
		}
	}

	/** Close the turn span — cascades: an open model span never dangles. */
	private closeTurn(): void {
		this.closeModel();
		if (this.turn !== null) {
			endSpan(this.turn);
			this.enqueue({ kind: "span", span: this.turn });
			this.turn = null;
		}
	}

	private closeModel(): void {
		if (this.model !== null) {
			endSpan(this.model);
			this.enqueue({ kind: "span", span: this.model });
			this.model = null;
		}
	}
}

/** Wire the live capture onto pi: queue + exporters + the 38 wrapped subscriptions. */
function wireTelemetry(pi: ExtensionAPI, result: ConfigResult): TelemetryState {
	const { config } = result;
	const resource: Record<string, AttrValue> = {
		"service.name": config.resourceService,
		"service.version": config.version,
		"pi.version": PI_OBS_VERSION,
		"pi.cwd": process.cwd(),
	};
	const report = (error: unknown) => console.error(`pi-obs exporter: ${String(error)}`);
	// R4: exporter faults are OTel log records too, never stderr-only. One record per
	// exporter per session (mirrors R1's report-once pattern) so a dead backend cannot
	// self-sustain the drain with its own fault records.
	const faultedExporters = new Set<string>();
	const exporterFault = (name: string) => (error: unknown) => {
		report(`${name}: ${String(error)}`);
		if (faultedExporters.has(name)) return;
		faultedExporters.add(name);
		try {
			queue.enqueue({ kind: "log", log: logRecord("ERROR", `exporter ${name} failed: ${String(error instanceof Error ? error.message : error)}`, { "pi.exporter.name": name }) });
		} catch {
			// the fault path must never fault (R1)
		}
	};
	const exporters: Exporter[] = [];
	if (config.otlp !== null) {
		exporters.push(new OtlpExporter({ endpoint: config.otlp.endpoint, headers: config.otlp.headers, timeoutMs: config.otlp.timeoutMs, batch: config.otlp.batch, resource, onError: exporterFault("otlp") }));
	}
	if (config.file !== null) {
		exporters.push(new FileExporter({ path: config.file.path, maxBytes: config.file.maxBytes, maxFiles: config.file.maxFiles, resource, onError: exporterFault("file") }));
	}
	// R4: drop notices and exporter faults are OTel log records, never stderr-only.
	// The drop notice itself enqueues — a re-entrancy guard keeps an overflow
	// from recursively notifying (the notice may itself be dropped; that is
	// counted but not re-notified).
	let notifyingDrop = false;
	const queue = new TelemetryQueue({
		max: config.queueMax,
		exporters,
		onDrop: (dropped) => {
			report(`dropped ${dropped} telemetry item(s) (queue overflow or closed)`);
			if (!notifyingDrop) {
				notifyingDrop = true;
				try {
					queue.enqueue({ kind: "log", log: logRecord("WARN", `dropped ${dropped} telemetry item(s) (queue overflow or closed)`, { "pi.dropped.count": dropped }) });
				} catch {
					// the notice path must never fault (R1)
				} finally {
					notifyingDrop = false;
				}
			}
		},
		// no queue-level onExportError here: pi-obs exporters NEVER reject by
		// design (faults flow through their own onError -> exporterFault above);
		// the queue's hook remains part of its API for other consumers
	});

	const capture = new LiveCapture(
		config.capturePrompts,
		config.captureToolIo,
		(item) => queue.enqueue(item), // the ≤ 1 ms R1 path: assemble + enqueue, nothing else
		() => queue.shutdown(FLUSH_TIMEOUT_MS),
	);

	// R1 fault isolation: one stderr report + one OTel log record per faulted
	// hook, then that hook's emission is disabled for the session. pi never
	// sees an exception; every handler returns undefined (inert).
	const faulted = new Set<string>();
	for (const hook of SUBSCRIBED_HOOKS) {
		const handler = capture.handlerFor(hook);
		onAny(pi, hook, async (event: unknown, ctx: CtxLike) => {
			if (faulted.has(hook)) return undefined;
			try {
				return await handler(event, ctx);
			} catch (error) {
				faulted.add(hook);
				console.error(`pi-obs: ${hook} handler failed once — emission disabled for this session (${String(error instanceof Error ? error.message : error)})`);
				try {
					queue.enqueue({ kind: "log", log: logRecord("ERROR", `handler fault on ${hook}`, { "pi.hook": hook }) });
				} catch {
					// the fault path must never fault (R1)
				}
				return undefined;
			}
		});
	}
	return { queue, exporters, capturePrompts: config.capturePrompts, captureToolIo: config.captureToolIo, otlpEndpoint: config.otlp?.endpoint ?? null, fileMaxBytes: config.file?.maxBytes ?? null, fileMaxFiles: config.file?.maxFiles ?? null };
}

// ---------------------------------------------------------------------------

/** The extension entry pi loads. */
export default function piObs(pi: ExtensionAPI): void {
	const result = resolveConfig();
	const telemetry: TelemetryState | null = result.config.active ? wireTelemetry(pi, result) : null; // R6 master rule: inactive until an exporter is configured
	registerStatsFeature(pi); // the footer status hooks (R7, retained)
	registerPiObsCommand(pi, telemetry); // stats subs byte-identical + status/flush/report
}
