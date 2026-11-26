/**
 * prompt-trigger — mailbox envelope (SPECS v1.1.0 R9).
 *
 * Every mailbox message is a JSON envelope with exactly these fields
 * (aligned with the fleet's agent-to-agent mailbox architecture,
 * pi-mailbox-arch.json level 1):
 *
 *   id             unique message id: msg-<ts>-<pid>
 *   from           sender agent id
 *   to             recipient agent id
 *   type           request | reply | error
 *   correlation_id echoes the request id on replies (null on requests)
 *   created        ISO timestamp
 *   body           the prompt text
 *   attempts       retry counter (maintained by the extension)
 *
 * Fail-closed: an envelope that does not validate parses to `undefined` —
 * the extension moves it to failed/ with the parse error recorded; it is
 * never consumed, never silently dropped. Agents never hand-craft JSON:
 * send.sh builds envelopes; this module builds replies.
 */

export type EnvelopeType = "request" | "reply" | "error";

export interface Envelope {
	id: string;
	from: string;
	to: string;
	type: EnvelopeType;
	correlation_id: string | null;
	created: string;
	body: string;
	attempts: number;
}

const ENVELOPE_TYPES: readonly EnvelopeType[] = ["request", "reply", "error"];

/** Mint a unique message id: msg-<epoch-ms>-<pid>. */
export function newEnvelopeId(nowMs = Date.now(), pid = process.pid): string {
	return `msg-${nowMs}-${pid}`;
}

/** A field is a usable string: non-empty after trim. */
function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Parse one raw file content as an envelope — fail-closed: `undefined`
 * on ANY violation (not JSON, missing/empty fields, unknown type,
 * negative attempts, reply without correlation_id). The error reason is
 * reported via the optional callback for the failed/ ledger note.
 */
export function parseEnvelope(
	raw: string,
	onError?: (reason: string) => void,
): Envelope | undefined {
	const bad = (reason: string): undefined => {
		onError?.(reason);
		return undefined;
	};
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return bad(`not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return bad("envelope must be a JSON object");
	}
	const d = doc as Record<string, unknown>;
	const id = str(d.id);
	if (!id) return bad("missing or empty id");
	const from = str(d.from);
	if (!from) return bad("missing or empty from");
	const to = str(d.to);
	if (!to) return bad("missing or empty to");
	const type = str(d.type) as EnvelopeType | undefined;
	if (!type || !ENVELOPE_TYPES.includes(type)) {
		return bad(`type must be one of ${ENVELOPE_TYPES.join("|")}, got ${JSON.stringify(d.type)}`);
	}
	const correlation: string | null = d.correlation_id === null || d.correlation_id === undefined ? null : str(d.correlation_id) ?? null;
	if (d.correlation_id !== null && d.correlation_id !== undefined && correlation === null) {
		return bad("correlation_id present but not a usable string");
	}
	if (correlation === null && type !== "request") {
		return bad(`${type} requires a correlation_id`);
	}
	if (correlation !== null && type === "request") {
		return bad("a request carries no correlation_id (replies echo it)");
	}
	const created = str(d.created);
	if (!created) return bad("missing or empty created");
	if (Number.isNaN(Date.parse(created))) return bad(`created is not an ISO timestamp: ${JSON.stringify(d.created)}`);
	const body = typeof d.body === "string" ? d.body : undefined;
	if (body === undefined || body.trim() === "") return bad("missing or empty body");
	const attemptsRaw = d.attempts ?? 0;
	const attempts = typeof attemptsRaw === "number" && Number.isInteger(attemptsRaw) && attemptsRaw >= 0 ? attemptsRaw : undefined;
	if (attempts === undefined) return bad("attempts must be a non-negative integer");
	return { id, from, to, type, correlation_id: correlation, created, body, attempts };
}

/** Build a reply (or error) envelope answering a request. */
export function buildReply(
	request: Envelope,
	from: string,
	body: string,
	type: EnvelopeType = "reply",
	nowMs = Date.now(),
	pid = process.pid,
): Envelope {
	return {
		id: newEnvelopeId(nowMs, pid),
		from,
		to: request.from,
		type,
		correlation_id: request.id,
		created: new Date(nowMs).toISOString(),
		body,
		attempts: 0,
	};
}

/** Serialize an envelope for the wire (single JSON line). */
export function serializeEnvelope(e: Envelope): string {
	return JSON.stringify(e);
}

/** Extract readable text from a pi message content field (string or array of typed blocks). */
export function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	if (Array.isArray(content)) {
		const texts = content
			.filter((b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
			.map((b) => (b as { text: string }).text);
		return texts.length ? texts.join("\n") : undefined;
	}
	return undefined;
}
