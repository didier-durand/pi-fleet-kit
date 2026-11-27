/**
 * pi-obs — the version, derived from package.json (single source of truth).
 *
 * TypeScript/npm convention: the package version lives ONLY in
 * package.json; code never hardcodes it. This module reads it once at
 * load and every consumer (the OTel resource, instrumentation scopes,
 * the piobs CLI, the replay report) derives from here — bump with
 * `npm version <patch|minor|major>` and everything follows.
 *
 * Robust in every layout: the repository tree, the `npm pack` tarball
 * (package.json ships beside src/), and inside pi's jiti (plain
 * node:fs + a standard import.meta.url — no JSON-import attributes,
 * no import.meta.dirname, nothing jiti doesn't provide). If the file
 * is somehow unreadable the fallback is an OBVIOUSLY-wrong
 * `0.0.0-unknown` — never a silently-stale number, and never a crash
 * (R1: a version string must not take the agent down).
 */

import { readFileSync } from "node:fs";

/** The package manifest path (overridable for tests — see version.test.ts). */
export function readVersion(manifest: URL = new URL("../package.json", import.meta.url)): string {
	try {
		const doc = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
		return typeof doc.version === "string" && doc.version.length > 0 ? doc.version : "0.0.0-unknown";
	} catch {
		return "0.0.0-unknown";
	}
}

/** The extension version, from package.json (the only place it is defined). */
export const PI_OBS_VERSION: string = readVersion();
