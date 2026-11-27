/**
 * pi-obs — OTLP/HTTP exporter (SPECS R5 backend leg, DEV_PLAN Step 5).
 *
 * POSTs finished telemetry as OTLP/JSON export-request bodies:
 *
 *   - one request per signal per chunk: items are grouped by kind and
 *     chunked at PI_OBS_OTLP_BATCH; each chunk is a single OTLP request
 *     (resourceSpans / resourceMetrics / resourceLogs merged);
 *   - the endpoint is per-signal derived: a bare `http://collector:4318`
 *     gains `/v1/traces|metrics|logs`; an endpoint already ending in a
 *     `/v1/<signal>` has that last segment rewritten per signal — one
 *     PI_OBS_OTLP_ENDPOINT configures all three;
 *   - `http://` endpoints are accepted (local collectors are the norm)
 *     and warned about ONCE per origin on stderr;
 *   - per-request timeout (AbortSignal); responses outside 2xx and
 *     network failures are retried on an exponential backoff up to a
 *     bounded attempt count, then the chunk is DROPPED AND COUNTED —
 *   - export() NEVER rejects: failures are reported through onError and
 *     the drop counter (a dead backend only ever costs telemetry, R1);
 *   - serialization is the shared exporters/otlp-json.ts path — the
 *     exact records the file exporter writes, no parallel formatting.
 *
 * Pure transport module: no pi imports. Timing knobs (attempts,
 * backoffMs, timeoutMs) are injectable so tests are fast and bounded.
 */

import type { AttrValue } from "../model.ts";
import type { Exporter, TelemetryItem } from "../queue.ts";
import { DEFAULT_REDACTIONS, exportRequestLine } from "./otlp-json.ts";

/** OTLP/HTTP exporter construction options. */
export interface OtlpExporterOptions {
	/** OTLP/HTTP endpoint base URL (per-signal paths derived, see module doc). */
	endpoint: string;
	/** OTel resource attributes embedded in every record. */
	resource: Record<string, AttrValue>;
	/** Extra request headers (PI_OBS_OTLP_HEADERS, k=v,k=v at the wiring). */
	headers?: Record<string, string>;
	/** Per-request timeout, ms (default 5000 — the R6 default). */
	timeoutMs?: number;
	/** Records per OTLP request (default 64 — the R6 default). */
	batch?: number;
	/** Total attempts per chunk before drop-and-count (default 3). */
	attempts?: number;
	/** Base exponential backoff, ms (default 100; doubles per retry). */
	backoffMs?: number;
	/** R2 redaction patterns (defaults: the documented list). */
	redactions?: readonly RegExp[];
	/** R1 error report: called once per dropped chunk with the running drop total. */
	onError?: (error: unknown, dropped: number) => void;
}

/** Counters observable for `/pi-obs status` (Step 8). */
export interface OtlpExporterCounters {
	/** Records accepted by the endpoint (2xx). */
	exported: number;
	/** Records dropped after the final failed attempt of a chunk. */
	dropped: number;
	/** HTTP requests sent (including retries). */
	requests: number;
	/** Retries performed (a request that failed and was followed by another attempt). */
	retries: number;
	/** Last successful export (ms since epoch), or null before the first one. */
	lastExportAt: number | null;
	/** Last failure message, or null when the last chunk succeeded. */
	lastError: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Origins already warned about for being plain http:// (one warning per origin, ever). */
const warnedOrigins = new Set<string>();

/** Warn once per origin that the endpoint is plain http:// (R5: accepted, warned once). */
function warnHttpOnce(endpoint: string, warn: (message: string) => void): void {
	try {
		const origin = new URL(endpoint).origin;
		if (new URL(endpoint).protocol !== "http:") return;
		if (warnedOrigins.has(origin)) return;
		warnedOrigins.add(origin);
		warn(`pi-obs: OTLP endpoint ${origin} is plain http:// — credentials and telemetry travel unencrypted (accepted; local collectors are the norm)`);
	} catch {
		// an invalid endpoint is the wiring's validation problem (config.ts), not ours
	}
}

/**
 * Derive the per-signal OTLP/HTTP URL from the configured endpoint:
 * `http://h:4318` → `http://h:4318/v1/<signal>`;
 * `http://h:4318/v1/traces` → `…/v1/<signal>` (last segment rewritten).
 */
export function signalUrl(endpoint: string, signal: "traces" | "metrics" | "logs"): string {
	const base = endpoint.replace(/\/+$/, "");
	if (/\/v1\/(traces|metrics|logs)$/.test(base)) return base.replace(/\/v1\/[a-z]+$/, `/v1/${signal}`);
	return `${base}/v1/${signal}`;
}

/** Merge serialized record lines into one OTLP export-request body per signal. */
function mergeChunk(lines: string[], wrapper: "resourceSpans" | "resourceMetrics" | "resourceLogs"): string {
	const parts = lines.map((line) => (JSON.parse(line) as Record<string, unknown[]>)[wrapper]);
	return JSON.stringify({ [wrapper]: parts.flat() });
}

/** The OTLP/HTTP exporter — an `Exporter` for the queue. */
export class OtlpExporter implements Exporter {
	readonly name = "otlp";
	#endpoint: string;
	#resource: Record<string, AttrValue>;
	#headers: Record<string, string>;
	#timeoutMs: number;
	#batch: number;
	#attempts: number;
	#backoffMs: number;
	#redactions: readonly RegExp[];
	#onError?: (error: unknown, dropped: number) => void;
	#exported = 0;
	#dropped = 0;
	#requests = 0;
	#retries = 0;
	#lastExportAt: number | null = null;
	#lastError: string | null = null;

	constructor(opts: OtlpExporterOptions, warn: (message: string) => void = (m) => console.error(m)) {
		this.#endpoint = opts.endpoint;
		this.#resource = opts.resource;
		this.#headers = opts.headers ?? {};
		this.#timeoutMs = opts.timeoutMs ?? 5000;
		this.#batch = opts.batch ?? 64;
		this.#attempts = opts.attempts ?? 3;
		this.#backoffMs = opts.backoffMs ?? 100;
		this.#redactions = opts.redactions ?? DEFAULT_REDACTIONS;
		this.#onError = opts.onError;
		warnHttpOnce(opts.endpoint, warn);
	}

	/** The configured endpoint (shown by `/pi-obs status`). */
	get endpointUrl(): string {
		return this.#endpoint;
	}

	/** Counters snapshot for `/pi-obs status`. */
	get counters(): OtlpExporterCounters {
		return { exported: this.#exported, dropped: this.#dropped, requests: this.#requests, retries: this.#retries, lastExportAt: this.#lastExportAt, lastError: this.#lastError };
	}

	async export(items: readonly TelemetryItem[]): Promise<void> {
		const groups: { signal: "traces" | "metrics" | "logs"; wrapper: "resourceSpans" | "resourceMetrics" | "resourceLogs"; items: TelemetryItem[] }[] = [
			{ signal: "traces", wrapper: "resourceSpans", items: items.filter((i) => i.kind === "span") },
			{ signal: "metrics", wrapper: "resourceMetrics", items: items.filter((i) => i.kind === "metric") },
			{ signal: "logs", wrapper: "resourceLogs", items: items.filter((i) => i.kind === "log") },
		];
		for (const group of groups) {
			for (let start = 0; start < group.items.length; start += this.#batch) {
				const chunk = group.items.slice(start, start + this.#batch);
				await this.#sendChunk(group.signal, group.wrapper, chunk);
			}
		}
	}

	async #sendChunk(signal: "traces" | "metrics" | "logs", wrapper: "resourceSpans" | "resourceMetrics" | "resourceLogs", chunk: TelemetryItem[]): Promise<void> {
		const lines: string[] = [];
		for (const item of chunk) {
			const line = exportRequestLine(item, this.#resource, this.#redactions);
			if (line !== null) lines.push(line); // unserializable items are skipped (R1; the file exporter counts them)
		}
		if (lines.length === 0) return;
		const url = signalUrl(this.#endpoint, signal);
		const body = mergeChunk(lines, wrapper);
		let lastError: unknown = new Error("OTLP export never attempted");
		for (let attempt = 1; attempt <= this.#attempts; attempt++) {
			this.#requests += 1;
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: { ...this.#headers, "content-type": "application/json" },
					body,
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				await response.text(); // drain the (tiny) body so the socket is released
				if (response.status >= 200 && response.status < 300) {
					this.#exported += lines.length;
					this.#lastExportAt = Date.now(); // lastError stays sticky: the last failure remains visible for /pi-obs status
					return;
				}
				const message = `OTLP endpoint answered ${response.status} for ${signal}`;
				this.#lastError = message;
				lastError = new Error(message);
			} catch (error) {
				lastError = error; // timeout abort, connection refused, DNS — all retried alike
				this.#lastError = String(error);
			}
			if (attempt < this.#attempts) {
				this.#retries += 1;
				await sleep(this.#backoffMs * 2 ** (attempt - 1));
			}
		}
		this.#dropped += lines.length;
		this.#onError?.(lastError, this.#dropped);
	}
}
