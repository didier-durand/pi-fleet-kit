/**
 * pi-obs — semantic-convention registry (SPECS R4).
 *
 * The single add-only contract for every name pi-obs emits:
 *
 *   - span names       — the R3 hierarchy `pi.session` → `pi.run` →
 *                        `pi.turn` → { `pi.model`, `pi.tool <name>` }
 *   - span-event names — the R3 usage inventory's events on those spans
 *   - metric names     — the R4 metric table (counters + histograms)
 *   - attributes       — every `gen_ai.*` binding used (GenAI semconv)
 *                        and every `pi.*` custom attribute, each with
 *                        name, type, source hook, and meaning.
 *
 * The table IS the contract (R4): later steps emit only names registered
 * here; adding a name extends the table and never removes or renames one.
 * `mustLookupAttribute` fails closed — unknown names are an error in
 * tests; production callers use `lookupAttribute` and report the miss
 * via `reportUnknownAttribute` (logged once on stderr, never thrown — R1).
 *
 * Pure module: no pi imports, no I/O — unit-testable standalone.
 */

/** Value type of an emitted attribute. */
export type AttrType = "string" | "number" | "boolean";

/** One row of the attribute registry. */
export interface AttributeSpec {
	/** Dotted name, `gen_ai.*` or `pi.*`. */
	name: string;
	/** Value type carried on the wire. */
	type: AttrType;
	/** The pi hook that emits it (or `internal` / `resource` for
	 *  pi-obs's own bookkeeping and the OTel resource). */
	hook: string;
	/** Human meaning — the registry's documentation. */
	meaning: string;
}

/** One row of the metric registry. */
export interface MetricSpec {
	name: string;
	/** OTel instrument kind per the R4 metric table. */
	type: "counter" | "histogram";
	/** OTel unit (emitted on the wire and in the Weaver registry; R4). */
	unit: string;
	/** Attribute names the metric is broken down by (registered above). */
	attributes: string[];
	meaning: string;
}

/** One row of the span / span-event name registry. */
export interface EntityNameSpec {
	name: string;
	/** `span` = an OTel span; `event` = a span event on a named parent. */
	kind: "span" | "event";
	/** The pi hook that produces it, or `internal` for pi-obs's own. */
	hook: string;
	meaning: string;
}

/** Error thrown by the fail-closed lookups — never by production paths. */
export class SemconvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SemconvError";
	}
}

// The version is NOT defined here: package.json is the single source of
// truth (TypeScript/npm convention); src/version.ts derives it. Re-exported
// so the semconv module remains the import site for all consumers.
export { PI_OBS_VERSION } from "./version.ts";

/** Standard OTel resource attributes (R6: the resource is fixed apart
 *  from these). Not part of the `pi.*`/`gen_ai.*` namespaces; documented
 *  here so every emitted name is in one place. */
export const RESOURCE_ATTRIBUTES: readonly AttributeSpec[] = [
	{
		name: "service.name",
		type: "string",
		hook: "resource",
		meaning: "OTel service name — PI_OBS_RESOURCE_SERVICE, default `pi-agent`.",
	},
	{
		name: "service.version",
		type: "string",
		hook: "resource",
		meaning: "Extension version (PI_OBS_VERSION) reported on the resource.",
	},
];

/** GenAI semantic-convention attributes used on `pi.model` spans (R4). */
export const GENAI_ATTRIBUTES: readonly AttributeSpec[] = [
	{
		name: "gen_ai.system",
		type: "string",
		hook: "before_provider_request",
		meaning: "The pi provider name (the GenAI `system` the request went to).",
	},
	{
		name: "gen_ai.operation.name",
		type: "string",
		hook: "before_provider_request",
		meaning: "Operation name — always `generate_content` for model calls.",
	},
	{
		name: "gen_ai.request.model",
		type: "string",
		hook: "before_provider_request",
		meaning: "Model identifier as requested.",
	},
	{
		name: "gen_ai.response.model",
		type: "string",
		hook: "message_end",
		meaning: "Model identifier as served (when pi reports it).",
	},
	{
		name: "gen_ai.response.id",
		type: "string",
		hook: "message_end",
		meaning: "Provider response id, when pi provides one.",
	},
	{
		name: "gen_ai.usage.input_tokens",
		type: "number",
		hook: "message_end",
		meaning: "Input (prompt) token count of the model call.",
	},
	{
		name: "gen_ai.usage.output_tokens",
		type: "number",
		hook: "message_end",
		meaning: "Output (completion) token count of the model call.",
	},
	{
		name: "gen_ai.token.type",
		type: "string",
		hook: "message_end",
		meaning:
			"Token-type discriminator on token counters: input | output | cacheRead | cacheWrite | reasoning (cache-read and reasoning tokens are type-distinguished counters).",
	},
];

/**
 * The `pi.*` custom-attribute table (R4: name, type, hook, meaning) —
 * ADD-ONLY. Every attribute any step emits is registered here.
 */
export const PI_ATTRIBUTES: readonly AttributeSpec[] = [
	{
		name: "pi.session.id",
		type: "string",
		hook: "session_start",
		meaning: "pi session identifier; names the trace (one trace per session lifetime).",
	},
	{
		name: "pi.session.file",
		type: "string",
		hook: "session_start",
		meaning: "Path of the session's JSONL file (pi's canonical record).",
	},
	{
		name: "pi.session.reason",
		type: "string",
		hook: "session_start",
		meaning: "Why the session started: startup | reload | new | resume | fork.",
	},
	{
		name: "pi.cwd",
		type: "string",
		hook: "session_start",
		meaning: "Working directory at session start (identifies the workspace).",
	},
	{
		name: "pi.version",
		type: "string",
		hook: "resource",
		meaning: "pi-obs extension version as a `pi.*` identifying resource attribute.",
	},
	{
		name: "pi.turn.index",
		type: "number",
		hook: "turn_start",
		meaning: "Zero-based turn counter within the run.",
	},
	{
		name: "pi.hook",
		type: "string",
		hook: "internal",
		meaning: "The pi hook that emitted the entity — on handler-fault and health log records (R1).",
	},
	{
		name: "pi.cost.total",
		type: "number",
		hook: "message_end",
		meaning: "Cost of the model call in USD, from pi's own usage record (never computed by pi-obs).",
	},
	{
		name: "pi.stop_reason",
		type: "string",
		hook: "message_end",
		meaning: "Provider stop reason of the model call.",
	},
	{
		name: "pi.provider",
		type: "string",
		hook: "model_select",
		meaning: "pi provider name on model-change events (event-scoped mirror of gen_ai.system).",
	},
	{
		name: "pi.model.id",
		type: "string",
		hook: "model_select",
		meaning: "Model identifier on model-change events.",
	},
	{
		name: "pi.level",
		type: "string",
		hook: "thinking_level_select",
		meaning: "Thinking/reasoning level selected.",
	},
	{
		name: "pi.decision",
		type: "string",
		hook: "cache_warming_decision",
		meaning: "The cache-warming decision observed (never participated in — R3 category C).",
	},
	{
		name: "pi.status",
		type: "string",
		hook: "after_provider_response",
		meaning: "Provider/HTTP status of the response.",
	},
	{
		name: "pi.header.names",
		type: "string",
		hook: "before_provider_headers",
		meaning: "Header NAMES only, comma-joined (R2: values are never captured).",
	},
	{
		name: "pi.tool.name",
		type: "string",
		hook: "tool_execution_start",
		meaning: "Tool name (also carried in the `pi.tool <name>` span name suffix).",
	},
	{
		name: "pi.tool.path",
		type: "string",
		hook: "tool_call",
		meaning: "File path the tool acted on (R2: paths are the work being observed — captured).",
	},
	{
		name: "pi.tool.command",
		type: "string",
		hook: "user_bash",
		meaning: "Command line observed (user bash or tool invocation).",
	},
	{
		name: "pi.tool.input",
		type: "string",
		hook: "tool_call",
		meaning: "Tool input JSON — ONLY under PI_OBS_CAPTURE_TOOL_IO=1 (R2 opt-in, redacted before the queue).",
	},
	{
		name: "pi.tool.result",
		type: "string",
		hook: "tool_result",
		meaning: "Tool result body — ONLY under PI_OBS_CAPTURE_TOOL_IO=1 (R2 opt-in).",
	},
	{
		name: "pi.tool.is_error",
		type: "boolean",
		hook: "tool_result",
		meaning: "The tool result reported an error (span status `error`, R4).",
	},
	{
		name: "pi.outcome",
		type: "string",
		hook: "session_before_switch",
		meaning: "Outcome of the event (e.g. cancellation outcome on switch/fork, ok/failed on bash and tool calls).",
	},
	{
		name: "pi.reason",
		type: "string",
		hook: "session_before_compact",
		meaning: "Reason for the event (compaction, project trust, resource discovery).",
	},
	{
		name: "pi.target",
		type: "string",
		hook: "session_before_tree",
		meaning: "Tree navigation target (message/branch id).",
	},
	{
		name: "pi.summary",
		type: "boolean",
		hook: "session_tree",
		meaning: "Whether a summary entry is present at the navigation target.",
	},
	{
		name: "pi.tokens.before",
		type: "number",
		hook: "session_before_compact",
		meaning: "Token count before compaction.",
	},
	{
		name: "pi.source",
		type: "string",
		hook: "input",
		meaning: "Where the input came from: interactive | rpc | extension.",
	},
	{
		name: "pi.streaming",
		type: "boolean",
		hook: "input",
		meaning: "Whether the input was streamed (typed incrementally).",
	},
	{
		name: "pi.content.hash",
		type: "string",
		hook: "input",
		meaning: "Stable content hash — SHA-256, first 12 hex chars (R2 default in place of text).",
	},
	{
		name: "pi.content.length",
		type: "number",
		hook: "input",
		meaning: "Content character count (R2 default in place of text).",
	},
	{
		name: "pi.content.text",
		type: "string",
		hook: "input",
		meaning: "Verbatim prompt/completion text — ONLY under PI_OBS_CAPTURE_PROMPTS=1 (R2 opt-in).",
	},
	{
		name: "pi.kind",
		type: "string",
		hook: "ui_prompt_start",
		meaning: "UI prompt kind on `pi.ui.prompt` events.",
	},
	{
		name: "pi.duration.ms",
		type: "number",
		hook: "ui_prompt_end",
		meaning: "Duration in milliseconds (UI prompt, and any timed event).",
	},
	{
		name: "pi.messages.in",
		type: "number",
		hook: "context",
		meaning: "Messages entering the context assembly.",
	},
	{
		name: "pi.messages.out",
		type: "number",
		hook: "context",
		meaning: "Messages leaving the context assembly.",
	},
	{
		name: "pi.role",
		type: "string",
		hook: "message_update",
		meaning: "Message role — the attribute the `pi.messages` counter is broken down by.",
	},
	{
		name: "pi.token.type",
		type: "string",
		hook: "message_end",
		meaning: "Token-type discriminator on the `pi.tokens` counter: input | output | cacheRead | cacheWrite | reasoning.",
	},
	{
		name: "pi.aborted",
		type: "boolean",
		hook: "agent_settled",
		meaning: "The run ended aborted (flag at settle).",
	},
	{
		name: "pi.replayed",
		type: "boolean",
		hook: "resource",
		meaning: "R3b: true on the resource of a replayed post-mortem report — marks the trace as offline-replayed, not live-captured. (Renamed from \"pi.replay\" by the Step 9 Weaver conformance check: an attribute may not also be a namespace prefix.)",
	},
	{
		name: "pi.replay.source",
		type: "string",
		hook: "internal",
		meaning: "R3b replay provenance — the session id or file path the report was replayed from.",
	},
	{
		name: "pi.exporter.name",
		type: "string",
		hook: "internal",
		meaning: "Exporter a health/drop log record is about: otlp | file.",
	},
	{
		name: "pi.dropped.count",
		type: "number",
		hook: "internal",
		meaning: "Dropped-telemetry count (queue overflow, failed batches) on drop notices (R5).",
	},
];

/** Span names — the R3 hierarchy. `pi.tool <name>` carries the tool name suffix. */
export const SPAN_NAMES: readonly EntityNameSpec[] = [
	{
		name: "pi.session",
		kind: "span",
		hook: "session_start",
		meaning: "Root span of a session's single trace; opened at session_start, closed at session_shutdown.",
	},
	{
		name: "pi.run",
		kind: "span",
		hook: "before_agent_start",
		meaning: "One agent run — child of pi.session; aborted flag recorded at settle.",
	},
	{
		name: "pi.turn",
		kind: "span",
		hook: "turn_start",
		meaning: "One user turn — child of pi.run; start/end at turn_start / turn_end.",
	},
	{
		name: "pi.model",
		kind: "span",
		hook: "before_provider_request",
		meaning: "One model call — child of pi.turn, carrying the GenAI semconv attributes; ends at message_end.",
	},
	{
		name: "pi.tool",
		kind: "span",
		hook: "tool_execution_start",
		meaning: "One tool execution — child of pi.turn; the span NAME carries the ` <toolname>` suffix.",
	},
];

/** Span-event names — the R3 usage inventory's events, each on its parent span. */
export const EVENT_NAMES: readonly EntityNameSpec[] = [
	{ name: "pi.session.renamed", kind: "event", hook: "session_info_changed", meaning: "Session title/identity changed." },
	{ name: "pi.session.switch", kind: "event", hook: "session_before_switch", meaning: "Session switch, with cancellation outcome." },
	{ name: "pi.session.fork", kind: "event", hook: "session_before_fork", meaning: "Session fork, with cancellation outcome." },
	{ name: "pi.session.compact", kind: "event", hook: "session_before_compact", meaning: "Compaction — reason, outcome, tokens before." },
	{ name: "pi.session.tree", kind: "event", hook: "session_before_tree", meaning: "Tree navigation — target, summary presence." },
	{ name: "pi.resources", kind: "event", hook: "project_trust", meaning: "Project trust / resource discovery (reason)." },
	{ name: "pi.user.input", kind: "event", hook: "input", meaning: "User input — source, streaming, length, hash; text per R2." },
	{ name: "pi.user.bash", kind: "event", hook: "user_bash", meaning: "User bash command — command line, outcome." },
	{ name: "pi.ui.prompt", kind: "event", hook: "ui_prompt_start", meaning: "UI prompt — kind, duration." },
	{ name: "pi.model.headers", kind: "event", hook: "before_provider_headers", meaning: "Provider request header NAMES only (R2)." },
	{ name: "pi.model.response_status", kind: "event", hook: "after_provider_response", meaning: "Provider response status." },
	{ name: "pi.session.model_change", kind: "event", hook: "model_select", meaning: "Model change — provider, model id (parity with session model_change entries)." },
	{ name: "pi.session.thinking_level_change", kind: "event", hook: "thinking_level_select", meaning: "Thinking-level change (parity with session entries)." },
	{ name: "pi.model.cache_warming", kind: "event", hook: "cache_warming_decision", meaning: "Cache-warming decision observed." },
	{ name: "pi.context", kind: "event", hook: "context", meaning: "Context assembly — message count in/out (read-only)." },
	{ name: "pi.tool.outcome", kind: "event", hook: "tool_call", meaning: "Tool-call observation — blocked/mutated outcome." },
	{ name: "pi.run.aborted", kind: "event", hook: "agent_settled", meaning: "The run settled as aborted." },
];

/** The R4 metric table. Counters and histograms, OTel data model. */
export const METRICS: readonly MetricSpec[] = [
	{ name: "pi.model.requests", type: "counter", unit: "{request}", attributes: [], meaning: "Model calls issued." },
	{ name: "pi.tokens", type: "counter", unit: "{token}", attributes: ["pi.token.type"], meaning: "Tokens consumed, by token type." },
	{ name: "pi.cost.total", type: "counter", unit: "$", attributes: [], meaning: "Total cost in USD (sum of message usage cost)." },
	{ name: "pi.tool.calls", type: "counter", unit: "{call}", attributes: ["pi.tool.name"], meaning: "Tool calls, by tool name." },
	{ name: "pi.messages", type: "counter", unit: "{message}", attributes: ["pi.role"], meaning: "Messages, by role (delta counters on message_update)." },
	{ name: "pi.tool.updates", type: "counter", unit: "{update}", attributes: ["pi.tool.name"], meaning: "Streaming tool-execution updates (message_update's twin for tools)." },
	{ name: "pi.model.duration", type: "histogram", unit: "ms", attributes: [], meaning: "Model-call duration." },
	{ name: "pi.model.time_to_first_token", type: "histogram", unit: "ms", attributes: [], meaning: "Request start → first streaming delta." },
	{ name: "pi.turn.duration", type: "histogram", unit: "ms", attributes: [], meaning: "Turn duration." },
	{ name: "pi.tool.duration", type: "histogram", unit: "ms", attributes: ["pi.tool.name"], meaning: "Tool execution duration, by tool name." },
];

/** All registered attribute specs (GenAI + pi.* + resource), in table order. */
export const ALL_ATTRIBUTES: readonly AttributeSpec[] = [
	...GENAI_ATTRIBUTES,
	...PI_ATTRIBUTES,
	...RESOURCE_ATTRIBUTES,
];

const attributeIndex = new Map<string, AttributeSpec>(ALL_ATTRIBUTES.map((spec) => [spec.name, spec]));
const metricIndex = new Map<string, MetricSpec>(METRICS.map((spec) => [spec.name, spec]));
const entityIndex = new Map<string, EntityNameSpec>(
	[...SPAN_NAMES, ...EVENT_NAMES].map((spec) => [spec.name, spec] as const),
);

/** Every name the extension may emit, any table (the completeness contract). */
export const ALL_NAMES: ReadonlySet<string> = new Set<string>([
	...attributeIndex.keys(),
	...metricIndex.keys(),
	...entityIndex.keys(),
]);

/** Look up an attribute by name; `undefined` when unregistered. */
export function lookupAttribute(name: string): AttributeSpec | undefined {
	return attributeIndex.get(name);
}

/** Fail-closed lookup (tests, strict validation): unknown → SemconvError. */
export function mustLookupAttribute(name: string): AttributeSpec {
	const spec = attributeIndex.get(name);
	if (!spec) throw new SemconvError(`unknown attribute "${name}" — extend the semconv table (R4: add-only)`);
	return spec;
}

/** Look up a metric by name; `undefined` when unregistered. */
export function lookupMetric(name: string): MetricSpec | undefined {
	return metricIndex.get(name);
}

/** Fail-closed metric lookup: unknown → SemconvError. */
export function mustLookupMetric(name: string): MetricSpec {
	const spec = metricIndex.get(name);
	if (!spec) throw new SemconvError(`unknown metric "${name}" — extend the semconv table (R4: add-only)`);
	return spec;
}

/** Look up a span or span-event name; `undefined` when unregistered. */
export function lookupEntity(name: string): EntityNameSpec | undefined {
	return entityIndex.get(name);
}

/**
 * One-line diagnostic for an unregistered name — the production twin of
 * the thrown error: callers log this once on stderr and drop the value
 * (fail closed without failing the agent, R1).
 */
export function reportUnknownAttribute(name: string): string {
	return `pi-obs semconv: attribute "${name}" is not in the registry — value dropped (R4 add-only table)`;
}
