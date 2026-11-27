/**
 * prompt-trigger — send.sh integration tests (R14 attachments): the
 * bash helper is driven end to end against real temp exchange dirs —
 * copy-before-commit, the header list, the caps, and orphan cleanup.
 * Node is required by send.sh itself, so the test process has it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) fs.rmSync(dirs.pop() ?? ".", { recursive: true, force: true });
});

/** A minimal fleet: sender dir (with .sender identity) + recipient dir with an inbox. */
function makeFleet(): { sender: string; recipient: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sendsh-test-"));
	dirs.push(root);
	const sender = path.join(root, "pi-a");
	const recipient = path.join(root, "pi-b");
	fs.mkdirSync(path.join(sender, "inbox"), { recursive: true });
	fs.mkdirSync(path.join(recipient, "inbox"), { recursive: true });
	fs.writeFileSync(path.join(sender, ".sender"), JSON.stringify({ session_id: "sess-a-1" }));
	return { sender, recipient };
}

function run(args: string[], sender: string): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("bash", [path.join(ROOT, "send.sh"), ...args], {
			env: { ...process.env, PI_TRIGGER_DIR: sender },
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const envelopeOf = (recipient: string): Record<string, unknown> => {
	const sent = fs.readdirSync(path.join(recipient, "inbox")).filter((n) => !n.startsWith("."));
	assert.equal(sent.length, 1, "exactly one envelope");
	return JSON.parse(fs.readFileSync(path.join(recipient, "inbox", sent[0]), "utf8"));
};

const sentCount = (recipient: string): number =>
	fs.readdirSync(path.join(recipient, "inbox")).filter((n) => !n.startsWith(".")).length;

test("send.sh --attach: files are staged before the envelope; the header lists them", () => {
	const { sender, recipient } = makeFleet();
	const src1 = path.join(sender, "report.txt");
	fs.writeFileSync(src1, "the report");
	const src2 = path.join(sender, "data.json");
	fs.writeFileSync(src2, "{}");
	const r = run(["pi-b", src1, `--attach=${src1}`, `--attach=${src2}`], sender);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);

	const env = envelopeOf(recipient) as { id: string; attachments: { name: string; bytes: number; sha256: string }[] };
	const id = env.id;
	assert.deepEqual(env.attachments, [
		{ name: "data.json", bytes: 2, sha256: sha256(path.join(recipient, "attachments", id, "data.json")) },
		{ name: "report.txt", bytes: 10, sha256: sha256(path.join(recipient, "attachments", id, "report.txt")) },
	], "sorted by name; sizes and hashes of the STAGED copies");
	// the staged copies carry the source content, and the source is COPIED (not moved)
	assert.equal(fs.readFileSync(path.join(recipient, "attachments", id, "report.txt"), "utf8"), "the report");
	assert.equal(fs.readFileSync(path.join(sender, "report.txt"), "utf8"), "the report");
});

test("send.sh without --attach: no attachments field (0.3.x wire format preserved)", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "just text");
	const r = run(["pi-b", body], sender);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.equal("attachments" in envelopeOf(recipient), false);
});

test("send.sh: too many attachments fails closed — no envelope, no staged dir", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "x");
	const args = ["pi-b", body];
	for (let i = 0; i < 11; i++) {
		const f = path.join(sender, `f${i}.txt`);
		fs.writeFileSync(f, "x");
		args.push(`--attach=${f}`);
	}
	const r = run(args, sender);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /too many attachments/);
	assert.equal(sentCount(recipient), 0, "nothing sent");
	assert.equal(fs.existsSync(path.join(recipient, "attachments")), false, "nothing staged");
});

test("send.sh: an oversized total fails closed and cleans the staged dir", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "x");
	const big = path.join(sender, "big.bin");
	fs.writeFileSync(big, Buffer.alloc(21 * 1024 * 1024, 1)); // > 20 MiB cap
	const r = run(["pi-b", body, `--attach=${big}`], sender);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /exceeds the 20 MiB cap/);
	assert.equal(sentCount(recipient), 0);
	const staged = fs.existsSync(path.join(recipient, "attachments")) ? fs.readdirSync(path.join(recipient, "attachments")) : [];
	assert.equal(staged.length, 0, "the staged dir was removed (an empty parent may remain)");
});

test("send.sh: a missing attachment source fails closed with nothing staged", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "x");
	const r = run(["pi-b", body, "--attach=/nonexistent/file.txt"], sender);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /attachment not found/);
	assert.equal(sentCount(recipient), 0);
	const staged = fs.existsSync(path.join(recipient, "attachments")) ? fs.readdirSync(path.join(recipient, "attachments")) : [];
	assert.equal(staged.length, 0, "nothing staged");
});

test("send.sh: an unsafe attachment BASENAME fails closed", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "x");
	const unsafe = path.join(sender, ".hidden");
	fs.writeFileSync(unsafe, "x");
	const r = run(["pi-b", body, `--attach=${unsafe}`], sender);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /unsafe attachment name/);
	assert.equal(sentCount(recipient), 0);
	const staged = fs.existsSync(path.join(recipient, "attachments")) ? fs.readdirSync(path.join(recipient, "attachments")) : [];
	assert.equal(staged.length, 0, "nothing staged");
});

test("send.sh: a safe basename under a subdirectory stages by basename", () => {
	const { sender, recipient } = makeFleet();
	const body = path.join(sender, "body.txt");
	fs.writeFileSync(body, "x");
	const sub = path.join(sender, "sub");
	fs.mkdirSync(sub);
	const nested = path.join(sub, "file.txt");
	fs.writeFileSync(nested, "content");
	const r = run(["pi-b", body, `--attach=${nested}`], sender);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	const env = envelopeOf(recipient) as { id: string };
	assert.ok(fs.existsSync(path.join(recipient, "attachments", env.id, "file.txt")), "staged by basename");
});
