/**
 * pi-obs — bounded queue + dispatch tests (SPECS R1/R5 ACs, DEV_PLAN
 * Step 3).
 *
 *   - overflow drops the OLDEST item and increments the drop counter
 *     (order preserved for what remains);
 *   - a consumer slower than the producer never blocks the producer:
 *     timing-asserted enqueues under a stalled drain, and a queue that
 *     fills and drops while the drain is stalled;
 *   - flush drains to empty (true) and respects its timeout against a
 *     hanging consumer (false, bounded elapsed time);
 *   - dispatch fan-out: an error in one exporter never affects the
 *     other, and is reported through onExportError;
 *   - shutdown: best-effort bounded flush, then closed — post-shutdown
 *     enqueues are counted as drops;
 *   - counters observable for Step 8's `/pi-obs status`;
 *   - enqueue-cost micro-benchmark: µs/op measured and asserted within
 *     the R1 hook budget (≤ 1 ms/op), recorded in the DEV_PLAN status.
 *
 * Real timers, generous CI margins: every bound is 10×+ above the
 * measured local cost.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { TelemetryQueue, type Exporter, type TelemetryItem } from "../../src/queue.ts";
import { logRecord } from "../../src/model.ts";

const item = (n: number): TelemetryItem & { kind: "log"; log: { body: string } } => ({ kind: "log" as const, log: logRecord("INFO", `item ${n}`, undefined, 1700000000000 + n) });

/** Recording exporter: captures batches, optional hang or rejection. */
function recorder(opts?: { hang?: Promise<void>; reject?: boolean }): Exporter & { batches: TelemetryItem[][]; items: TelemetryItem[] } {
	const batches: TelemetryItem[][] = [];
	return {
		name: opts?.reject === true ? "bad" : "rec",
		batches,
		get items(): TelemetryItem[] {
			return batches.flat();
		},
		async export(items: readonly TelemetryItem[]): Promise<void> {
			if (opts?.reject === true) throw new Error("exporter exploded");
			if (opts?.hang !== undefined) await opts.hang;
			batches.push([...items]);
		},
	};
}

test("overflow drops the OLDEST item and counts it; order preserved for the rest", async () => {
	const drops: number[] = [];
	const rec = recorder();
	const q = new TelemetryQueue({ max: 3, exporters: [rec], onDrop: (d) => drops.push(d) });
	for (const n of [1, 2, 3, 4]) q.enqueue(item(n)); // 4 into a bound of 3 → item 1 dropped

	assert.deepEqual(q.counters, { enqueued: 4, dropped: 1, drained: 0 });
	assert.deepEqual(drops, [1], "onDrop fires with the running total");
	assert.equal(await q.flush(1000), true);
	assert.deepEqual(
		rec.items.map((i) => (i as { log: { body: string } }).log.body),
		["item 2", "item 3", "item 4"],
		"the oldest (item 1) was dropped; the rest keep their order",
	);
	assert.deepEqual(q.counters, { enqueued: 4, dropped: 1, drained: 3 });
	assert.equal(q.pending, 0);
});

test("a stalled drain never blocks the producer (timing-asserted) and the queue drops as it fills", async () => {
	let release: () => void = () => {};
	const hang = new Promise<void>((resolve) => {
		release = resolve;
	});
	const rec = recorder({ hang });
	const drops: number[] = [];
	const q = new TelemetryQueue({ max: 8, exporters: [rec], onDrop: (d) => drops.push(d) });

	// the drain stalls inside the very first dispatch
	q.enqueue(item(0));
	await sleep(5);
	assert.equal(q.counters.drained, 1, "first item entered dispatch");

	// 16 more enqueues under the stall: every one must be cheap (R1: ≤ 1 ms/op)
	const t0 = performance.now();
	for (let n = 1; n <= 16; n++) q.enqueue(item(n));
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 16, `16 enqueues under a stalled drain took ${elapsed.toFixed(2)}ms — the producer was blocked`);
	assert.ok(elapsed / 16 < 1, `enqueue cost ${(elapsed / 16).toFixed(3)}ms/op exceeds the 1ms R1 budget`);

	// bound 8: 1 in dispatch + 8 queued → the last 8 of the 16 enqueues dropped oldest-first
	assert.deepEqual(q.counters, { enqueued: 17, dropped: 8, drained: 1 });
	assert.equal(q.pending, 8);
	assert.deepEqual(drops.slice(-1), [8], "onDrop kept reporting the running total while stalled");

	release();
	assert.equal(await q.flush(1000), true);
	assert.equal(q.counters.dropped, 8);
});

test("flush drains to empty and returns true; batches preserve item order", async () => {
	const rec = recorder();
	const q = new TelemetryQueue({ max: 100, exporters: [rec] });
	for (let n = 0; n < 10; n++) q.enqueue(item(n));
	assert.equal(await q.flush(1000), true);
	assert.deepEqual(
		rec.items.map((i) => (i as { log: { body: string } }).log.body),
		Array.from({ length: 10 }, (_, n) => `item ${n}`),
	);
	// an empty, idle queue flushes true immediately
	assert.equal(await q.flush(0), true);
});

test("flush respects its timeout against a hanging consumer (never hangs the caller)", async () => {
	let release: () => void = () => {};
	const hang = new Promise<void>((resolve) => {
		release = resolve;
	});
	const rec = recorder({ hang });
	const q = new TelemetryQueue({ max: 100, exporters: [rec], pollMs: 1 });
	q.enqueue(item(1));
	await sleep(5);

	const t0 = performance.now();
	assert.equal(await q.flush(100), false, "hanging exporter → flush gives up");
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 500, `flush(100) against a hang took ${elapsed.toFixed(0)}ms — timeout not respected`);
	assert.equal(q.pending, 0, "items left the queue into the in-flight dispatch");

	release();
	await sleep(10);
	assert.equal(await q.flush(1000), true, "once released, the next flush is clean");
	assert.equal(rec.items.length, 1);
});

test("fan-out: an error in one exporter never affects the other; onExportError reports it", async () => {
	const errors: Array<[string, unknown, number]> = [];
	const good = recorder();
	const bad = recorder({ reject: true });
	const q = new TelemetryQueue({
		max: 100,
		exporters: [bad, good],
		onExportError: (exporter, error, items) => errors.push([exporter, error, items]),
	});
	for (let n = 0; n < 3; n++) q.enqueue(item(n));
	assert.equal(await q.flush(1000), true, "a failing exporter never fails the flush");
	assert.equal(good.items.length, 3, "the healthy exporter got every item");
	assert.equal(bad.batches.length, 0, "the failing exporter received the batch but recorded nothing");
	assert.deepEqual(
		errors.map(([name, , items]) => [name, items]),
		[["bad", 3]],
	);
	assert.match(String(errors[0]?.[1]), /exporter exploded/);
	assert.deepEqual(q.counters, { enqueued: 3, dropped: 0, drained: 3 }, "drained counts items that left the queue");
});

test("shutdown: best-effort bounded flush, then closed — post-shutdown enqueues are counted drops", async () => {
	const drops: number[] = [];
	const rec = recorder();
	const q = new TelemetryQueue({ max: 100, exporters: [rec], onDrop: (d) => drops.push(d) });
	q.enqueue(item(1));
	q.enqueue(item(2));
	assert.equal(await q.shutdown(1000), true, "shutdown flushed the pending items");
	assert.equal(rec.items.length, 2);

	q.enqueue(item(3));
	assert.deepEqual(q.counters, { enqueued: 2, dropped: 1, drained: 2 }, "post-shutdown enqueue → dropped, counted, reported");
	assert.deepEqual(drops, [1]);
	assert.equal(q.pending, 0, "nothing lingers in a closed queue");
});

test("shutdown against a hanging exporter is bounded (false, not hung)", async () => {
	let release: () => void = () => {};
	const hang = new Promise<void>((resolve) => {
		release = resolve;
	});
	const q = new TelemetryQueue({ max: 10, exporters: [recorder({ hang })], pollMs: 1 });
	q.enqueue(item(1));
	await sleep(5);
	const t0 = performance.now();
	assert.equal(await q.shutdown(80), false);
	assert.ok(performance.now() - t0 < 400, "shutdown timeout not respected");
	release();
});

test("counters observable for /pi-obs status across a full lifecycle", async () => {
	const rec = recorder();
	const q = new TelemetryQueue({ max: 5, exporters: [rec] });
	for (let n = 0; n < 8; n++) q.enqueue(item(n)); // 3 dropped oldest-first
	assert.equal(await q.flush(1000), true);
	assert.equal(await q.shutdown(1000), true);
	const { enqueued, dropped, drained } = q.counters;
	assert.equal(enqueued, 8);
	assert.equal(dropped, 3);
	assert.equal(drained, 5);
	assert.equal(rec.items.length, 5);
});

test("enqueue-cost micro-benchmark (R1 hook budget; value recorded in DEV_PLAN status)", async () => {
	let release: () => void = () => {};
	const hang = new Promise<void>((resolve) => {
		release = resolve;
	});
	const q = new TelemetryQueue({ max: 4096, exporters: [recorder({ hang })] });
	q.enqueue(item(0));
	await sleep(5); // drain stalled in dispatch

	const N = 20000;
	const t0 = performance.now();
	for (let n = 1; n <= N; n++) q.enqueue(item(n));
	const perOpUs = ((performance.now() - t0) / N) * 1000;
	assert.ok(perOpUs <= 1000, `enqueue cost ${perOpUs.toFixed(2)}µs/op exceeds the 1ms R1 budget`);
	assert.ok(perOpUs <= 100, `enqueue cost ${perOpUs.toFixed(2)}µs/op — suspiciously slow for a push+bound (CI margin 100µs)`);
	console.log(`enqueue cost: ${perOpUs.toFixed(2)} µs/op over ${N} ops under a stalled drain (budget: 1000 µs/op)`);

	release();
	await q.flush(1000);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
