/**
 * envelope.test.ts — unit tests for the mailbox envelope (SPECS v1.1.0 R9).
 * Fail-closed parsing: every malformed shape → undefined; valid shapes round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReply, contentText, newEnvelopeId, parseEnvelope, serializeEnvelope } from "./envelope.ts";

const VALID = {
	id: "msg-123-456",
	from: "pi-a",
	to: "pi-b",
	session_id: "sess-a-1",
	type: "request",
	correlation_id: null,
	created: "2026-11-25T10:00:00.000Z",
	body: "run the tests",
	attempts: 0,
};

test("parseEnvelope: a valid request parses", () => {
	const e = parseEnvelope(JSON.stringify(VALID));
	assert.ok(e);
	assert.equal(e.id, "msg-123-456");
	assert.equal(e.type, "request");
	assert.equal(e.correlation_id, null);
	assert.equal(e.attempts, 0);
});

test("parseEnvelope: non-JSON content fails closed with a reason", () => {
	const reasons: string[] = [];
	assert.equal(parseEnvelope("just a plain prompt", (r) => reasons.push(r)), undefined);
	assert.match(reasons[0], /not JSON/);
});

test("parseEnvelope: JSON but not an object fails closed", () => {
	assert.equal(parseEnvelope("[1,2,3]"), undefined);
	assert.equal(parseEnvelope("42"), undefined);
	assert.equal(parseEnvelope('"str"'), undefined);
});

test("parseEnvelope: missing required fields fail closed", () => {
	for (const key of ["id", "from", "to", "created", "body"]) {
		const clone: Record<string, unknown> = { ...VALID };
		delete clone[key];
		assert.equal(parseEnvelope(JSON.stringify(clone)), undefined, `missing ${key} rejected`);
	}
});

test("parseEnvelope: empty required fields fail closed", () => {
	for (const key of ["id", "from", "to", "body"]) {
		assert.equal(parseEnvelope(JSON.stringify({ ...VALID, [key]: "   " })), undefined, `blank ${key} rejected`);
	}
});

test("parseEnvelope: unknown type fails closed", () => {
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, type: "gossip" })), undefined);
});

test("parseEnvelope: correlation_id rules per type", () => {
	// reply without correlation → rejected
	const reply = { ...VALID, type: "reply", correlation_id: null };
	assert.equal(parseEnvelope(JSON.stringify(reply)), undefined);
	// reply with correlation → accepted
	const okReply = { ...VALID, type: "reply", correlation_id: "msg-1-1" };
	assert.ok(parseEnvelope(JSON.stringify(okReply)));
	// request WITH correlation → rejected
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, correlation_id: "msg-1-1" })), undefined);
	// correlation present but not a string → rejected
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, type: "reply", correlation_id: 42 })), undefined);
});

test("parseEnvelope: created must be an ISO timestamp", () => {
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, created: "not-a-date" })), undefined);
});

test("parseEnvelope: attempts must be a non-negative integer", () => {
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, attempts: -1 })), undefined);
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, attempts: 1.5 })), undefined);
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, attempts: "0" })), undefined);
	assert.ok(parseEnvelope(JSON.stringify({ ...VALID, attempts: 2 })));
	// missing attempts defaults to 0
	const e = parseEnvelope(JSON.stringify((() => { const c: Record<string, unknown> = { ...VALID }; delete c.attempts; return c; })()));
	assert.equal(e?.attempts, 0);
});

test("parseEnvelope: reply and error envelopes parse with correlation", () => {
	const reply = { ...VALID, type: "reply", correlation_id: "msg-1-1", body: "the answer" };
	const e = parseEnvelope(JSON.stringify(reply));
	assert.equal(e?.type, "reply");
	assert.equal(e?.correlation_id, "msg-1-1");
});

test("buildReply: echoes correlation and flips from/to", () => {
	const req = parseEnvelope(JSON.stringify(VALID))!;
	const reply = buildReply(req, "pi-b", "the answer", "reply", Date.now(), process.pid, "sess-b-1");
	assert.equal(reply.type, "reply");
	assert.equal(reply.correlation_id, req.id);
	assert.equal(reply.to, req.from);   // back to the sender
	assert.equal(reply.from, "pi-b");
	assert.equal(reply.body, "the answer");
	assert.equal(reply.attempts, 0);
	assert.ok(reply.id.startsWith("msg-"));
});

test("buildReply: error type", () => {
	const req = parseEnvelope(JSON.stringify(VALID))!;
	const err = buildReply(req, "pi-b", "it failed", "error", Date.now(), process.pid, "sess-b-1");
	assert.equal(err.type, "error");
	assert.equal(err.correlation_id, req.id);
});

test("serializeEnvelope: round-trip preserves every field", () => {
	const req = parseEnvelope(JSON.stringify(VALID))!;
	const back = parseEnvelope(serializeEnvelope(req))!;
	assert.deepEqual(back, req);
});

test("newEnvelopeId: unique across calls, msg- prefixed", () => {
	const a = newEnvelopeId(1, 2);
	const b = newEnvelopeId(1, 3);
	assert.notEqual(a, b);
	assert.match(a, /^msg-1-2$/);
});

test("contentText: string and array-of-blocks forms", () => {
	assert.equal(contentText("plain"), "plain");
	assert.equal(contentText(""), undefined);
	assert.equal(contentText([{ type: "text", text: "hello" }, { type: "text", text: "world" }]), "hello\nworld");
	assert.equal(contentText([{ type: "tool_use", id: "x" }]), undefined);
	assert.equal(contentText(undefined), undefined);
});

test("session_id is required on every envelope (R13: distributed traces)", () => {
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, session_id: undefined })), undefined);
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, session_id: "" })), undefined);
	assert.equal(parseEnvelope(JSON.stringify({ ...VALID, session_id: "  " })), undefined);
	const e = parseEnvelope(JSON.stringify(VALID))!;
	assert.equal(e.session_id, "sess-a-1");
});

test("buildReply: the replier's session id rides on the reply (the chain stays traceable)", () => {
	const req = parseEnvelope(JSON.stringify(VALID))!;
	const reply = buildReply(req, "pi-b", "the answer", "reply", Date.now(), process.pid, "sess-b-1");
	assert.equal(reply.session_id, "sess-b-1");
	assert.equal(reply.correlation_id, req.id);
});

test("attachments (R14): a valid list round-trips; absent/empty stay field-free", () => {
	const sha = (c: string) => Buffer.from(c).toString("hex").padEnd(64, "0").slice(0, 64);
	const valid = { ...VALID, attachments: [{ name: "a.txt", bytes: 3, sha256: sha("aaa") }, { name: "b.bin", bytes: 1, sha256: sha("b") }] };
	const e = parseEnvelope(JSON.stringify(valid))!;
	assert.deepEqual(e.attachments, [{ name: "a.txt", bytes: 3, sha256: sha("aaa") }, { name: "b.bin", bytes: 1, sha256: sha("b") }]);
	// absent: no field on the parsed envelope
	const plain = parseEnvelope(JSON.stringify(VALID))!;
	assert.equal("attachments" in plain, false);
	// empty array: valid, but the field is omitted (no attachments)
	const empty = parseEnvelope(JSON.stringify({ ...VALID, attachments: [] }))!;
	assert.equal("attachments" in empty, false);
});

test("attachments (R14): malformed lists fail closed with a reason", () => {
	const sha = (c: string) => c.padEnd(64, "a").slice(0, 64); // valid hex canaries
	const withA = (attachments: unknown) => JSON.stringify({ ...VALID, attachments });
	const reasons = (raw: string, fragment: RegExp) => {
		let reason = "";
		parseEnvelope(raw, (r) => { reason = r; });
		assert.equal(parseEnvelope(raw), undefined, "fail-closed");
		assert.match(reason, fragment);
	};
	reasons(withA("nope"), /must be an array/);
	reasons(withA([{ name: "../evil", bytes: 1, sha256: sha("a") }]), /unsafe attachment name/);
	reasons(withA([{ name: ".hidden", bytes: 1, sha256: sha("a") }]), /unsafe attachment name/);
	reasons(withA([{ name: "a/b", bytes: 1, sha256: sha("a") }]), /unsafe attachment name/);
	reasons(withA([{ name: "a.txt", bytes: 0, sha256: sha("a") }]), /bytes must be a positive integer/);
	reasons(withA([{ name: "a.txt", bytes: 1.5, sha256: sha("a") }]), /bytes must be a positive integer/);
	reasons(withA([{ name: "a.txt", bytes: 1, sha256: "ZZ" }]), /sha256 must be 64 lowercase hex/);
	reasons(withA([{ name: "b.txt", bytes: 1, sha256: sha("a") }, { name: "a.txt", bytes: 1, sha256: sha("b") }]), /sorted strictly ascending/);
	reasons(withA([{ name: "a.txt", bytes: 1, sha256: sha("a") }, { name: "a.txt", bytes: 1, sha256: sha("a") }]), /sorted strictly ascending/);
	reasons(withA(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, bytes: 1, sha256: sha(String(i)) }))), /too many attachments/);
});

test("buildReply: attachments ride through (replies may carry files)", () => {
	const req = parseEnvelope(JSON.stringify(VALID))!;
	const sha = (c: string) => c.padEnd(64, "0").slice(0, 64);
	const reply = buildReply(req, "pi-b", "the artifact is attached", "reply", Date.now(), process.pid, "sess-b-1",
		[{ name: "result.json", bytes: 9, sha256: sha("result") }]);
	assert.deepEqual(reply.attachments, [{ name: "result.json", bytes: 9, sha256: sha("result") }]);
	// no attachments → no field (0.3.x wire format preserved)
	const plain = buildReply(req, "pi-b", "the answer", "reply", Date.now(), process.pid, "sess-b-1");
	assert.equal("attachments" in plain, false);
});
