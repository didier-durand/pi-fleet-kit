/**
 * prompt-trigger extension — file-triggered prompts + agent mailbox
 * (SPECS v1.1.0: R1–R8 shipped in v0.1.0; R9–R12 the mailbox protocol).
 *
 * Two consumption passes per tick, over one watched directory
 * (PI_TRIGGER_DIR, mounted as /exchange):
 *
 * 1. MAILBOX pass (R9–R12): `inbox/` holds JSON envelopes
 *    (id, from, to, type request|reply|error, correlation_id, created,
 *    body, attempts — built by send.sh, never hand-crafted). Processing:
 *      ledger check (at-most-once) → atomic claim (mv inbox → working)
 *      → fail-closed parse (malformed → failed/) → deliver the body
 *      (as a user prompt, followUp-queued when busy) → reply on settle
 *      (type reply, correlation_id echoed, body = the turn's final
 *      assistant text, written ATOMICALLY to the sender's inbox).
 *      Completion: working → processed. Failure: working → failed
 *      (MAX_ATTEMPTS via the envelope's attempts counter).
 *
 * 2. LEGACY pass (R3–R8, unchanged): raw (non-envelope) files in the
 *    exchange ROOT are plain prompts — stability window, directives
 *    (/new [kickoff]), consumed by deletion. The transition rule of R9:
 *    root = legacy prompts, inbox/ = envelopes.
 *
 * Idle cost: a readdir + stat per file every poll interval — zero tokens.
 * Tokens are consumed only when a prompt (or reply) is actually delivered.
 *
 * Config: PI_TRIGGER_DIR (in-container path). Unset → extension dormant.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildReply,
	contentText,
	newEnvelopeId,
	parseEnvelope,
	serializeEnvelope,
	type Envelope,
	type EnvelopeType,
} from "./src/envelope.ts";

const POLL_MS = 1500;          // poll interval (token-free idle)
const STABILITY_MS = 500;      // file must be this old + unchanged to be consumed
const MAX_FILES_PER_TICK = 5;  // cap per tick (observation cap): keeps turns sequential
const MAX_ATTEMPTS = 3;        // delivery attempts before failed/ (envelope attempts counter)
const PROCESSED_KEEP = 100;    // processed/ retention: keep the last N handled messages

interface PendingFile {
	file: string;
	size: number;
	mtimeMs: number;
	seenAt: number; // first poll tick where this size/mtime was observed
}

/** Move a file atomically within the exchange filesystem; false when lost. */
function moveTo(from: string, to: string): boolean {
	try {
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let dir: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	let busy = false; // streaming in progress
	let lastTickAt = 0;
	const pending = new Map<string, PendingFile>(); // legacy pass: path -> observation

	// mailbox state
	let ledgerIds = new Set<string>();       // handled message ids (R11: at-most-once)
	const workingReplies = new Map<string, Envelope>(); // working/<file>.json -> request envelope (reply on settle)
	let selfId = "";                          // this agent's exchange dir name
	let sessionId = "";                       // this agent's pi session id (envelope identity + replies)

	/** Publish this session's identity for send.sh (R13): a dotfile in the
	 *  exchange ROOT — invisible to the legacy prompt pass (dotfiles are
	 *  never consumed). Atomic; best-effort (R1: a failed write only costs
	 *  the sender identity, reported by send.sh as a loud, fail-closed error). */
	function publishSenderIdentity(d: string): void {
		try {
			const tmp = path.join(d, ".sender.tmp");
			fs.writeFileSync(tmp, JSON.stringify({ session_id: sessionId }));
			fs.renameSync(tmp, path.join(d, ".sender"));
		} catch { /* identity publication is best-effort */ }
	}

	// --- ledger (R11) ---------------------------------------------------------

	const ledgerPath = (d: string): string => path.join(d, "ledger.ndjson");

	function loadLedger(d: string): void {
		ledgerIds = new Set();
		try {
			for (const line of fs.readFileSync(ledgerPath(d), "utf-8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const doc = JSON.parse(line) as { id?: unknown };
					if (typeof doc.id === "string") ledgerIds.add(doc.id);
				} catch { /* one bad ledger line never breaks the load (R1) */ }
			}
		} catch { /* no ledger yet — empty set */ }
	}

	function ledgerAppend(d: string, id: string, note: string): void {
		try {
			fs.appendFileSync(ledgerPath(d), `${JSON.stringify({ id, at: new Date().toISOString(), note })}\n`);
			ledgerIds.add(id);
		} catch { /* ledger write failures never block the agent (R1) */ }
	}

	// --- maildir layout (R10) ---------------------------------------------------

	function setupMaildir(d: string): void {
		for (const sub of ["inbox", "working", "pending", "processed", "failed"]) {
			try {
				fs.mkdirSync(path.join(d, sub), { recursive: true });
			} catch { /* existing dir or unwritable: dormant-safe (R1) */ }
		}
	}

	/** processed/ retention: keep the last PROCESSED_KEEP files (by name/time). */
	function pruneProcessed(d: string): void {
		const processed = path.join(d, "processed");
		let names: string[] = [];
		try {
			names = fs.readdirSync(processed).filter((n) => !n.startsWith(".")).sort();
		} catch {
			return;
		}
		const excess = names.length - PROCESSED_KEEP;
		for (let i = 0; i < excess; i++) {
			try { fs.unlinkSync(path.join(processed, names[i])); } catch { /* gone is fine */ }
		}
	}

	/** R10 crash recovery: replay claimed-but-unfinished work/ at startup. */
	function recoverWorking(pi: ExtensionAPI, ctx: ExtensionContext, d: string): void {
		const working = path.join(d, "working");
		let names: string[] = [];
		try {
			names = fs.readdirSync(working).filter((n) => !n.startsWith("."));
		} catch {
			return;
		}
		for (const name of names) {
			const claimed = path.join(working, name);
			const id = name.replace(/\.json$/, "");
			if (ledgerIds.has(id)) {
				// the work was done (delivered + ledgered) but the crash lost the
				// reply: answer the sender with an error reply — never re-deliver
				// (at-most-once work, R11).
				const env = parseEnvelope(safeRead(claimed));
				if (env && env.type === "request") {
					writeReply(d, selfId, env, `processing was interrupted by a restart; the result was lost — please resend the request`, "error");
				}
				moveTo(claimed, path.join(d, "processed", name));
				continue;
			}
			// un-ledgered: the claim happened but delivery never did — re-deliver
			// (the file is already claimed; process it on the next tick via the
			// working scan)
		}
	}

	// --- delivery + replies ---------------------------------------------------

	function finalAssistantText(ctx: ExtensionContext): string | undefined {
		try {
			const branch = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager?.getBranch?.() ?? [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as { message?: { role?: unknown; content?: unknown } } | undefined;
				if (entry?.message?.role === "assistant") {
					return contentText(entry.message.content);
				}
			}
		} catch { /* no branch/session access: no reply body (R1) */ }
		return undefined;
	}

	/** R12: write a reply/error envelope to the sender's inbox (atomic). */
	function writeReply(d: string, self: string, request: Envelope, body: string, type: EnvelopeType = "reply"): boolean {
		const reply = buildReply(request, self || request.to, body, type, Date.now(), process.pid, sessionId);
		const senderInbox = path.join(d, "..", request.from, "inbox");
		if (!fs.existsSync(senderInbox)) return false;
		const tmp = path.join(senderInbox, `.tmp-${reply.id}`);
		try {
			fs.writeFileSync(tmp, serializeEnvelope(reply));
			fs.renameSync(tmp, path.join(senderInbox, `${reply.id}.json`));
			return true;
		} catch {
			try { fs.unlinkSync(tmp); } catch { /* already gone */ }
			return false;
		}
	}

	/** R10/R12 completion: reply written → processed; unreachable → failed + ledger note. */
	function settleReply(pi: ExtensionAPI, d: string, self: string, claimed: string, request: Envelope, answer: string | undefined): void {
		if (answer === undefined || answer === "") {
			// no answer text (turn produced nothing usable): error reply, retry logic applies
			if (request.attempts + 1 >= MAX_ATTEMPTS) {
				writeReply(d, self, request, `no answer was produced after ${request.attempts + 1} attempts`, "error");
				moveTo(claimed, path.join(d, "failed", path.basename(claimed)));
				ledgerAppend(d, request.id, "failed: no answer after max attempts");
			} else {
				requeueOrFail(d, claimed, { ...request, attempts: request.attempts + 1 });
			}
			return;
		}
		const sent = writeReply(d, self, request, answer);
		if (sent) {
			moveTo(claimed, path.join(d, "processed", path.basename(claimed)));
			ledgerAppend(d, request.id, "handled: reply sent");
		} else {
			// sender unreachable: nowhere to deliver the answer — failed + ledger note
			moveTo(claimed, path.join(d, "failed", path.basename(claimed)));
			ledgerAppend(d, request.id, `failed: sender inbox unreachable (${request.from})`);
		}
	}

	/** R10: delivery failed — re-queue with attempts+1, or give up in failed/. */
	function requeueOrFail(d: string, claimed: string, env: Envelope): void {
		if (env.attempts + 1 >= MAX_ATTEMPTS) {
			writeReply(d, selfId, env, `delivery failed after ${MAX_ATTEMPTS} attempts`, "error");
			moveTo(claimed, path.join(d, "failed", path.basename(claimed)));
			ledgerAppend(d, env.id, `failed: delivery failed after max attempts`);
			return;
		}
		// back to the inbox with the incremented counter (fresh stability cycle)
		const dst = path.join(d, "inbox", path.basename(claimed));
		if (moveTo(claimed, dst)) {
			try {
				fs.writeFileSync(dst, serializeEnvelope(env));
			} catch { /* the file moved with the old attempts — next cycle recounts */ }
		}
	}

	/** Process one claimed envelope: deliver + schedule the reply. */
	function processEnvelope(pi: ExtensionAPI, ctx: ExtensionContext, d: string, claimed: string, env: Envelope): void {
		const deliver = (text: string): void => {
			try {
				queueOrSend(pi, text);
				ledgerAppend(d, env.id, env.type === "request" ? "delivered: awaiting reply" : `delivered: ${env.type}`);
				// distributed traces: record the delivery in the session so pi-obs
				// links the receiver's spans back to the sender's trace (R13)
				try {
					pi.appendEntry("mailbox", {
						id: env.id,
						from: env.from,
						to: env.to,
						type: env.type,
						correlation_id: env.correlation_id,
						session_id: env.session_id,
					});
				} catch { /* telemetry bookkeeping must never block a delivery (R1) */ }
				if (env.type === "request") workingReplies.set(claimed, env);
				else moveTo(claimed, path.join(d, "processed", path.basename(claimed)));
			} catch {
				requeueOrFail(d, claimed, { ...env, attempts: env.attempts + 1 });
			}
		};
		// directives apply to the body, same as legacy (R5)
		if (env.body === "/new" || env.body.startsWith("/new ")) {
			const kickoff = env.body === "/new" ? "" : env.body.slice("/new ".length).trim();
			void (async () => {
				try {
					await (ctx as ExtensionCommandContext).newSession({});
					if (ctx.hasUI) ctx.ui.notify(`[prompt-trigger] fresh session started (mailbox ${env.id})`, "info");
					if (kickoff) deliver(kickoff);
					else {
						moveTo(claimed, path.join(d, "processed", path.basename(claimed)));
						ledgerAppend(d, env.id, "handled: fresh session started");
					}
				} catch (err) {
					if (ctx.hasUI) ctx.ui.notify(`[prompt-trigger] /new failed: ${String(err)}`, "error");
					requeueOrFail(d, claimed, { ...env, attempts: env.attempts + 1 });
				}
			})();
			return;
		}
		deliver(env.body);
	}

	// --- mailbox pass (R9–R12) -------------------------------------------------

	function mailboxPass(pi: ExtensionAPI, ctx: ExtensionContext, d: string): void {
		const inbox = path.join(d, "inbox");
		let names: string[] = [];
		try {
			names = fs.readdirSync(inbox).filter((n) => !n.startsWith("."));
		} catch {
			return; // no inbox (legacy setup): nothing to do
		}
		for (const name of names.sort()) {
			const full = path.join(inbox, name);
			const claimed = path.join(d, "working", name);
			// atomic claim (R10): mv inbox → working — one consumer wins
			if (!moveTo(full, claimed)) continue;
			const id = name.replace(/\.json$/, "");
			// at-most-once (R11): an already-handled id goes straight to processed
			if (ledgerIds.has(id)) {
				moveTo(claimed, path.join(d, "processed", name));
				continue;
			}
			const env = parseEnvelope(safeRead(claimed), (reason) => {
				ledgerAppend(d, id, `malformed envelope: ${reason}`);
			});
			if (!env) {
				moveTo(claimed, path.join(d, "failed", name));
				continue;
			}
			processEnvelope(pi, ctx, d, claimed, env);
		}
	}

	function safeRead(file: string): string {
		try {
			return fs.readFileSync(file, "utf-8");
		} catch {
			return "";
		}
	}

	// --- legacy pass (R3–R8, v0.1.0 behavior) ---------------------------------

	function consume(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		file: string,
	): void {
		let content = "";
		try {
			content = fs.readFileSync(file, "utf-8").trim();
		} catch {
			return; // vanished between scan and read: next tick moves on
		}
		if (!content) {
			tryDelete(file);
			return;
		}

		// Directive: /new [kickoff] — fresh session, token-free, no model call.
		if (content === "/new" || content.startsWith("/new ")) {
			const kickoff = content === "/new" ? "" : content.slice("/new ".length).trim();
			void (async () => {
				try {
					await (ctx as ExtensionCommandContext).newSession({});
					if (ctx.hasUI) ctx.ui.notify(`[prompt-trigger] fresh session started`, "info");
					if (kickoff) queueOrSend(pi, kickoff);
				} catch (err) {
					if (ctx.hasUI) ctx.ui.notify(`[prompt-trigger] /new failed: ${String(err)}`, "error");
				}
			})();
			tryDelete(file);
			return;
		}

		// Regular prompt: visible in the TUI as if typed by the user.
		queueOrSend(pi, content);
		tryDelete(file);
	}

	function queueOrSend(pi: ExtensionAPI, content: string): void {
		if (busy) {
			// Mid-run: queue the prompt after the current work (never interrupt).
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(content);
		}
	}

	function tryDelete(file: string): void {
		try {
			fs.unlinkSync(file);
		} catch {
			/* consumed concurrently or already gone */
		}
	}

	// --- tick: mailbox pass + legacy pass --------------------------------------

	function tick(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (!dir) return;
		const now = Date.now();

		mailboxPass(pi, ctx, dir);

		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return; // dir missing (e.g. volume not mounted): stay dormant
		}

		// Observe current state of candidate files (hidden/temp files skipped).
		const seen = new Set<string>();
		let candidates = 0;
		for (const name of names.sort()) {
			if (name.startsWith(".")) continue; // dotfiles are never prompts
			if (name === "inbox" || name === "working" || name === "pending" || name === "processed" || name === "failed" || name === "ledger.ndjson") continue; // maildir structure
			const full = path.join(dir, name);
			let st: fs.Stats;
			try {
				st = fs.statSync(full);
			} catch {
				pending.delete(full); // deleted since last tick
				continue;
			}
			if (!st.isFile()) continue;
			seen.add(full);
			candidates++;
			const prev = pending.get(full);
			if (
				prev &&
				prev.size === st.size &&
				prev.mtimeMs === st.mtimeMs
			) {
				// Unchanged across two consecutive ticks: stable if old enough.
				if (now - prev.seenAt >= STABILITY_MS && now - st.mtimeMs >= STABILITY_MS) {
					consume(pi, ctx, full);
					pending.delete(full);
				}
			} else {
				// First sighting (or still changing): remember, wait for stability.
				if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
					pending.set(full, {
						file: full,
						size: st.size,
						mtimeMs: st.mtimeMs,
						seenAt: prev ? now : now,
					});
				}
				// Cap: at most MAX_FILES_PER_TICK prompts observed per tick.
				if (candidates > MAX_FILES_PER_TICK) break;
			}
		}

		// Forget observations for files that disappeared.
		for (const key of pending.keys()) {
			if (!seen.has(key)) pending.delete(key);
		}
		lastTickAt = now;
	}

	// --- wiring ----------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		dir = process.env.PI_TRIGGER_DIR;
		if (!dir) return; // dormant: no trigger dir configured for this agent
		selfId = path.basename(dir);
		sessionId = String((ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager?.getSessionId?.() ?? "unknown");
		publishSenderIdentity(dir); // distributed traces: send.sh reads this for envelope session_id
		setupMaildir(dir);
		loadLedger(dir);
		pruneProcessed(dir);
		recoverWorking(pi, ctx, dir);
		if (timer) clearInterval(timer);
		timer = setInterval(() => tick(pi, ctx), POLL_MS);
		if (ctx.hasUI) {
			ctx.ui.notify(`[prompt-trigger] watching ${dir} (poll ${POLL_MS}ms, mailbox active, self=${selfId})`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	// Busy tracking: mid-run prompts queue as followUp instead of interrupting.
	pi.on("agent_start", async () => {
		busy = true;
	});
	pi.on("agent_end", async (_event, ctx) => {
		busy = false;
		// R12: the turn settled — write the reply for every pending request
		// (the answer is the turn's final assistant text).
		if (workingReplies.size === 0 || !dir) return;
		const answer = finalAssistantText(ctx);
		for (const [claimed, env] of [...workingReplies]) {
			workingReplies.delete(claimed);
			settleReply(pi, dir, selfId, claimed, env, answer ?? undefined);
		}
	});
}
