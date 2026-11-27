/**
 * pi-obs — version convention test: package.json is the single source
 * of truth; PI_OBS_VERSION derives from it (src/version.ts). This is
 * the anti-drift guarantee: bump one, everything follows — a hardcoded
 * copy anywhere would fail here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PI_OBS_VERSION } from "../../src/version.ts";

test("the version derives from package.json (single source of truth)", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
	assert.equal(PI_OBS_VERSION, manifest.version);
	assert.match(PI_OBS_VERSION, /^\d+\.\d+\.\d+/); // semver, never the unknown fallback
});

test("no hardcoded version duplicate in src/ (the constant is derived)", async () => {
	const semconv = await import("../../src/semconv.ts");
	assert.equal(semconv.PI_OBS_VERSION, PI_OBS_VERSION);
});

test("readVersion: unreadable manifest and non-string versions degrade to the sentinel", async () => {
	const { readVersion } = await import("../../src/version.ts");
	// unreadable manifest (R1: never a crash, always an OBVIOUSLY-wrong value)
	assert.equal(readVersion(new URL("file:///nonexistent/package.json")), "0.0.0-unknown");
	// a manifest whose version is not a non-empty string (number, empty)
	const { writeFileSync, rmSync, mkdtempSync } = await import("node:fs");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "piobs-version-"));
	try {
		const bad = join(dir, "package.json");
		writeFileSync(bad, JSON.stringify({ version: 123 }));
		assert.equal(readVersion(new URL(`file://${bad}`)), "0.0.0-unknown");
		writeFileSync(bad, JSON.stringify({ version: "" }));
		assert.equal(readVersion(new URL(`file://${bad}`)), "0.0.0-unknown");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
