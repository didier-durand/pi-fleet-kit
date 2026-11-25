/**
 * pi-obs — bounded queue + asynchronous dispatch (SPECS R1/R5, DEV_PLAN
 * Step 3). The delivery core between capture and exporters.
 *
 *   - bounded (`PI_OBS_QUEUE_MAX`, default 4096 at the wiring): when
 *     full, the OLDEST item is dropped and a drop counter increments —
 *     a burst never blocks a hook (R1 > R5);
 *   - enqueue is CHEAP and synchronous: push (+ drop-oldest when full)
 *     and a microtask-scheduled drain — nothing else. The ≤ 1 ms hook
 *     budget of R1 is measured against this module;
 *   - asynchronous drain with fan-out to all active exporters: an
 *     error in one exporter never affects the others (per-exporter
 *     isolation) and never rejects the drain;
 *   - flush-with-timeout: bounded wait until the queue is empty and no
 *     dispatch is in flight — a dead/hanging exporter costs telemetry,
 *     never hangs shutdown;
 *   - counters (enqueued / dropped / drained) observable for
 *     `/pi-obs status` (Step 8); `onDrop` / `onExportError` hooks let
 *     the wiring emit the R4 log records (drops and exporter faults).
 *
 * Pure module: no pi imports, no timers beyond setTimeout in the flush
 * poll — unit-testable standalone.
 */

import type { LogRecordData, MetricData, SpanData } from "./model.ts";

/** One telemetry item as captured — the queue is agnostic to its shape. */
export type TelemetryItem =
	| { kind: "span"; span: SpanData }
	| { kind: "metric"; metric: MetricData }
	| { kind: "log"; log: LogRecordData };

/** An exporter sink: receives batches of finished telemetry. */
export interface Exporter {
	/** Registered exporter name (R4 log records: `pi.exporter.name`). */
	name: string;
	/** Export one batch; may reject — isolated per exporter, never fatal. */
	export(items: readonly TelemetryItem[]): Promise<void>;
}

/** Observable queue counters (R7 `/pi-obs status`, R5 drop notices). */
export interface QueueCounters {
	/** Items accepted by enqueue (including later-dropped ones). */
	enqueued: number;
	/** Items dropped: queue overflow (oldest first) or post-shutdown enqueue. */
	dropped: number;
	/** Items handed to exporters (left the queue — export failures still count as drained). */
	drained: number;
}

/** Queue construction options. */
export interface QueueOptions {
	/** Bound — the OLDEST item is dropped beyond it (R5). */
	max: number;
	/** Active exporters; fan-out order is unspecified, isolation is guaranteed. */
	exporters: Exporter[];
	/** Called with the running drop total after every drop (wiring emits the R4 log record). */
	onDrop?: (dropped: number) => void;
	/** Called when an exporter rejects; never throws back into the queue. */
	onExportError?: (exporter: string, error: unknown, items: number) => void;
	/** Flush poll interval, ms (default 5). */
	pollMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded asynchronous telemetry queue. */
export class TelemetryQueue {
	#items: TelemetryItem[] = [];
	#max: number;
	#exporters: Exporter[];
	#onDrop?: (dropped: number) => void;
	#onExportError?: (exporter: string, error: unknown, items: number) => void;
	#pollMs: number;
	#drainScheduled = false;
	#draining = false;
	#stopped = false;
	#enqueued = 0;
	#dropped = 0;
	#drained = 0;

	constructor(opts: QueueOptions) {
		this.#max = opts.max;
		this.#exporters = opts.exporters;
		this.#onDrop = opts.onDrop;
		this.#onExportError = opts.onExportError;
		this.#pollMs = opts.pollMs ?? 5;
	}

	/** Cheap, synchronous: push, drop-oldest overflow, schedule the drain. */
	enqueue(item: TelemetryItem): void {
		if (this.#stopped) {
			// closed queue: nothing will ever drain it — count and report, never block
			this.#dropped += 1;
			this.#onDrop?.(this.#dropped);
			return;
		}
		this.#enqueued += 1;
		this.#items.push(item);
		if (this.#items.length > this.#max) {
			const dropped = this.#items.shift();
			if (dropped !== undefined) {
				this.#dropped += 1;
				this.#onDrop?.(this.#dropped);
			}
		}
		this.#schedule();
	}

	/** Counters snapshot for `/pi-obs status`. */
	get counters(): QueueCounters {
		return { enqueued: this.#enqueued, dropped: this.#dropped, drained: this.#drained };
	}

	/** Items currently waiting (never counts in-flight dispatches). */
	get pending(): number {
		return this.#items.length;
	}

	#schedule(): void {
		if (this.#drainScheduled || this.#stopped) return;
		this.#drainScheduled = true;
		queueMicrotask(() => {
			this.#drainScheduled = false;
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#draining) return; // a drain is already in flight — it will pick these up
		this.#draining = true;
		try {
			while (this.#items.length > 0) {
				const batch = this.#items.splice(0, this.#items.length);
				this.#drained += batch.length;
				await Promise.all(
					this.#exporters.map(async (exporter) => {
						try {
							await exporter.export(batch);
						} catch (error) {
							this.#onExportError?.(exporter.name, error, batch.length);
						}
					}),
				);
			}
		} finally {
			this.#draining = false;
		}
	}

	/**
	 * Wait (bounded) until the queue is empty and no dispatch is in
	 * flight. Returns true when fully drained; false on timeout — a
	 * hanging exporter costs telemetry, never hangs the caller (R1).
	 */
	async flush(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		this.#schedule();
		for (;;) {
			if (this.#items.length === 0 && !this.#draining) return true;
			if (Date.now() >= deadline) return false;
			await sleep(this.#pollMs);
		}
	}

	/**
	 * Shutdown path (R5: `session_shutdown` / process exit): best-effort
	 * bounded flush, then the queue is closed — later enqueues are
	 * counted as drops, never silently lost nor blocking.
	 */
	async shutdown(timeoutMs: number): Promise<boolean> {
		const drained = await this.flush(timeoutMs);
		this.#stopped = true;
		return drained;
	}
}
