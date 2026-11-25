/**
 * pi-obs — configuration (SPECS R6).
 *
 * The complete `PI_OBS_*` surface as one pure resolver:
 *
 *   precedence : environment variable > settings.json `pi-obs` block > default
 *   master rule: telemetry is INACTIVE by default until an exporter is
 *                configured (PI_OBS_OTLP_ENDPOINT or PI_OBS_FILE=1);
 *                the stats command works regardless.
 *
 * Resolution never throws: invalid values are collected as human-readable
 * errors and the default is kept for that key (R1 — a bad config must
 * never take the agent down; the wiring reports the errors on stderr).
 *
 * Settings block (camelCase keys, mirroring the variables minus the
 * `PI_OBS_` prefix):
 *
 *   { "pi-obs": { "otlpEndpoint": "...", "queueMax": 128, … } }
 *
 * Pure module: no pi imports; `loadConfig(env, settings)` is given the
 * environment explicitly so tests drive the precedence chain without pi
 * running and without mutating the real process environment.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PI_OBS_VERSION } from "./semconv.ts";

/** Read the `pi-obs` block from ${PI_HOME:-~/.pi}/agent/settings.json (R6). */
export function readSettingsPiObsBlock(): Record<string, unknown> | undefined {
	try {
		const home = process.env.PI_HOME ?? join(homedir(), ".pi");
		const raw = JSON.parse(readFileSync(join(home, "agent", "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw["pi-obs"];
		return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : undefined;
	} catch {
		return undefined; // no settings file, unreadable, or bad JSON: env + defaults stand (R1)
	}
}

/** Resolved OTLP exporter configuration (null when not configured). */
export interface OtlpConfig {
	endpoint: string;
	/** Extra headers parsed from `k=v,k=v`. */
	headers: Record<string, string>;
	/** Per-request timeout, ms. */
	timeoutMs: number;
	/** Records per OTLP request. */
	batch: number;
}

/** Resolved file-exporter configuration (null when not configured). */
export interface FileConfig {
	/** Target log file (default never inside a session directory — R2). */
	path: string;
	/** Rotation size per file, bytes. */
	maxBytes: number;
	/** Rotated files kept, oldest dropped. */
	maxFiles: number;
}

/** Fully resolved pi-obs configuration. */
export interface PiObsConfig {
	/** Master switch as configured (explicit PI_OBS_ENABLED or its default). */
	enabled: boolean;
	/** Telemetry active = enabled && an exporter is configured (R6 master rule). */
	active: boolean;
	/** OTLP exporter settings, or null when unset/invalid. */
	otlp: OtlpConfig | null;
	/** File exporter settings, or null when unset/invalid. */
	file: FileConfig | null;
	/** R2 opt-in: verbatim prompt/completion text. */
	capturePrompts: boolean;
	/** R2 opt-in: tool result bodies. */
	captureToolIo: boolean;
	/** Bounded queue size (R1/R5). */
	queueMax: number;
	/** OTel `service.name` resource attribute. */
	resourceService: string;
	/** Extension version — the `service.version` resource attribute. */
	version: string;
}

/** `loadConfig` result: the resolution plus every validation error. */
export interface ConfigResult {
	config: PiObsConfig;
	/** Human-readable, one per invalid value: `PI_OBS_X: message`. */
	errors: string[];
}

/** Documented defaults (SPECS R6 table) — exported for tests and docs. */
export const DEFAULTS = {
	otlpTimeoutMs: 5000,
	otlpBatch: 64,
	fileMaxBytes: 10485760, // 10 MiB
	fileMaxFiles: 5,
	queueMax: 4096,
	resourceService: "pi-agent",
	capturePrompts: false,
	captureToolIo: false,
} as const;

/** Settings-block keys (camelCase), one per variable — the typo-checked surface. */
const SETTINGS_KEYS = [
	"enabled",
	"otlpEndpoint",
	"otlpHeaders",
	"otlpTimeoutMs",
	"otlpBatch",
	"file",
	"filePath",
	"fileMaxBytes",
	"fileMaxFiles",
	"capturePrompts",
	"captureToolIo",
	"queueMax",
	"resourceService",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** The default file-exporter target: `${PI_SERVE_DIR:-~/.pi}/obs/pi-obs.jsonl`. */
export function defaultFilePath(env: Record<string, string | undefined>): string {
	const base = env.PI_SERVE_DIR && env.PI_SERVE_DIR.trim() !== "" ? env.PI_SERVE_DIR : "~/.pi";
	return expandHome(`${base}/obs/pi-obs.jsonl`, env);
}

/** Expand a leading `~` to the home directory (undefined stays as-is). */
export function expandHome(path: string, env: Record<string, string | undefined>): string {
	if (path === "~") return env.HOME ?? path;
	if (path.startsWith("~/")) return env.HOME !== undefined ? `${env.HOME}${path.slice(1)}` : path;
	return path;
}

/** Parse a 0/1/true/false value; returns undefined when not a boolean. */
function parseBool(raw: string): boolean | undefined {
	const v = raw.trim().toLowerCase();
	if (v === "1" || v === "true") return true;
	if (v === "0" || v === "false") return false;
	return undefined;
}

/** Parse a positive integer (≥ min); returns undefined when invalid. */
function parseIntAtLeast(raw: string, min: number): number | undefined {
	const v = raw.trim();
	if (!/^[+-]?\d+$/.test(v)) return undefined;
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < min) return undefined;
	return n;
}

/** Parse `k=v,k=v` headers; empty segments are skipped, well-formed
 *  segments after a malformed one still parse, and the first malformed
 *  segment is reported (the whole value never silently vanishes). */
function parseHeaders(raw: string): { headers: Record<string, string>; bad: string | null } {
	const headers: Record<string, string> = {};
	let bad: string | null = null;
	for (const segment of raw.split(",")) {
		const s = segment.trim();
		if (s === "") continue;
		const eq = s.indexOf("=");
		if (eq <= 0) {
			if (bad === null) bad = s;
			continue;
		}
		headers[s.slice(0, eq)] = s.slice(eq + 1);
	}
	return { headers, bad };
}

/** Validate an OTLP endpoint: an absolute http(s) URL. */
function parseEndpoint(raw: string): URL | null {
	try {
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url;
	} catch {
		return null;
	}
}

/**
 * Resolve the configuration. `env` is the environment (pass
 * `process.env` in production); `settings` is the parsed `pi-obs` block
 * from settings.json, when present. Invalid values never throw — they
 * are collected in `errors` and the default stands.
 */
export function loadConfig(
	env: Record<string, string | undefined>,
	settings?: Record<string, unknown>,
): ConfigResult {
	const errors: string[] = [];

	// --- settings block: unknown keys are reported (typo protection) ------
	const s: Partial<Record<SettingsKey, unknown>> = {};
	if (settings !== undefined) {
		for (const [key, value] of Object.entries(settings)) {
			const known = SETTINGS_KEYS.includes(key as SettingsKey);
			if (!known) {
				errors.push(`pi-obs settings: unknown key "${key}" (see the R6 table)`);
				continue;
			}
			s[key as SettingsKey] = value;
		}
	}

	/** Precedence: env > settings > default, string-typed. */
	const str = (envKey: string, settingsKey: SettingsKey): string | undefined => {
		const fromEnv = env[envKey];
		if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
		const fromSettings = s[settingsKey];
		if (fromSettings !== undefined && fromSettings !== null && String(fromSettings).trim() !== "") {
			return String(fromSettings);
		}
		return undefined;
	};

	/** Precedence: env > settings > default, boolean-typed. */
	const bool = (
		envKey: string,
		settingsKey: SettingsKey,
		fallback: boolean,
	): boolean => {
		const raw = str(envKey, settingsKey);
		if (raw === undefined) return fallback;
		const parsed = parseBool(raw);
		if (parsed === undefined) {
			errors.push(`${envKey}: expected 0 or 1, got "${raw.trim()}"`);
			return fallback;
		}
		return parsed;
	};

	/** Precedence: env > settings > default, integer-typed (≥ min). */
	const int = (
		envKey: string,
		settingsKey: SettingsKey,
		fallback: number,
		min: number,
	): number => {
		const raw = str(envKey, settingsKey);
		if (raw === undefined) return fallback;
		const parsed = parseIntAtLeast(raw, min);
		if (parsed === undefined) {
			errors.push(`${envKey}: expected an integer ≥ ${min}, got "${raw.trim()}"`);
			return fallback;
		}
		return parsed;
	};

	// --- OTLP exporter -----------------------------------------------------
	let otlp: OtlpConfig | null = null;
	const endpointRaw = str("PI_OBS_OTLP_ENDPOINT", "otlpEndpoint");
	if (endpointRaw !== undefined) {
		if (parseEndpoint(endpointRaw) === null) {
			errors.push(`PI_OBS_OTLP_ENDPOINT: expected an http(s) URL, got "${endpointRaw.trim()}"`);
		} else {
			const headersRaw = str("PI_OBS_OTLP_HEADERS", "otlpHeaders") ?? "";
			const { headers, bad } = parseHeaders(headersRaw);
			if (bad !== null) {
				errors.push(`PI_OBS_OTLP_HEADERS: malformed segment "${bad}" (expected k=v,k=v)`);
			}
			otlp = {
				endpoint: endpointRaw.trim(),
				headers,
				timeoutMs: int("PI_OBS_OTLP_TIMEOUT_MS", "otlpTimeoutMs", DEFAULTS.otlpTimeoutMs, 1),
				batch: int("PI_OBS_OTLP_BATCH", "otlpBatch", DEFAULTS.otlpBatch, 1),
			};
		}
	}

	// --- file exporter -----------------------------------------------------
	let file: FileConfig | null = null;
	const fileOn = bool("PI_OBS_FILE", "file", false);
	if (fileOn) {
		const pathRaw = str("PI_OBS_FILE_PATH", "filePath") ?? defaultFilePath(env);
		file = {
			path: expandHome(pathRaw, env),
			maxBytes: int("PI_OBS_FILE_MAX_BYTES", "fileMaxBytes", DEFAULTS.fileMaxBytes, 1),
			maxFiles: int("PI_OBS_FILE_MAX_FILES", "fileMaxFiles", DEFAULTS.fileMaxFiles, 1),
		};
	}

	// --- master switch (R6: default "1 when any exporter is configured") --
	const exporterConfigured = otlp !== null || file !== null;
	const enabled = bool("PI_OBS_ENABLED", "enabled", exporterConfigured);

	return {
		errors,
		config: {
			enabled,
			active: enabled && exporterConfigured,
			otlp,
			file,
			capturePrompts: bool("PI_OBS_CAPTURE_PROMPTS", "capturePrompts", DEFAULTS.capturePrompts),
			captureToolIo: bool("PI_OBS_CAPTURE_TOOL_IO", "captureToolIo", DEFAULTS.captureToolIo),
			queueMax: int("PI_OBS_QUEUE_MAX", "queueMax", DEFAULTS.queueMax, 1),
			resourceService: str("PI_OBS_RESOURCE_SERVICE", "resourceService") ?? DEFAULTS.resourceService,
			version: PI_OBS_VERSION,
		},
	};
}

/** Production entry point: resolve from the real environment + settings. */
export function loadConfigFromEnv(settings?: Record<string, unknown>): ConfigResult {
	return loadConfig(process.env, settings);
}
