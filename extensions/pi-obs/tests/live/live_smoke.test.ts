/**
 * pi-obs — LIVE smoke test (DEV_PLAN Step 6, model-gated). Kept in its
 * own file OUTSIDE the coverage-gated glob (*.test.ts exporters/*.test.ts):
 * running a real `pi` child process inside the coverage run corrupts V8
 * coverage collection nondeterministically (measured: identical runs
 * flipping between 70% and 99% on index.ts). Auto-skips without
 * OPENROUTER_API_KEY — the CI path is model-free by design.
 *
 * A scripted `pi -e ./pi-obs/index.ts -p …` run with the file exporter:
 *   - exits 0 with unchanged agent output,
 *   - exports a trace with exactly pi.session > pi.run > pi.turn > pi.model,
 *   - and the same prompt WITHOUT pi-obs yields identical output/exit code
 *     (SPECS R1 AC).
 *
 * Run locally:  node --test tests/live_smoke.test.ts   (needs the key + pi)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

/** Non-blocking run (spawnSync blocks the event loop and corrupts V8 coverage collection). */
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
		child.on("error", reject); // ENOENT etc.
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});

test("live smoke (model-gated): pi -e exports the hierarchy; identical output without pi-obs", { skip: !process.env.OPENROUTER_API_KEY }, async () => {
	let piWorks: boolean;
	try {
		await run("pi", ["--version"], { ...process.env });
		piWorks = true;
	} catch {
		piWorks = false; // no pi binary on PATH: skip
	}
	if (!piWorks) return;
	const smokeDir = mkdtempSync(join(tmpdir(), "pi-obs-smoke-"));
	try {
		const smokeExport = join(smokeDir, "pi-obs.jsonl");
		const prompt = "Reply with exactly: OK";
		// PI_HOME isolates pi's session state into the smoke dir; the real HOME
		// (untouched in this file) keeps the user's pi config — no stdin waiting
		const env = { ...process.env, PI_HOME: smokeDir, PI_OBS_FILE: "1", PI_OBS_FILE_PATH: smokeExport };
		const withExt = await run("pi", ["-e", join(import.meta.dirname, "..", "..", "index.ts"), "-p", prompt], env);
		assert.equal(withExt.status, 0, `pi -e exited ${withExt.status}: ${withExt.stderr}`);
		assert.ok(withExt.stdout.includes("OK"), `agent output unchanged: ${withExt.stdout.slice(0, 80)}`);

		const names = readFileSync(smokeExport, "utf8")
			.split("\n")
			.filter((l) => l !== "" && l.includes('"resourceSpans"'))
			.map((l) => JSON.parse(l) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] })
			.map((l) => l.resourceSpans[0].scopeSpans[0].spans[0].name);
		for (const expected of ["pi.session", "pi.run", "pi.turn", "pi.model"]) {
			assert.ok(names.includes(expected), `live trace misses ${expected}: ${names.join(",")}`);
		}

		const without = await run("pi", ["-p", prompt], { ...process.env, PI_HOME: smokeDir });
		assert.equal(without.status, 0);
		assert.equal(without.stdout.trim(), withExt.stdout.trim(), "R1 AC: identical output with and without pi-obs");
	} finally {
		rmSync(smokeDir, { recursive: true, force: true });
	}
});
