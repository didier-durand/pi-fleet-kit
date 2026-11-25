/**
 * pi-obs — standalone OTLP test receiver entry (DEV_PLAN Step 5,
 * consumed by the Step 9 black-box suite).
 *
 *   node tests/otlp_receiver_main.ts [port] [--out <file>]   # default 4318
 *
 * Prints `listening <port>` on stdout, stays up until SIGINT/SIGTERM,
 * and with --out appends one JSON line per received request
 * ({"path":...,"bytes":N}) so the black-box suite can observe
 * deliveries without white-box knowledge.
 */

import process from "node:process";
import { appendFileSync } from "node:fs";
import { startReceiver } from "./otlp_receiver.ts";

const args = process.argv.slice(2);
const port = Number(args.find((a) => !a.startsWith("--")) ?? 4318);
const outIndex = args.indexOf("--out");
const outFile = outIndex !== -1 ? (args[outIndex + 1] ?? undefined) : undefined;

const receiver = await startReceiver(port);
process.stdout.write(`listening ${receiver.port}\n`);
const stop = () => {
	void receiver.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// stream captured requests to the out file as they arrive (bounded polling)
if (outFile !== undefined) {
	let seen = 0;
	const drain = () => {
		while (seen < receiver.requests.length) {
			const request = receiver.requests[seen++];
			appendFileSync(outFile, `${JSON.stringify({ path: request.path, bytes: request.body.length })}\n`);
		}
		setTimeout(drain, 100);
	};
	drain();
}
