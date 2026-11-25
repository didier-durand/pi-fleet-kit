/**
 * pi-obs — usage-inventory tests (SPECS R3 ACs, DEV_PLAN Step 6).
 *
 *   - the complete 41-hook inventory (grounding §2) is walked: every
 *     documented hook appears exactly once, in exactly one of
 *     A / B / D;
 *   - the 3 category-D hooks are exactly provider_stream_event,
 *     message_start, mcp_servers_change, each with a stated reason —
 *     and index.ts registers NO handler for them (asserted in
 *     index.test.ts against the live subscription set);
 *   - the 12 category-C inert hooks match SPECS R3's normative list;
 *   - every entity/metric name the inventory emits is registered in
 *     the semconv tables (R4: the table is the contract);
 *   - A∪B (38) is exactly what index.ts subscribes to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOOK_INVENTORY, INERT_HOOKS, SUBSCRIBED_HOOKS, UNSUBSCRIBED_HOOKS, lookupHook } from "../../src/hooks.ts";
import { ALL_NAMES } from "../../src/semconv.ts";

/** The 41 documented pi hooks (grounding §2 — the fixed surface). */
const DOCUMENTED_HOOKS = [
	// startup/resources (3)
	"project_trust", "resources_discover", "mcp_servers_change",
	// user interaction (4)
	"input", "ui_prompt_start", "ui_prompt_end", "user_bash",
	// agent and model (16)
	"before_agent_start", "agent_start", "agent_end", "agent_before_settle", "agent_settled",
	"turn_start", "turn_end", "context", "context_with_system",
	"before_provider_headers", "before_provider_request", "after_provider_response",
	"provider_stream_event", "message_start", "message_update", "message_end",
	// model selection/decisions (3)
	"model_select", "thinking_level_select", "cache_warming_decision",
	// tool calls (5)
	"tool_execution_start", "tool_call", "tool_execution_update", "tool_result", "tool_execution_end",
	// session lifecycle (10)
	"session_start", "session_shutdown", "session_info_changed", "session_before_switch",
	"session_before_fork", "session_before_compact", "session_compact", "session_compact_failed",
	"session_before_tree", "session_tree",
];

test("the inventory covers all 41 documented hooks, each in exactly one category", () => {
	assert.equal(DOCUMENTED_HOOKS.length, 41, "grounding §2 lists exactly 41 hooks");
	assert.equal(HOOK_INVENTORY.length, 41, "the inventory has exactly 41 rows");

	const counts = { A: 0, B: 0, D: 0 };
	const seen = new Set<string>();
	for (const spec of HOOK_INVENTORY) {
		assert.ok(!seen.has(spec.hook), `duplicate inventory row for "${spec.hook}"`);
		seen.add(spec.hook);
		assert.ok(counts[spec.category] !== undefined, `bad category for "${spec.hook}"`);
		counts[spec.category] += 1;
	}
	assert.deepEqual([...seen].sort(), [...DOCUMENTED_HOOKS].sort(), "every documented hook appears exactly once");
	assert.deepEqual(counts, { A: 36, B: 2, D: 3 }, "SPECS R3: 36 emitting + 2 metrics-only + 3 not subscribed");
});

test("category D: exactly the 3 SPECS hooks, each with a stated reason", () => {
	assert.deepEqual([...UNSUBSCRIBED_HOOKS].sort(), ["mcp_servers_change", "message_start", "provider_stream_event"]);
	for (const hook of UNSUBSCRIBED_HOOKS) {
		const spec = lookupHook(hook);
		assert.ok(spec?.reason !== undefined && spec.reason.length > 20, `${hook}: reason must be stated`);
	}
});

test("category C: the 12 inert-handler hooks match SPECS R3's normative list", () => {
	assert.deepEqual([...INERT_HOOKS].sort(), [
		"before_provider_headers",
		"before_provider_request",
		"cache_warming_decision",
		"context",
		"context_with_system",
		"input",
		"session_before_compact",
		"session_before_fork",
		"session_before_switch",
		"session_before_tree",
		"tool_call",
		"tool_result",
	].sort());
	// C hooks are all SUBSCRIBED (the constraint applies to handlers, not subscriptions)
	for (const hook of INERT_HOOKS) assert.ok(SUBSCRIBED_HOOKS.includes(hook), `${hook} must be subscribed`);
});

test("A∪B is exactly the 38 subscribed hooks", () => {
	assert.equal(SUBSCRIBED_HOOKS.length, 38);
	assert.equal(HOOK_INVENTORY.filter((s) => s.category !== "D").length, 38);
	for (const hook of UNSUBSCRIBED_HOOKS) assert.ok(!SUBSCRIBED_HOOKS.includes(hook));
});

test("every entity and metric name in the inventory is registered in semconv", () => {
	for (const spec of HOOK_INVENTORY) {
		if (spec.entity !== undefined) {
			assert.ok(ALL_NAMES.has(spec.entity), `${spec.hook}: entity "${spec.entity}" is not in the semconv tables`);
		}
		for (const metric of spec.metrics ?? []) {
			assert.ok(ALL_NAMES.has(metric), `${spec.hook}: metric "${metric}" is not in the semconv tables`);
		}
	}
});

test("lookupHook resolves known hooks and rejects unknown ones", () => {
	assert.equal(lookupHook("session_start")?.category, "A");
	assert.equal(lookupHook("message_update")?.category, "B");
	assert.equal(lookupHook("provider_stream_event")?.category, "D");
	assert.equal(lookupHook("not_a_hook"), undefined);
});
