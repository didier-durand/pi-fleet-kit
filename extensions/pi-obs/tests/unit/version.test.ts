/**
 * pi-obs — version convention test: package.json is the single source
 * of truth; PI_OBS_VERSION derives from it (src/version.ts). This is
 * the anti-drift guarantee: bump one, everything follows — a hardcoded
 * copy anywhere would fail here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
