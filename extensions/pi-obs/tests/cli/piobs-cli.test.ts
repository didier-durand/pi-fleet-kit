/**
 * pi-obs — standalone CLI end-to-end tests (SPECS R3b `piobs`).
 *
 * Child-process spawns of the REAL bin/piobs wrapper (sh -> node
 * src/cli.ts) — deliberately outside the coverage glob: child
 * processes corrupt V8 coverage collection (the Step 6/10 lesson).
 * Model-free: the report engine never calls a model.
 *
 *   - bin/piobs --help / version: exit 0, real output;
 *   - report on a fixture: stdout OTLP/JSON-per-line, exit 0, --file;
 *   - error paths: unknown id exit 1, usage errors exit 2;
 *   - the wrapper itself is exercised (sh + node + src/cli.ts).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const PIOBS = join(ROOT, "bin", "piobs");
const FIXTURES = join(ROOT, "tests", "fixtures", "sessions");

/** Non-blocking run (spawnSync corrupts coverage collection). */
const run = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn(PIOBS, args, { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});

const cleanEnv = { PI_HOME: "/nonexistent-pi-home", HOME: "/nonexistent-home", PATH: process.env.PATH };

test("piobs --help and version: exit 0 with real output through the wrapper", async () => {
	const help = await run(["--help"], cleanEnv);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /^piobs — pi-obs post-mortem reports/);
	assert.match(help.stdout, /--branch=<entry-id>/);
	assert.match(help.stdout, /Exit codes:/);
	assert.equal((await run(["-h"], cleanEnv)).status, 0);

	const version = await run(["version"], cleanEnv);
	assert.equal(version.status, 0);
	assert.match(version.stdout.trim(), /^piobs \d+\.\d+\.\d+ \(pi-obs\)$/);
});

test("piobs report <fixture>: stdout OTLP/JSON-per-line, exit 0; --file writes them", async () => {
	const report = await run(["report", join(FIXTURES, "straight.jsonl")], cleanEnv);
	assert.equal(report.status, 0);
	const lines = report.stdout.split("\n").filter((l) => l.startsWith("{"));
	assert.ok(lines.length >= 10);
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
	assert.ok(lines.some((l) => l.includes('"pi.session"')));

	const dir = mkdtempSync(join(tmpdir(), "piobs-e2e-"));
	try {
		const filed = await run(["report", join(FIXTURES, "straight.jsonl"), `--file=${join(dir, "r.jsonl")}`], cleanEnv);
		assert.equal(filed.status, 0);
		assert.match(filed.stderr, new RegExp(`wrote ${lines.length} line\\(s\\) to`));
		const written = readFileSync(join(dir, "r.jsonl"), "utf8").split("\n").filter((l) => l !== "");
		assert.equal(written.length, lines.length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("piobs error paths: replay errors exit 1, usage errors exit 2", async () => {
	const dir = mkdtempSync(join(tmpdir(), "piobs-e2e-"));
	try {
		const unknown = await run(["report", "no-such-id", `--sessions-dir=${dir}`], cleanEnv);
		assert.equal(unknown.status, 1);
		assert.match(unknown.stderr, /no session with id no-such-id/);

		const badFlag = await run(["report", "x", "--wat"], cleanEnv);
		assert.equal(badFlag.status, 2);
		assert.match(badFlag.stderr, /unknown flag/);

		const missing = await run(["report"], cleanEnv);
		assert.equal(missing.status, 2);
		assert.match(missing.stderr, /needs a <session-id \| path>/);

		const unknownCmd = await run(["bogus"], cleanEnv);
		assert.equal(unknownCmd.status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
