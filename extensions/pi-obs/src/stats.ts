/**
 * pi-obs — session statistics library.
 *
 * Derives observability data (token usage, cost, models, durations) from
 * pi session entries. Pure computation, no pi imports — usable standalone,
 * e.g. by pi-serve/picl or ad-hoc scripts.
 *
 * Input is any iterable of entry-shaped objects as found in pi session
 * JSONL files (see pi's session-format documentation):
 *
 *   - assistant messages carry `message.usage` (tokens + cost) and the
 *     `provider`/`model` that produced them — each one is a "turn";
 *   - `usage`-type entries record model-attributed usage that is not an
 *     assistant message (e.g. cache warming) — they add to totals and to
 *     the model they name, but count no turns;
 *   - user / tool-result messages are counted but carry no usage.
 *
 * Nothing here mutates or writes anything: observation only.
 */

/** The `usage` object as carried by assistant messages and usage entries. */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

/** Summed token counters. */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
}

/** Per-model totals, one per distinct provider/model pair used. */
export interface ModelTotals {
	provider: string;
	model: string;
	/** Assistant-message turns attributed to this model. */
	turns: number;
	usage: UsageTotals;
	cost: number;
}

/** Observability summary of one session (or one branch of it). */
export interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	usage: UsageTotals;
	cost: number;
	/** Distinct models, most expensive first. */
	models: ModelTotals[];
	firstTimestamp: string | null;
	lastTimestamp: string | null;
	durationMs: number | null;
}

/** A minimal view of a session entry — enough to observe it. */
export interface EntryLike {
	type?: string;
	timestamp?: string;
	kind?: string;
	provider?: string;
	model?: string;
	usage?: UsageLike;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		usage?: UsageLike;
	} | null;
}

const zeroUsage = (): UsageTotals => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	totalTokens: 0,
});

/** Add a usage record into a totals counter (missing fields count as 0). */
function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.reasoning += usage.reasoning ?? 0;
	totals.totalTokens +=
		usage.totalTokens ??
		(usage.input ?? 0) +
			(usage.output ?? 0) +
			(usage.cacheRead ?? 0) +
			(usage.cacheWrite ?? 0) +
			(usage.reasoning ?? 0);
}

function costOf(usage: UsageLike | undefined): number {
	return usage?.cost?.total ?? 0;
}

/**
 * Compute the observability summary of an entry sequence (typically a
 * session branch: `ctx.sessionManager.getBranch()`, or the parsed lines of
 * a session JSONL file).
 */
export function computeStats(entries: Iterable<EntryLike>): SessionStats {
	const stats: SessionStats = {
		userMessages: 0,
		assistantMessages: 0,
		toolResults: 0,
		usage: zeroUsage(),
		cost: 0,
		models: [],
		firstTimestamp: null,
		lastTimestamp: null,
		durationMs: null,
	};
	const modelIndex = new Map<string, ModelTotals>();

	const modelTotals = (provider: string, model: string): ModelTotals => {
		const key = `${provider}/${model}`;
		let totals = modelIndex.get(key);
		if (!totals) {
			totals = { provider, model, turns: 0, usage: zeroUsage(), cost: 0 };
			modelIndex.set(key, totals);
		}
		return totals;
	};

	for (const entry of entries) {
		if (entry.timestamp) {
			if (!stats.firstTimestamp) stats.firstTimestamp = entry.timestamp;
			stats.lastTimestamp = entry.timestamp;
		}

		if (entry.type === "message") {
			const message = entry.message;
			if (!message) continue;
			if (message.role === "user") {
				stats.userMessages++;
			} else if (message.role === "assistant") {
				stats.assistantMessages++;
				const totals = modelTotals(message.provider ?? "unknown", message.model ?? "unknown");
				totals.turns++;
				addUsage(totals.usage, message.usage);
				addUsage(stats.usage, message.usage);
				const cost = costOf(message.usage);
				totals.cost += cost;
				stats.cost += cost;
			} else if (message.role === "toolResult") {
				stats.toolResults++;
			}
		} else if (entry.type === "usage") {
			// Model-attributed usage that is not an assistant message.
			const totals = modelTotals(entry.provider ?? "unknown", entry.model ?? "unknown");
			addUsage(totals.usage, entry.usage);
			addUsage(stats.usage, entry.usage);
			const cost = costOf(entry.usage);
			totals.cost += cost;
			stats.cost += cost;
		}
	}

	stats.models = [...modelIndex.values()].sort((a, b) => b.cost - a.cost || b.turns - a.turns);
	if (stats.firstTimestamp && stats.lastTimestamp) {
		stats.durationMs = Math.max(0, Date.parse(stats.lastTimestamp) - Date.parse(stats.firstTimestamp));
	}
	return stats;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact token count: `942`, `12.3k`, `1.24M`. */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Compact cost: `$0`, `<$0.0001`, `$0.0015`, `$0.42`. */
export function formatCost(n: number): string {
	if (n <= 0) return "$0";
	if (n < 0.0001) return "<$0.0001";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/** Compact duration: `42s`, `18m 32s`, `2h 04m`. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Human report lines for one session's stats. */
export function reportSession(stats: SessionStats): string[] {
	const lines: string[] = [
		`messages: ${stats.userMessages + stats.assistantMessages + stats.toolResults} (user ${stats.userMessages} · assistant ${stats.assistantMessages} · tool results ${stats.toolResults})`,
		`duration: ${stats.durationMs !== null ? formatDuration(stats.durationMs) : "—"}`,
		`tokens: ${formatTokens(stats.usage.totalTokens)} (in ${formatTokens(stats.usage.input)} · out ${formatTokens(stats.usage.output)} · cache read ${formatTokens(stats.usage.cacheRead)} · reasoning ${formatTokens(stats.usage.reasoning)})`,
		`cost: ${formatCost(stats.cost)}`,
	];
	if (stats.models.length > 0) {
		lines.push(
			`models: ${stats.models
				.map(
					(m) =>
						`${m.provider}/${m.model} (${m.turns} turn${m.turns === 1 ? "" : "s"}, ${formatCost(m.cost)})`,
				)
				.join(", ")}`,
		);
	}
	return lines;
}
