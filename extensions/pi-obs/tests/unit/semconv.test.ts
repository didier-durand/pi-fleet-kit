/**
 * pi-obs — semconv registry tests (SPECS R4 ACs).
 *
 *   - registry completeness is driven MECHANICALLY from SPECS.md: every
 *     `gen_ai.*` / `pi.*` name the spec commits to (attributes, spans,
 *     events, metrics) is extracted and must be registered — the table
 *     is the contract;
 *   - every attribute row has a type, a source, and a meaning;
 *   - the metric table matches SPECS R4 exactly (names, kinds, attrs);
 *   - lookups fail closed: unknown names error in tests, are reported
 *     (never thrown) in production.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	ALL_ATTRIBUTES,
	ALL_NAMES,
	EVENT_NAMES,
	GENAI_ATTRIBUTES,
	METRICS,
	PI_ATTRIBUTES,
	RESOURCE_ATTRIBUTES,
	SPAN_NAMES,
	SemconvError,
	lookupAttribute,
	lookupEntity,
	lookupMetric,
	mustLookupAttribute,
	mustLookupMetric,
	reportUnknownAttribute,
} from "../../src/semconv.ts";

/** `pi.*`/`gen_ai.*` tokens in SPECS that are prose, not emitted names. */
const SPECS_PROSE_NAMES = new Set([
	"pi.on", // glossary: "one pi extension event subscription (pi.on(…))"
	"pi.replay", // R3b: historical mention — renamed to pi.replayed by the Step 9 Weaver conformance check
]);

/** Every gen_ai.* / pi.* name SPECS commits to, extracted mechanically. */
function specNames(): Set<string> {
	const text = readFileSync(join(import.meta.dirname, "..", "..", "docs", "SPECS.md"), "utf8");
	const names = new Set<string>();
	for (const match of text.matchAll(/\b(?:gen_ai|pi)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*/g)) {
		names.add(match[0].replace(/\.+$/, "")); // strip sentence-final dots
	}
	for (const prose of SPECS_PROSE_NAMES) {
		assert.ok(names.has(prose), `prose ignore-list entry "${prose}" no longer appears in SPECS — remove it`);
		names.delete(prose);
	}
	return names;
}

test("registry completeness: every gen_ai.*/pi.* name in SPECS is registered", () => {
	// NOTE: the scan is over SPECS PROSE — any `pi.*`/`gen_ai.*`-shaped token
	// in SPECS.md is treated as an attribute commitment. Non-attribute dotted
	// keys must NOT appear in that form: e.g. the package.json `pi` manifest
	// is referenced as `extensions: [...]`, never `pi.extensions` (that exact
	// token once slipped in and failed this test — correctly).
	const missing: string[] = [];
	for (const name of specNames()) {
		if (!ALL_NAMES.has(name)) missing.push(name);
	}
	assert.deepEqual(missing, [], "SPECS commits to names absent from the semconv tables (R4: the table is the contract)");
});

test("every registered attribute row has a name, type, source hook, and meaning", () => {
	for (const spec of ALL_ATTRIBUTES) {
		assert.ok(spec.name.length > 0, "empty attribute name");
		assert.ok(["string", "number", "boolean"].includes(spec.type), `${spec.name}: bad type`);
		assert.ok(spec.hook.length > 0, `${spec.name}: missing source hook`);
		assert.ok(spec.meaning.length > 10, `${spec.name}: missing meaning`);
	}
});

test("attribute names are unique across the gen_ai and pi tables", () => {
	const seen = new Set<string>();
	for (const spec of [...GENAI_ATTRIBUTES, ...PI_ATTRIBUTES, ...RESOURCE_ATTRIBUTES]) {
		assert.ok(!seen.has(spec.name), `duplicate attribute "${spec.name}"`);
		seen.add(spec.name);
	}
});

test("name shapes: attributes are dotted gen_ai.*/pi.*/standard; spans and events are pi.*", () => {
	for (const spec of [...GENAI_ATTRIBUTES, ...PI_ATTRIBUTES]) {
		assert.match(spec.name, /^(gen_ai|pi)\.[a-z][a-z0-9_.]*$/);
	}
	for (const spec of [...SPAN_NAMES, ...EVENT_NAMES]) {
		assert.match(spec.name, /^pi\.[a-z][a-z0-9_.]*$/);
	}
	for (const metric of METRICS) {
		assert.match(metric.name, /^pi\.[a-z][a-z0-9_.]*$/);
	}
});

test("metric table matches SPECS R4 exactly: names, kinds, breakdown attributes", () => {
	const byName = new Map(METRICS.map((m) => [m.name, m]));
	assert.equal(METRICS.length, 10, "R4 lists exactly ten metrics");
	const expected: Record<string, { type: string; attributes: string[] }> = {
		"pi.model.requests": { type: "counter", attributes: [] },
		"pi.tokens": { type: "counter", attributes: ["pi.token.type"] },
		"pi.cost.total": { type: "counter", attributes: [] },
		"pi.tool.calls": { type: "counter", attributes: ["pi.tool.name"] },
		"pi.messages": { type: "counter", attributes: ["pi.role"] },
		"pi.tool.updates": { type: "counter", attributes: ["pi.tool.name"] },
		"pi.model.duration": { type: "histogram", attributes: [] },
		"pi.model.time_to_first_token": { type: "histogram", attributes: [] },
		"pi.turn.duration": { type: "histogram", attributes: [] },
		"pi.tool.duration": { type: "histogram", attributes: ["pi.tool.name"] },
	};
	assert.deepEqual(Object.fromEntries(METRICS.map((m) => [m.name, m.type])), Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v.type])));
	for (const [name, { attributes }] of Object.entries(expected)) {
		assert.deepEqual(byName.get(name)?.attributes, attributes, `${name}: breakdown attributes`);
	}
});

test("metric breakdown attributes are themselves registered", () => {
	for (const metric of METRICS) {
		for (const attr of metric.attributes) {
			assert.ok(lookupAttribute(attr) !== undefined, `${metric.name}: breakdown attribute "${attr}" is not registered`);
		}
	}
});

test("span hierarchy names: the five R3 spans exist as span-kind rows", () => {
	const spans = new Map(SPAN_NAMES.map((s) => [s.name, s]));
	for (const name of ["pi.session", "pi.run", "pi.turn", "pi.model", "pi.tool"]) {
		assert.equal(spans.get(name)?.kind, "span", `${name} must be a registered span`);
	}
	assert.equal(SPAN_NAMES.length, 5);
	for (const spec of EVENT_NAMES) assert.equal(spec.kind, "event");
});

test("R3's 17 span events are registered with their producing hooks", () => {
	const events = new Map(EVENT_NAMES.map((e) => [e.name, e.hook]));
	const expected: Record<string, string> = {
		"pi.session.renamed": "session_info_changed",
		"pi.session.switch": "session_before_switch",
		"pi.session.fork": "session_before_fork",
		"pi.session.compact": "session_before_compact",
		"pi.session.tree": "session_before_tree",
		"pi.resources": "project_trust",
		"pi.user.input": "input",
		"pi.user.bash": "user_bash",
		"pi.ui.prompt": "ui_prompt_start",
		"pi.model.headers": "before_provider_headers",
		"pi.model.response_status": "after_provider_response",
		"pi.session.model_change": "model_select",
		"pi.session.thinking_level_change": "thinking_level_select",
		"pi.model.cache_warming": "cache_warming_decision",
		"pi.context": "context",
		"pi.tool.outcome": "tool_call",
		"pi.run.aborted": "agent_settled",
	};
	assert.deepEqual(Object.fromEntries(events), expected);
});

test("GenAI table: the eight R4 bindings, typed", () => {
	const byName = new Map(GENAI_ATTRIBUTES.map((a) => [a.name, a.type]));
	assert.deepEqual(
		Object.fromEntries(GENAI_ATTRIBUTES.map((a) => [a.name, a.type])),
		{
			"gen_ai.system": "string",
			"gen_ai.operation.name": "string",
			"gen_ai.request.model": "string",
			"gen_ai.response.model": "string",
			"gen_ai.response.id": "string",
			"gen_ai.usage.input_tokens": "number",
			"gen_ai.usage.output_tokens": "number",
			"gen_ai.token.type": "string",
		},
	);
	assert.equal(byName.size, 8);
});

test("fail-closed lookups: known names resolve, unknown names error", () => {
	assert.equal(mustLookupAttribute("pi.session.id").type, "string");
	assert.equal(mustLookupMetric("pi.tokens").type, "counter");
	assert.equal(lookupEntity("pi.model")?.kind, "span");
	assert.equal(lookupEntity("pi.context")?.kind, "event");

	assert.throws(() => mustLookupAttribute("pi.not.a.thing"), (err: unknown) => {
		assert.ok(err instanceof SemconvError);
		assert.match((err as Error).message, /unknown attribute "pi\.not\.a\.thing"/);
		return true;
	});
	assert.throws(() => mustLookupMetric("pi.model.nope"), SemconvError);
	assert.equal(lookupAttribute("pi.not.a.thing"), undefined);
	assert.equal(lookupMetric("pi.model.nope"), undefined);
	assert.equal(lookupEntity("pi.nope"), undefined);
});

test("production twin: reportUnknownAttribute is a message, never a throw", () => {
	const message = reportUnknownAttribute("pi.suspicious");
	assert.match(message, /pi-obs semconv: attribute "pi\.suspicious" is not in the registry/);
	assert.match(message, /value dropped/);
});
