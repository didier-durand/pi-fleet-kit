/**
 * pi-obs — configuration tests (SPECS R6 ACs).
 *
 *   - precedence chain: env beats settings beats default (per key);
 *   - the complete 13-variable PI_OBS_* table is parsed, defaulted, and
 *     rejected on invalid values (non-numeric batch, negative queue,
 *     non-boolean switches, bad endpoints/headers);
 *   - inactive by default: no endpoint and no file → disabled (the
 *     master rule — stats work regardless, which later steps prove);
 *   - the settings block parses and merges without pi running.
 *
 * Pure: every case passes its own env record — the real process
 * environment is only touched (temporarily) by the
 * loadConfigFromEnv wrapper test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, defaultFilePath, expandHome, loadConfig, loadConfigFromEnv } from "../../src/config.ts";

const NO_EXPORTERS: Record<string, string | undefined> = { HOME: "/home/tester" };
const BOTH_EXPORTERS: Record<string, string | undefined> = {
	HOME: "/home/tester",
	PI_OBS_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
	PI_OBS_FILE: "1",
};

test("inactive by default: no endpoint and no file → not active", () => {
	const { config, errors } = loadConfig(NO_EXPORTERS);
	assert.deepEqual(errors, []);
	assert.equal(config.active, false);
	assert.equal(config.otlp, null);
	assert.equal(config.file, null);
	assert.equal(config.enabled, false, "default: 1 only when any exporter is configured");
});

test("defaults match the R6 table", () => {
	const { config } = loadConfig(NO_EXPORTERS);
	assert.equal(config.otlp, null);
	assert.equal(config.file, null);
	assert.equal(config.capturePrompts, false);
	assert.equal(config.captureToolIo, false);
	assert.equal(config.queueMax, 4096);
	assert.equal(config.resourceService, "pi-agent");
	assert.ok(config.version.length > 0, "extension version reported");
	assert.equal(DEFAULTS.otlpTimeoutMs, 5000);
	assert.equal(DEFAULTS.otlpBatch, 64);
	assert.equal(DEFAULTS.fileMaxBytes, 10485760);
	assert.equal(DEFAULTS.fileMaxFiles, 5);
});

test("all 13 PI_OBS_* variables parse from the environment", () => {
	const { config, errors } = loadConfig({
		HOME: "/home/tester",
		PI_OBS_ENABLED: "1",
		PI_OBS_OTLP_ENDPOINT: "http://collector:4318/v1/traces",
		PI_OBS_OTLP_HEADERS: "x-a=1,x-b=two",
		PI_OBS_OTLP_TIMEOUT_MS: "250",
		PI_OBS_OTLP_BATCH: "8",
		PI_OBS_FILE: "1",
		PI_OBS_FILE_PATH: "/tmp/obs/custom.jsonl",
		PI_OBS_FILE_MAX_BYTES: "1024",
		PI_OBS_FILE_MAX_FILES: "2",
		PI_OBS_CAPTURE_PROMPTS: "1",
		PI_OBS_CAPTURE_TOOL_IO: "true",
		PI_OBS_QUEUE_MAX: "128",
		PI_OBS_RESOURCE_SERVICE: "my-fleet",
	});
	assert.deepEqual(errors, []);
	assert.equal(config.active, true);
	assert.equal(config.otlp?.endpoint, "http://collector:4318/v1/traces");
	assert.deepEqual(config.otlp?.headers, { "x-a": "1", "x-b": "two" });
	assert.equal(config.otlp?.timeoutMs, 250);
	assert.equal(config.otlp?.batch, 8);
	assert.equal(config.file?.path, "/tmp/obs/custom.jsonl");
	assert.equal(config.file?.maxBytes, 1024);
	assert.equal(config.file?.maxFiles, 2);
	assert.equal(config.capturePrompts, true);
	assert.equal(config.captureToolIo, true);
	assert.equal(config.queueMax, 128);
	assert.equal(config.resourceService, "my-fleet");
});

test("precedence: env beats settings beats default (per key)", () => {
	// queueMax: default 4096 < settings 128 < env 64
	assert.equal(loadConfig(NO_EXPORTERS).config.queueMax, 4096);
	assert.equal(loadConfig(NO_EXPORTERS, { queueMax: 128 }).config.queueMax, 128);
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_QUEUE_MAX: "64" }, { queueMax: 128 }).config.queueMax, 64);

	// file exporter: off by default < settings on < env forces off
	assert.equal(loadConfig(NO_EXPORTERS).config.file, null);
	assert.equal(loadConfig(NO_EXPORTERS, { file: true }).config.file?.path, "/home/tester/.pi/obs/pi-obs.jsonl");
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_FILE: "0" }, { file: true }).config.file, null);

	// timeout: settings 999 beaten by env 5
	assert.equal(loadConfig({ ...BOTH_EXPORTERS, PI_OBS_OTLP_TIMEOUT_MS: "5" }, { otlpTimeoutMs: 999 }).config.otlp?.timeoutMs, 5);

	// resource service: settings value wins when env is absent
	assert.equal(loadConfig(NO_EXPORTERS, { resourceService: "from-settings" }).config.resourceService, "from-settings");
});

test("settings block parses and merges without pi running", () => {
	const { config, errors } = loadConfig(NO_EXPORTERS, {
		otlpEndpoint: "http://from-settings:4318",
		otlpBatch: 32,
		file: 1,
		filePath: "~/obs/settings.jsonl",
		capturePrompts: true,
	});
	assert.deepEqual(errors, []);
	assert.equal(config.active, true);
	assert.equal(config.otlp?.endpoint, "http://from-settings:4318");
	assert.equal(config.otlp?.batch, 32);
	assert.equal(config.file?.path, "/home/tester/obs/settings.jsonl");
	assert.equal(config.capturePrompts, true);
});

test("unknown settings keys are reported (typo protection)", () => {
	const { errors } = loadConfig(NO_EXPORTERS, { otlpEndpint: "http://x:4318" });
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /unknown key "otlpEndpint"/);
});

test("invalid values are rejected with a named error, default stands (never throws)", () => {
	// every exporter branch ON so each variable is actually evaluated
	const { config, errors } = loadConfig({
		...BOTH_EXPORTERS,
		PI_OBS_OTLP_BATCH: "abc", // non-numeric batch
		PI_OBS_QUEUE_MAX: "-5", // negative queue
		PI_OBS_FILE_MAX_BYTES: "0", // below the minimum
		PI_OBS_FILE_MAX_FILES: "two",
		PI_OBS_OTLP_TIMEOUT_MS: "1.5",
		PI_OBS_CAPTURE_PROMPTS: "yes", // not a boolean
		PI_OBS_ENABLED: "on",
	});
	const expect = (fragment: string) =>
		assert.ok(errors.some((e) => e.includes(fragment)), `missing "${fragment}" in: ${errors.join(" | ")}`);
	expect('PI_OBS_OTLP_BATCH: expected an integer ≥ 1, got "abc"');
	expect('PI_OBS_QUEUE_MAX: expected an integer ≥ 1, got "-5"');
	expect('PI_OBS_FILE_MAX_BYTES: expected an integer ≥ 1, got "0"');
	expect('PI_OBS_FILE_MAX_FILES: expected an integer ≥ 1, got "two"');
	expect('PI_OBS_OTLP_TIMEOUT_MS: expected an integer ≥ 1, got "1.5"');
	expect('PI_OBS_CAPTURE_PROMPTS: expected 0 or 1, got "yes"');
	expect('PI_OBS_ENABLED: expected 0 or 1, got "on"');
	// every rejected value falls back to its default; the run continues
	assert.equal(config.otlp?.batch, DEFAULTS.otlpBatch);
	assert.equal(config.queueMax, DEFAULTS.queueMax);
	assert.equal(config.capturePrompts, false);
	assert.equal(config.file?.maxBytes, DEFAULTS.fileMaxBytes);
	assert.equal(config.file?.maxFiles, DEFAULTS.fileMaxFiles);
	assert.equal(config.active, true, "the valid exporters still work");

	// a non-boolean FILE value disables that exporter, flagged by name
	const { config: badFile, errors: fileErrors } = loadConfig({
		...BOTH_EXPORTERS,
		PI_OBS_FILE: "maybe",
	});
	assert.ok(fileErrors.some((e) => e.includes('PI_OBS_FILE: expected 0 or 1, got "maybe"')), fileErrors.join("|"));
	assert.equal(badFile.file, null);
	assert.equal(badFile.active, true, "the valid OTLP endpoint still works");
});

test("endpoint validation: bad URL, non-http scheme, and good cases", () => {
	assert.ok(loadConfig({ ...NO_EXPORTERS, PI_OBS_OTLP_ENDPOINT: "not-a-url" }).errors[0]?.includes("expected an http(s) URL"));
	assert.ok(loadConfig({ ...NO_EXPORTERS, PI_OBS_OTLP_ENDPOINT: "ftp://collector:4318" }).errors[0]?.includes("expected an http(s) URL"));
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces" }).config.otlp?.endpoint, "http://127.0.0.1:4318/v1/traces");
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_OTLP_ENDPOINT: "https://collector.example/v1/traces" }).config.otlp?.endpoint, "https://collector.example/v1/traces");
});

test("headers: k=v,k=v parsing, empty input, malformed segment", () => {
	assert.deepEqual(loadConfig({ ...BOTH_EXPORTERS, PI_OBS_OTLP_HEADERS: "a=1,b=2" }).config.otlp?.headers, { a: "1", b: "2" });
	assert.deepEqual(loadConfig(BOTH_EXPORTERS).config.otlp?.headers, {});
	const withEquals = loadConfig({ ...BOTH_EXPORTERS, PI_OBS_OTLP_HEADERS: "authorization=Bearer x=y" });
	assert.deepEqual(withEquals.config.otlp?.headers, { authorization: "Bearer x=y" }, "value may contain '='");
	const malformed = loadConfig({ ...BOTH_EXPORTERS, PI_OBS_OTLP_HEADERS: "good=1,=novalue,alsogood=2" });
	assert.ok(malformed.errors.some((e) => e.includes('malformed segment "=novalue"')), malformed.errors.join("|"));
	assert.deepEqual(malformed.config.otlp?.headers, { good: "1", alsogood: "2" });
});

test("master rule: active requires an exporter, even when ENABLED=1", () => {
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_ENABLED: "1" }).config.active, false, "no exporter → inactive");
	assert.equal(loadConfig(BOTH_EXPORTERS).config.active, true);
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_OTLP_ENDPOINT: "http://x:4318" }).config.active, true);
	assert.equal(loadConfig({ ...NO_EXPORTERS, PI_OBS_FILE: "1" }).config.active, true);
	assert.equal(loadConfig({ ...BOTH_EXPORTERS, PI_OBS_ENABLED: "0" }).config.active, false, "explicit off wins over configured exporters");
	assert.equal(loadConfig({ ...BOTH_EXPORTERS, PI_OBS_ENABLED: "0" }).config.enabled, false);
});

test("file path default: PI_SERVE_DIR respected, ~ expanded, never a session dir", () => {
	assert.equal(defaultFilePath({ HOME: "/home/t", PI_SERVE_DIR: "/srv/obs" }), "/srv/obs/obs/pi-obs.jsonl");
	assert.equal(defaultFilePath({ HOME: "/home/t" }), "/home/t/.pi/obs/pi-obs.jsonl");
	assert.equal(defaultFilePath({}), "~/.pi/obs/pi-obs.jsonl", "no HOME → left as ~ for the wiring to resolve");
	assert.equal(expandHome("~/x/y", { HOME: "/h" }), "/h/x/y");
	assert.equal(expandHome("/abs/path", { HOME: "/h" }), "/abs/path");
	assert.equal(expandHome("~", { HOME: "/h" }), "/h");
	const { config } = loadConfig({ HOME: "/home/t", PI_OBS_FILE: "1" });
	assert.equal(config.file?.path, "/home/t/.pi/obs/pi-obs.jsonl");
	const { config: serve } = loadConfig({ HOME: "/home/t", PI_OBS_FILE: "1", PI_SERVE_DIR: "/data/serve" });
	assert.equal(serve.file?.path, "/data/serve/obs/pi-obs.jsonl");
});

test("loadConfigFromEnv reads the real process environment (wrapper)", () => {
	const key = "PI_OBS_QUEUE_MAX";
	const had = process.env[key];
	try {
		process.env[key] = "77";
		assert.equal(loadConfigFromEnv().config.queueMax, 77);
	} finally {
		if (had === undefined) delete process.env[key];
		else process.env[key] = had;
	}
});
