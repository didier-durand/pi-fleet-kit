/**
 * pi-obs — standalone CLI (`bin/piobs`, SPECS R3b).
 *
 * The post-mortem report engine outside the pi process: same resolution
 * rules (header-authoritative id scan or verbatim path), same replay
 * engine, same R2 opt-in/redaction rules, same OTLP/JSON-per-line
 * output — plus what the in-pi `/pi-obs report` command could never
 * control: PROCESS EXIT CODES.
 *
 *   piobs report <session-id | path> [session-dir] [flags]
 *   piobs version
 *   piobs --help | piobs report --help
 *
 * Exit codes: 0 success · 1 replay/IO error · 2 usage error.
 *
 * Pure node (>= 23.6 for type stripping), zero dependencies; the
 * configuration follows R6 (env > settings block > defaults), with
 * CLI flags overriding the environment.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, readSettingsPiObsBlock } from "./config.ts";
import { OtlpExporter } from "./exporters/otlp.ts";
import { FileExporter } from "./exporters/file.ts";
import { replayReport } from "./replay.ts";
import { PI_OBS_VERSION } from "./semconv.ts";

/** The CLI's understanding of parsed arguments. */
export interface CliArgs {
	command: "report" | "version" | "help";
	/** report: the session id or file path. */
	target?: string;
	/** report: optional session directory (id resolution). */
	sessionDir?: string;
	branch?: string;
	file?: string;
	otlp?: boolean;
	endpoint?: string;
	capturePrompts?: boolean;
	captureToolIo?: boolean;
	service?: string;
	sessionsDir?: string;
}

/** A usage error — exit code 2 with the help hint. */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export const HELP = `piobs — pi-obs post-mortem reports (OpenTelemetry for finished pi sessions)

Usage:
  piobs report <session-id | path> [session-dir] [flags]
                                    Emit an OTLP/JSON-per-line report of a
                                    finished session on stdout (one complete
                                    OTLP export-request body per line — pipes
                                    straight into otelcol or jq).
  piobs version                     Print the pi-obs version.
  piobs --help                      This help.

Arguments:
  <session-id>                      Resolved against the sessions directory
                                    by scanning file HEADERS (the header id
                                    is authoritative — file names are not).
  <path>                            A session .jsonl file, used verbatim.
  [session-dir]                     Optional session directory for id
                                    resolution (default: --sessions-dir).

Report flags:
      --branch=<entry-id>           Select the branch ending at this entry
                                    (default: the file's active branch).
      --file=<path>                 ALSO write the report to a file (the
                                    same OTLP/JSON-per-line encoding; the
                                    R2 session-directory rule applies).
      --otlp                        ALSO POST the report to the OTLP/HTTP
                                    endpoint (needs --endpoint or
                                    PI_OBS_OTLP_ENDPOINT).
      --endpoint=<url>              OTLP endpoint for --otlp (default:
                                    PI_OBS_OTLP_ENDPOINT, then the settings
                                    block).
      --capture-prompts             R2 opt-in: verbatim prompt/completion
                                    text (the documented redaction list is
                                    applied; default: length + hash only).
      --capture-tool-io             R2 opt-in: tool result bodies (redacted).
      --service=<name>              OTel service.name for the report
                                    resource (default: pi-agent).
      --sessions-dir=<dir>          Default sessions directory for id
                                    resolution (default:
                                    ~/.pi/agent/sessions).

Configuration (R6 precedence: flag > environment > settings block > default):
  PI_OBS_OTLP_ENDPOINT, PI_OBS_CAPTURE_PROMPTS, PI_OBS_CAPTURE_TOOL_IO,
  PI_OBS_RESOURCE_SERVICE, PI_HOME, PI_SERVE_DIR — see the README table.

Exit codes:
  0   success
  1   replay/IO error (unknown id, ambiguous id, unreadable file, the
      R2 session-directory rule, a failed export)
  2   usage error (unknown flag, missing argument)`;

const FLAG_MAP: Record<string, keyof CliArgs> = {
	"--branch": "branch",
	"--file": "file",
	"--endpoint": "endpoint",
	"--service": "service",
	"--sessions-dir": "sessionsDir",
};

/** Parse CLI arguments. Throws CliUsageError on bad grammar. */
export function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = { command: "help" };
	const positional: string[] = [];
	let sawHelp = false;
	for (const token of argv) {
		if (token === "--help" || token === "-h") {
			sawHelp = true;
			continue;
		}
		if (token === "--otlp") {
			args.otlp = true;
			continue;
		}
		if (token === "--capture-prompts") {
			args.capturePrompts = true;
			continue;
		}
		if (token === "--capture-tool-io") {
			args.captureToolIo = true;
			continue;
		}
		if (token.startsWith("--") && token.includes("=")) {
			const key = token.slice(0, token.indexOf("="));
			const value = token.slice(token.indexOf("=") + 1);
			const field = FLAG_MAP[key];
			if (field === undefined) throw new CliUsageError(`unknown flag "${key}"`);
			if (value === "") throw new CliUsageError(`flag "${key}" needs a value`);
			(args as unknown as Record<string, string>)[field] = value;
			continue;
		}
		if (token.startsWith("--")) throw new CliUsageError(`unknown flag "${token}" (flags with values use --flag=value)`);
		positional.push(token);
	}
	if (sawHelp) return { command: "help" };

	const [command, ...rest] = positional;
	if (command === undefined) return { command: "help" };
	if (command === "version") {
		if (rest.length > 0) throw new CliUsageError(`unexpected argument "${rest[0]}" after version`);
		return { command: "version" };
	}
	if (command === "report") {
		if (rest.length === 0) throw new CliUsageError("report needs a <session-id | path> argument");
		if (rest.length > 2) throw new CliUsageError(`unexpected argument "${rest[2]}" (at most <target> [session-dir])`);
		args.command = "report";
		args.target = rest[0];
		if (rest[1] !== undefined) args.sessionDir = rest[1];
		return args;
	}
	throw new CliUsageError(`unknown command "${command}" (commands: report, version)`);
}

/** IO abstraction so tests drive runCli without spawning. */
export interface CliIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

const defaultIo: CliIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Run the CLI; returns the process exit code (0/1/2). Never throws. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	let args: CliArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		io.stderr(String(error)); // R1: String() keeps the message (subclass prefix included) without a dead non-Error arm
		io.stderr("usage: piobs report <session-id | path> [session-dir] [flags] — try 'piobs --help'");
		return 2;
	}

	if (args.command === "help") {
		io.stdout(HELP);
		return 0;
	}
	if (args.command === "version") {
		io.stdout(`piobs ${PI_OBS_VERSION} (pi-obs)`);
		return 0;
	}

	// report: configuration follows R6 (env > settings > default); flags override
	const config = loadConfig(env, readSettingsPiObsBlock()).config;
	const capturePrompts = args.capturePrompts ?? config.capturePrompts;
	const captureToolIo = args.captureToolIo ?? config.captureToolIo;
	const endpoint = args.endpoint ?? config.otlp?.endpoint ?? null;

	try {
		const target = args.target as string; // parseArgs guarantees it for command "report"
		const isPath = target.includes("/") || target.endsWith(".jsonl");
		if (args.sessionDir !== undefined && isPath) {
			io.stderr(`piobs: unexpected second argument "${args.sessionDir}" (a [session-dir] may only follow a session ID)`);
			return 2;
		}
		const sessionsDir = args.sessionsDir ?? join(env.PI_HOME ?? join(homedir(), ".pi"), "agent", "sessions");
		const report = replayReport(
			isPath ? { path: target } : { sessionDir: args.sessionDir ?? sessionsDir, sessionId: target },
			{
				branchEntryId: args.branch,
				capturePrompts,
				captureToolIo,
				resourceService: args.service ?? config.resourceService,
			},
		);
		for (const line of report.lines) io.stdout(line);

		if (args.otlp === true) {
			if (endpoint === null) {
				io.stderr("piobs: --otlp needs an endpoint (--endpoint=<url>, PI_OBS_OTLP_ENDPOINT, or the settings block)");
				return 1;
			}
			await new OtlpExporter({ endpoint, resource: report.resource }).export(report.items);
			io.stderr(`piobs: posted ${report.items.length} record(s) to ${endpoint}`);
		}
		if (args.file !== undefined) {
			await new FileExporter({
				path: args.file,
				maxBytes: config.file?.maxBytes ?? 10485760,
				maxFiles: config.file?.maxFiles ?? 5,
				resource: report.resource,
			}).export(report.items);
			io.stderr(`piobs: wrote ${report.lines.length} line(s) to ${args.file}`);
		}
		return 0;
	} catch (error) {
		io.stderr(String(error)); // R1: String() keeps the message (subclass prefix included) without a dead non-Error arm
		return 1;
	}
}

// standalone entry (the bin/piobs wrapper execs node on this file)
if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2));
}
