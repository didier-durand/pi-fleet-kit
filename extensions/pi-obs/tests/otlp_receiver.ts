/**
 * pi-obs — minimal in-process OTLP/HTTP JSON test receiver (DEV_PLAN
 * Step 5). Captures every POST so tests (this step) and the black-box
 * suite (Step 9) can assert on real OTLP traffic — request path,
 * headers, body — without any external collector.
 *
 * Scriptable per-receiver:
 *   - fail(times, status): the next `times` requests answer `status`
 *     (default 500) instead of 200 — drives retry-then-drop tests;
 *   - hang(times): the next `times` requests are never answered —
 *     drives the per-request timeout tests;
 *   - everything else answers 200 with an empty OTLP partialSuccess.
 *
 * Zero dependencies (node:http). The standalone entry for the Step 9
 * black-box suite lives in tests/otlp_receiver_main.ts (kept separate
 * so this harness module stays fully covered by unit tests).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One captured OTLP request. */
export interface CapturedRequest {
	/** Request path, e.g. `/v1/traces`. */
	path: string;
	/** Request headers (node lowercases keys). */
	headers: IncomingMessage["headers"];
	/** The raw UTF-8 body. */
	body: string;
}

/** A running test receiver. */
export interface OtlpReceiver {
	/** Base URL, e.g. `http://127.0.0.1:43189`. */
	url: string;
	/** Bound port. */
	port: number;
	/** Every captured request, in arrival order (all statuses). */
	requests: CapturedRequest[];
	/** The next `times` requests answer `status` instead of 200. */
	fail(times: number, status?: number): void;
	/** The next `times` requests are never answered (timeout driver). */
	hang(times: number): void;
	/** Stop the server and destroy open sockets; resolves when closed. */
	close(): Promise<void>;
}

const SIGNAL_PATHS = new Set(["/v1/traces", "/v1/metrics", "/v1/logs"]);

/** Start the receiver on 127.0.0.1 (port 0 = pick a free one). */
export function startReceiver(port = 0): Promise<OtlpReceiver> {
	const requests: CapturedRequest[] = [];
	let failTimes = 0;
	let failStatus = 500;
	let hangTimes = 0;

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			if (req.url !== undefined && SIGNAL_PATHS.has(req.url)) requests.push({ path: req.url, headers: req.headers, body });
			if (hangTimes > 0) {
				hangTimes -= 1;
				return; // never answer — the client's timeout is what unblocks this
			}
			const status = failTimes > 0 ? ((failTimes -= 1), failStatus) : 200;
			res.writeHead(status, { "content-type": "application/json" });
			res.end(status === 200 ? '{"partialSuccess":{}}' : "");
		});
	});

	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const actual = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${actual}`,
				port: actual,
				requests,
				fail(times: number, status = 500) {
					failTimes = times;
					failStatus = status;
				},
				hang(times: number) {
					hangTimes = times;
				},
				close() {
					return new Promise((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					});
				},
			});
		});
	});
}
