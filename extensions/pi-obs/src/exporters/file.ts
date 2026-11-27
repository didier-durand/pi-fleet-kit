/**
 * pi-obs — file exporter (SPECS R5 file leg, DEV_PLAN Step 4).
 *
 * Writes finished telemetry as OTLP/JSON export-request bodies, ONE PER
 * LINE, into a local log file — the file is later-ingestable by any
 * OTLP/JSON consumer (pipes straight into otelcol or jq), not a bespoke
 * format. Shared serialization with the OTLP/HTTP exporter (Step 5) via
 * exporters/otlp-json.ts — no parallel formatting path.
 *
 *   - size-based rotation: PI_OBS_FILE_MAX_BYTES per file, at most
 *     PI_OBS_FILE_MAX_FILES files TOTAL on disk (active + rotated
 *     `.1 … .N-1`), oldest dropped;
 *   - R2: the target MUST NOT be inside a session directory — rejected
 *     at construction with the R2 message (fail closed: a misconfigured
 *     target never silently writes next to session files);
 *   - R2 redaction: applied by the shared serializer to every emitted
 *     string before write (the opt-in captured-text attributes are the
 *     only ones that ever carry raw text to begin with);
 *   - R1: write failures (unreadable/read-only target, vanished
 *     directory) are REPORTED through onError and counted in the drop
 *     counter — never thrown, never blocking: a broken file leg only
 *     ever costs telemetry;
 *   - append-only single-writer discipline: one line per append, so
 *     concurrent exports from the queue drain stay line-atomic.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AttrValue } from "../model.ts";
import type { Exporter, TelemetryItem } from "../queue.ts";
import { DEFAULT_REDACTIONS, exportRequestLine } from "./otlp-json.ts";

/** File exporter construction options. */
export interface FileExporterOptions {
	/** Target log file (resolved; the R2 session-dir rule applies). */
	path: string;
	/** Rotation size per file, bytes. */
	maxBytes: number;
	/** Files kept TOTAL (active + rotated), oldest dropped. */
	maxFiles: number;
	/** OTel resource attributes embedded in every record. */
	resource: Record<string, AttrValue>;
	/** R2 redaction patterns (defaults: the documented list). */
	redactions?: readonly RegExp[];
	/** R1 error report: called once per failed write with the running drop total. */
	onError?: (error: unknown, dropped: number) => void;
}

/**
 * R2: reject targets inside a session directory. Intentionally
 * conservative — pi sessions live under `…/agent/sessions/<slug>/…`, so
 * any `agent/sessions` path component, or a `sessions/<slug>/<file>`
 * tail, refuses to start. False positives cost one config edit; a
 * telemetry file beside session files costs trust.
 */
export function assertNotSessionDir(path: string): void {
	const norm = path.replaceAll("\\", "/");
	if (/(^|\/)agent\/sessions\//.test(norm) || /(^|\/)sessions\/[^/]+\/[^/]+\.jsonl$/.test(norm)) {
		throw new Error(
			`pi-obs: file exporter target "${path}" is inside a session directory — telemetry must never be written next to session files (R2); set PI_OBS_FILE_PATH (or the filePath setting) elsewhere`,
		);
	}
}

/** Counters observable for `/pi-obs status` (Step 8). */
export interface FileExporterCounters {
	/** Records (lines) successfully written. */
	written: number;
	/** Records dropped: write failures, or unserializable items. */
	dropped: number;
	/** Last successful write (ms since epoch), or null before the first one. */
	lastExportAt: number | null;
	/** Last write failure message, or null when the last attempt succeeded. */
	lastError: string | null;
}

/** The file exporter — an `Exporter` for the queue. */
export class FileExporter implements Exporter {
	readonly name = "file";
	#path: string;
	#maxBytes: number;
	#maxFiles: number;
	#resource: Record<string, AttrValue>;
	#redactions: readonly RegExp[];
	#onError?: (error: unknown, dropped: number) => void;
	#written = 0;
	#dropped = 0;
	#lastExportAt: number | null = null;
	#lastError: string | null = null;
	#dirReady = false;

	constructor(opts: FileExporterOptions) {
		assertNotSessionDir(opts.path);
		if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1) {
			throw new Error(`pi-obs file exporter: maxBytes must be an integer ≥ 1, got ${opts.maxBytes}`);
		}
		if (!Number.isInteger(opts.maxFiles) || opts.maxFiles < 1) {
			throw new Error(`pi-obs file exporter: maxFiles must be an integer ≥ 1, got ${opts.maxFiles}`);
		}
		this.#path = opts.path;
		this.#maxBytes = opts.maxBytes;
		this.#maxFiles = opts.maxFiles;
		this.#resource = opts.resource;
		this.#redactions = opts.redactions ?? DEFAULT_REDACTIONS;
		this.#onError = opts.onError;
	}

	/** The resolved target path (shown by `/pi-obs status`). */
	get targetPath(): string {
		return this.#path;
	}

	/** Counters snapshot for `/pi-obs status`. */
	get counters(): FileExporterCounters {
		return { written: this.#written, dropped: this.#dropped, lastExportAt: this.#lastExportAt, lastError: this.#lastError };
	}

	async export(items: readonly TelemetryItem[]): Promise<void> {
		for (const item of items) {
			const line = exportRequestLine(item, this.#resource, this.#redactions);
			if (line === null) {
				// unserializable item: drop, report, keep going (R1)
				this.#dropped += 1;
				this.#lastError = `unserializable telemetry item (kind ${(item as { kind?: string }).kind})`;
				this.#onError?.(new Error(this.#lastError), this.#dropped);
				continue;
			}
			try {
				this.#appendLine(line);
				this.#written += 1;
				this.#lastExportAt = Date.now(); // lastError stays sticky: the last failure remains visible for /pi-obs status
			} catch (error) {
				this.#dropped += 1;
				this.#lastError = String(error);
				this.#onError?.(error, this.#dropped);
			}
		}
	}

	#appendLine(line: string): void {
		if (!this.#dirReady) {
			mkdirSync(dirname(this.#path), { recursive: true });
			this.#dirReady = true;
		}
		const bytes = Buffer.byteLength(line) + 1; // + newline
		if (existsSync(this.#path) && statSync(this.#path).size + bytes > this.#maxBytes) this.#rotate();
		appendFileSync(this.#path, `${line}\n`);
	}

	/** Shift rotated files down one slot, dropping what falls past the cap. */
	#rotate(): void {
		if (this.#maxFiles === 1) {
			// cap is the active file alone: drop it and start fresh
			rmSync(this.#path, { force: true });
			return;
		}
		const oldest = `${this.#path}.${this.#maxFiles - 1}`;
		if (existsSync(oldest)) unlinkSync(oldest);
		for (let slot = this.#maxFiles - 1; slot >= 2; slot--) {
			const from = `${this.#path}.${slot - 1}`;
			if (existsSync(from)) renameSync(from, `${this.#path}.${slot}`);
		}
		renameSync(this.#path, `${this.#path}.1`);
	}
}
