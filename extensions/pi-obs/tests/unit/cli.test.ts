/**
 * pi-obs — standalone CLI tests (SPECS R3b `piobs`), pure level: the
 * argument grammar and runCli driven through an injected IO — no child
 * processes (those live in tests/cli/, outside the coverage glob).
 *
 *   - grammar matrix: commands, flags, positional rules, distinct
 *     usage errors (unknown flag / missing argument / unknown command /
 *     stray positional / dir-after-path);
 *   - runCli: help + version exit 0; report happy path emits parseable
 *     OTLP/JSON lines; --file writes them; unknown id exits 1; usage
 *     errors exit 2; the R6 precedence (env > settings) and flag
 *     overrides for capture opt-ins and the service name.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CliUsageError, HELP, parseArgs, runCli, type CliIo } from "../../src/cli.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "sessions");
const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? ".", { recursive: true, force: true });
});

const io = (): { out: string[]; err: string[]; io: CliIo } => {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) } };
};

const cleanEnv = (): Record<string, string | undefined> => ({ PI_HOME: "/nonexistent-pi-home", HOME: "/nonexistent-home" });

test("grammar: commands, flags, and positionals parse", () => {
	assert.deepEqual(parseArgs([]), { command: "help" });
	assert.deepEqual(parseArgs(["--help"]), { command: "help" });
	assert.deepEqual(parseArgs(["report", "--help"]), { command: "help" });
	assert.deepEqual(parseArgs(["version"]), { command: "version" });
	assert.deepEqual(parseArgs(["report", "abc"]), { command: "report", target: "abc" });
	assert.deepEqual(parseArgs(["report", "abc", "/sessions"]), { command: "report", target: "abc", sessionDir: "/sessions" });
	assert.deepEqual(parseArgs(["report", "s.jsonl", "--branch=b1", "--file=/tmp/r.jsonl", "--otlp", "--endpoint=http://c:4318", "--capture-prompts", "--capture-tool-io", "--service=fleet", "--sessions-dir=/s"]), {
		command: "report",
		target: "s.jsonl",
		branch: "b1",
		file: "/tmp/r.jsonl",
		otlp: true,
		endpoint: "http://c:4318",
		capturePrompts: true,
		captureToolIo: true,
		service: "fleet",
		sessionsDir: "/s",
	});
	// flags before/after positionals, any order
	assert.deepEqual(parseArgs(["--otlp", "report", "x"]), { command: "report", target: "x", otlp: true });
});

test("grammar: distinct usage errors", () => {
	const expect = (tokens: string[], fragment: RegExp): void => {
		assert.throws(() => parseArgs(tokens), (err: unknown) => {
			assert.ok(err instanceof CliUsageError, String(err));
			assert.match((err as Error).message, fragment);
			return true;
		}, tokens.join(" "));
	};
	expect(["report"], /needs a <session-id \| path>/);
	expect(["report", "a", "b", "c"], /unexpected argument "c"/);
	expect(["report", "x", "--wat"], /unknown flag "--wat"/);
	expect(["report", "x", "--branch="], /flag "--branch" needs a value/);
	expect(["bogus"], /unknown command "bogus"/);
	expect(["version", "extra"], /unexpected argument "extra" after version/);
});

test("runCli: help and version exit 0", async () => {
	const h = io();
	assert.equal(await runCli(["--help"], h.io, cleanEnv()), 0);
	assert.ok(h.out[0]?.startsWith("piobs — pi-obs post-mortem reports"));
	assert.ok(HELP.includes("--branch=<entry-id>") && HELP.includes("Exit codes:"));
	const v = io();
	assert.equal(await runCli(["version"], v.io, cleanEnv()), 0);
	assert.match(v.out[0] ?? "", /^piobs \d+\.\d+\.\d+ \(pi-obs\)$/);  // exact digits come from package.json (version.test.ts pins the derivation)
});

test("runCli report: happy path — parseable OTLP/JSON lines on stdout, exit 0", async () => {
	const r = io();
	assert.equal(await runCli(["report", join(FIXTURES, "straight.jsonl")], r.io, cleanEnv()), 0);
	assert.ok((r.out.length ?? 0) >= 10, `lines: ${r.out.length}`);
	for (const line of r.out) assert.doesNotThrow(() => JSON.parse(line));
	assert.ok(r.out.some((l) => l.includes('"pi.session"')));
	assert.equal(r.err.length, 0);
});

test("runCli report: --file writes the same lines; the R2 session-dir rule exits 1", async () => {
	const dir = mkdtempSync(join(tmpdir(), "piobs-cli-"));
	dirs.push(dir);
	const r = io();
	assert.equal(await runCli(["report", join(FIXTURES, "straight.jsonl"), `--file=${join(dir, "r.jsonl")}`], r.io, cleanEnv()), 0);
	const written = readFileSync(join(dir, "r.jsonl"), "utf8").split("\n").filter((l) => l !== "");
	assert.equal(written.length, r.out.length);
	for (let i = 0; i < written.length; i++) assert.equal(written[i], r.out[i]);

	// --file into a session directory: the R2 rule, exit 1 with its message
	const bad = io();
	assert.equal(await runCli(["report", join(FIXTURES, "straight.jsonl"), `--file=${join(dir, "sessions", "ws", "r.jsonl")}`], bad.io, cleanEnv()), 1);
	assert.match(bad.err[0] ?? "", /is inside a session directory/);
});

test("runCli report: replay errors exit 1; usage errors exit 2", async () => {
	const dir = mkdtempSync(join(tmpdir(), "piobs-cli-"));
	dirs.push(dir);
	const unknown = io();
	assert.equal(await runCli(["report", "no-such-id", `--sessions-dir=${dir}`], unknown.io, cleanEnv()), 1);
	assert.match(unknown.err[0] ?? "", /no session with id no-such-id/);

	const unreadable = io();
	assert.equal(await runCli(["report", join(dir, "missing.jsonl")], unreadable.io, cleanEnv()), 1);
	assert.match(unreadable.err[0] ?? "", /cannot read session file/);

	const usage = io();
	assert.equal(await runCli(["report", "x", "--wat"], usage.io, cleanEnv()), 2);
	assert.match(usage.err[0] ?? "", /unknown flag/);
	assert.match(usage.err[1] ?? "", /usage: piobs report/);

	const dirAfterPath = io();
	assert.equal(await runCli(["report", join(FIXTURES, "straight.jsonl"), dir], dirAfterPath.io, cleanEnv()), 2);
	assert.match(dirAfterPath.err[0] ?? "", /may only follow a session ID/);
});

test("runCli report: R6 precedence — env applies, flags override, defaults stand", async () => {
	const fixture = join(FIXTURES, "canary.jsonl");

	// default: no verbatim text
	const plain = io();
	await runCli(["report", fixture], plain.io, cleanEnv());
	assert.ok(!plain.out.join("\n").includes("pi.content.text"), "no text by default");

	// env opt-in applies (R2: redacted)
	const envOn = io();
	await runCli(["report", fixture], envOn.io, { ...cleanEnv(), PI_OBS_CAPTURE_PROMPTS: "1" });
	const wire = envOn.out.join("\n");
	assert.ok(wire.includes("pi.content.text") && wire.includes("[REDACTED]"), "env opt-in captured and redacted");

	// the flag itself (capture opt-in + service name override)
	const flagOn = io();
	await runCli(["report", fixture, "--capture-prompts", "--service=my-fleet"], flagOn.io, cleanEnv());
	const named = JSON.parse(flagOn.out[0] ?? "{}") as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] } }[] };
	const resource = Object.fromEntries(named.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value]));
	assert.equal(resource["service.name"].stringValue, "my-fleet", "--service overrides the default");
});
