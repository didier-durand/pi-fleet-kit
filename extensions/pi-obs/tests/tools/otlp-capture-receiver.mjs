#!/usr/bin/env node
/**
 * otlp-capture-receiver.mjs — minimal OTLP/HTTP receiver that captures FULL
 * request bodies (unlike tests/otlp_receiver.ts, which records only
 * {path, bytes} metadata).
 *
 * Purpose: the pi-obs-otlp-live workflow runs a sandbox container with
 * pi-obs exporting to this receiver, then validates the captured spans
 * correlate with the prompt and the LLM's answer.
 *
 * Usage: node otlp-capture-receiver.mjs <port> --out <capture.jsonl>
 * Prints "listening <port>" on stdout; one JSON line per request:
 *   {"path": "/v1/traces", "body": "<raw OTLP/JSON>"}
 * Stays up until SIGINT/SIGTERM.
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 4318);
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex !== -1 ? process.argv[outIndex + 1] : undefined;
if (!outFile) {
  console.error("usage: node otlp-capture-receiver.mjs <port> --out <capture.jsonl>");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    appendFileSync(outFile, JSON.stringify({ path: req.url, body }) + "\n");
    // OTLP/HTTP success response (the exporter checks the status code)
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ partialSuccess: {} }));
  });
  req.on("error", () => res.destroy());
});

server.listen(port, "0.0.0.0", () => console.log(`listening ${port}`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
