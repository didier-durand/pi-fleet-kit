/**
 * pi-obs — stats.ts unit tests (R7): the usage aggregation edge arms —
 * derived totals when a usage record carries no totalTokens, unknown
 * provider/model buckets, and the cost-tiebreak in the model ranking.
 * The byte-identical golden surfaces live in commands.test.ts / index.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats } from "../../src/stats.ts";

test("usage without totalTokens is derived from its parts", () => {
	const stats = computeStats([
		{ type: "usage", provider: "openrouter", model: "m/x", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 20, reasoning: 7 } },
	]);
	assert.equal(stats.usage.totalTokens, 187, "input + output + cacheRead + cacheWrite + reasoning");
	assert.equal(stats.usage.input, 100);
	assert.equal(stats.usage.reasoning, 7);
});

test("usage without totalTokens is derived from its parts", () => {
	const stats = computeStats([
		{ type: "usage", provider: "openrouter", model: "m/x", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 20, reasoning: 7 } },
		{ type: "usage", provider: "openrouter", model: "m/x", usage: { input: 3 } }, // absent cache/reasoning arms
		{ type: "usage", provider: "openrouter", model: "m/x", usage: { output: 4 } }, // absent input arm
		{ type: "usage", provider: "openrouter", model: "m/x", usage: {} }, // every field absent: all zero-fallbacks
	]);
	assert.equal(stats.usage.totalTokens, 194, "187 + 3 + 4, all derived");
	assert.equal(stats.usage.input, 103, "100 + 3 + 0 (absent input counts as 0)");
});

test("usage without provider/model lands in the unknown bucket", () => {
	const stats = computeStats([{ type: "usage", usage: { input: 5, output: 5, totalTokens: 10 } }]);
	assert.equal(stats.models.length, 1);
	assert.equal(stats.models[0].provider, "unknown");
	assert.equal(stats.models[0].model, "unknown");
	assert.equal(stats.models[0].usage.totalTokens, 10);
});

test("the model ranking tiebreaks on turns when costs are equal", () => {
	const stats = computeStats([
		{ type: "usage", provider: "p", model: "cheap", usage: { totalTokens: 10, cost: { total: 0 } } },
		{ type: "usage", provider: "p", model: "cheap2", usage: { totalTokens: 10, cost: { total: 0 } } },
	]);
	assert.equal(stats.models.length, 2);
	// equal cost → the || comparator falls through to the turns comparison (stable order preserved here)
	assert.deepEqual(stats.models.map((m) => m.model), ["cheap", "cheap2"]);
});

test("entries without timestamps leave the duration unset", () => {
	const stats = computeStats([{ type: "usage", provider: "p", model: "m", usage: { totalTokens: 1 } }]);
	assert.equal(stats.firstTimestamp, null);
	assert.equal(stats.durationMs, null);
});
