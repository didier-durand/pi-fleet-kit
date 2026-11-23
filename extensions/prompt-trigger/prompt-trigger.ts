/**
 * prompt-trigger extension — file-triggered prompts for a running TUI.
 *
 * Watches a directory (PI_TRIGGER_DIR). When ANY regular file appears in it,
 * the file's content is injected into the session as if typed by the user
 * (pi.sendUserMessage) — visible in the TUI, turn started or queued — and
 * the file is deleted (consumed). One file = one prompt.
 *
 * Directives (first line of the file):
 *   /new [kickoff]   — start a FRESH session (token-free); optional kickoff
 *                      text becomes the first message of the new session.
 *   anything else    — the whole content is the prompt.
 *
 * Protocol for the producer (watchdog):
 *   - Drop files into the directory; content = UTF-8 prompt text.
 *   - Write ATOMICALLY: write to a temp name then rename into place (or
 *     ensure the file is fully written before the next poll). The extension
 *     only consumes files that are stable: unchanged size across two
 *     consecutive polls AND mtime older than the stability window.
 *   - Files are consumed (deleted) by the extension; do not reuse names
 *     with different content without expecting consumption.
 *
 * Idle cost: a readdir + stat per file every poll interval — zero tokens.
 * Tokens are consumed only when a prompt (or kickoff) is actually sent.
 *
 * Config: PI_TRIGGER_DIR (in-container path). Unset → extension dormant.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 1500;          // poll interval (token-free idle)
const STABILITY_MS = 500;      // file must be this old + unchanged to be consumed
const MAX_FILES_PER_TICK = 5;  // cap per tick: keeps turns sequential

interface PendingFile {
	file: string;
	size: number;
	mtimeMs: number;
	seenAt: number; // first poll tick where this size/mtime was observed
}

export default function (pi: ExtensionAPI) {
	let dir: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	let busy = false; // streaming in progress
	let lastTickAt = 0;
	const pending = new Map<string, PendingFile>(); // path -> observation

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
					await ctx.newSession({});
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

	function tick(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (!dir) return;
		const now = Date.now();

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
					if (++candidates >= MAX_FILES_PER_TICK + 99) break; // unreachable guard
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
				// Cap: at most MAX_FILES_PER_TICK prompts consumed per tick.
				if (candidates > MAX_FILES_PER_TICK) break;
			}
		}

		// Forget observations for files that disappeared.
		for (const key of pending.keys()) {
			if (!seen.has(key)) pending.delete(key);
		}
		lastTickAt = now;
	}

	pi.on("session_start", async (_event, ctx) => {
		dir = process.env.PI_TRIGGER_DIR;
		if (!dir) return; // dormant: no trigger dir configured for this agent
		if (timer) clearInterval(timer);
		timer = setInterval(() => tick(pi, ctx), POLL_MS);
		if (ctx.hasUI) {
			ctx.ui.notify(`[prompt-trigger] watching ${dir} (poll ${POLL_MS}ms)`, "info");
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
	pi.on("agent_end", async () => {
		busy = false;
	});
}
