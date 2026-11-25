/**
 * pi-obs — the R3 usage inventory in code (DEV_PLAN Step 6).
 *
 * Every one of the 41 documented pi hooks (grounding §2, verified
 * against the installed pi's docs/extensions.md) appears here exactly
 * once, in exactly one subscription category:
 *
 *   - **A** — subscribed, emitting entities (36): each row names the
 *     OTel entity (span, span event, or span + events) it produces;
 *   - **B** — subscribed, metrics-only (2): feed R4 counters, no span
 *     or span-event emission (volume control);
 *   - **D** — NOT subscribed (3), with the stated reason.
 *
 * Category **C** is not a fourth subscription set: it is the
 * inert-handler constraint FLAG on 12 of the subscribed hooks — the
 * decision/transformation hooks whose pi-obs handler MUST observe
 * only (return `undefined`, never block/cancel/transform/replace/
 * decide). The C list is normative (SPECS R3).
 *
 * This module is the registry the tests walk (SPECS R3 AC): all 41
 * present, each in exactly one of A/B/D, the C flags exactly 12, and
 * the D hooks have no registered handler anywhere. Pure data, no pi
 * imports.
 */

/** The R3 subscription categories. */
export type HookCategory = "A" | "B" | "D";

/** One row of the usage inventory. */
export interface HookSpec {
	/** The pi hook name (exactly as pi documents it). */
	hook: string;
	/** Subscription category: A emitting, B metrics-only, D not subscribed. */
	category: HookCategory;
	/** A: the OTel entity produced (span name, span-event name, or both). */
	entity?: string;
	/** A/B: metric names fed (R4 table). */
	metrics?: string[];
	/** C: this subscribed hook's handler MUST be inert (observe only). */
	inert?: boolean;
	/** D: the stated reason for not subscribing. */
	reason?: string;
}

/** The 41-hook usage inventory (SPECS R3, normative). ADD-ONLY. */
export const HOOK_INVENTORY: readonly HookSpec[] = [
	// --- session lifecycle (A) ------------------------------------------------
	{ hook: "session_start", category: "A", entity: "pi.session" },
	{ hook: "session_shutdown", category: "A", entity: "pi.session" },
	{ hook: "session_info_changed", category: "A", entity: "pi.session.renamed" },
	{ hook: "session_before_switch", category: "A", entity: "pi.session.switch", inert: true },
	{ hook: "session_before_fork", category: "A", entity: "pi.session.fork", inert: true },
	{ hook: "session_before_compact", category: "A", entity: "pi.session.compact", inert: true },
	{ hook: "session_compact", category: "A", entity: "pi.session.compact" },
	{ hook: "session_compact_failed", category: "A", entity: "pi.session.compact" },
	{ hook: "session_before_tree", category: "A", entity: "pi.session.tree", inert: true },
	{ hook: "session_tree", category: "A", entity: "pi.session.tree" },
	// --- startup/resources (A) ------------------------------------------------
	{ hook: "project_trust", category: "A", entity: "pi.resources" },
	{ hook: "resources_discover", category: "A", entity: "pi.resources" },
	// --- user interaction (A) -------------------------------------------------
	{ hook: "input", category: "A", entity: "pi.user.input", inert: true },
	{ hook: "user_bash", category: "A", entity: "pi.user.bash" },
	{ hook: "ui_prompt_start", category: "A", entity: "pi.ui.prompt" },
	{ hook: "ui_prompt_end", category: "A", entity: "pi.ui.prompt" },
	// --- agent and model (A) --------------------------------------------------
	{ hook: "before_agent_start", category: "A", entity: "pi.run" },
	{ hook: "agent_start", category: "A", entity: "pi.run" },
	{ hook: "agent_end", category: "A", entity: "pi.run" },
	{ hook: "agent_before_settle", category: "A", entity: "pi.run" },
	{ hook: "agent_settled", category: "A", entity: "pi.run.aborted" },
	{ hook: "turn_start", category: "A", entity: "pi.turn" },
	{ hook: "turn_end", category: "A", entity: "pi.turn" },
	{ hook: "before_provider_headers", category: "A", entity: "pi.model.headers", inert: true },
	{ hook: "before_provider_request", category: "A", entity: "pi.model", inert: true },
	{ hook: "after_provider_response", category: "A", entity: "pi.model.response_status" },
	{ hook: "message_end", category: "A", entity: "pi.model", metrics: ["pi.model.requests", "pi.tokens", "pi.cost.total", "pi.model.duration", "pi.model.time_to_first_token"] },
	{ hook: "context", category: "A", entity: "pi.context", inert: true },
	{ hook: "context_with_system", category: "A", entity: "pi.context", inert: true },
	// --- model selection/decisions (A) ----------------------------------------
	{ hook: "model_select", category: "A", entity: "pi.session.model_change" },
	{ hook: "thinking_level_select", category: "A", entity: "pi.session.thinking_level_change" },
	{ hook: "cache_warming_decision", category: "A", entity: "pi.model.cache_warming", inert: true },
	// --- tool calls (A) -------------------------------------------------------
	{ hook: "tool_execution_start", category: "A", entity: "pi.tool", metrics: ["pi.tool.calls"] },
	{ hook: "tool_call", category: "A", entity: "pi.tool.outcome", inert: true },
	{ hook: "tool_result", category: "A", entity: "pi.tool.result", inert: true },
	{ hook: "tool_execution_end", category: "A", entity: "pi.tool", metrics: ["pi.tool.duration"] },
	// --- streaming, metrics-only (B) ------------------------------------------
	{ hook: "message_update", category: "B", metrics: ["pi.messages", "pi.model.time_to_first_token"] },
	{ hook: "tool_execution_update", category: "B", metrics: ["pi.tool.updates"] },
	// --- not subscribed (D), reasons stated -----------------------------------
	{
		hook: "provider_stream_event",
		category: "D",
		reason:
			"Highest-fire-rate hook (per raw provider event). Its OTel-relevant content is already covered: text/thinking deltas via message_update (B), usage via message_end (A). A no-op subscription at this frequency is pure overhead (R1 economy) with no additional entity.",
	},
	{
		hook: "message_start",
		category: "D",
		reason:
			"No unique entity: the pi.model span opens at before_provider_request and closes at message_end; time-to-first-token is measured from request start to the first message_update delta. A subscription would be a no-op.",
	},
	{
		hook: "mcp_servers_change",
		category: "D",
		reason:
			"Resource configuration change, not agent activity; no session entry records it (so R3b replay cannot reproduce it either). MAY be added later as a span event under the add-only rule if MCP observability becomes a requirement.",
	},
];

const byHook = new Map(HOOK_INVENTORY.map((spec) => [spec.hook, spec]));

/** Look up one hook's inventory row; undefined when the name is not documented. */
export function lookupHook(hook: string): HookSpec | undefined {
	return byHook.get(hook);
}

/** The subscribed hooks (A ∪ B) — exactly what index.ts subscribes to, in inventory order. */
export const SUBSCRIBED_HOOKS: readonly string[] = HOOK_INVENTORY.filter((s) => s.category !== "D").map((s) => s.hook);

/** The 12 inert-handler hooks (category C, SPECS R3 normative list). */
export const INERT_HOOKS: readonly string[] = HOOK_INVENTORY.filter((s) => s.inert === true).map((s) => s.hook);

/** The 3 not-subscribed hooks (category D). */
export const UNSUBSCRIBED_HOOKS: readonly string[] = HOOK_INVENTORY.filter((s) => s.category === "D").map((s) => s.hook);
