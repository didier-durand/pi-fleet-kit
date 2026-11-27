/**
 * Daily TypeScript security & efficiency audit for the fleet's extensions.
 *
 * Runs ESLint (typescript-eslint strictTypeChecked + security + regexp +
 * sonarjs) over every TypeScript file under extensions/, produces the
 * Markdown report via the json-to-md ESLint formatter, writes it to
 * docs/audits/ (canonical latest + timestamped archive per run), emits a
 * GitHub job summary when running in Actions, and splices a summary
 * section into README.md between markers.
 *
 * Exit codes: 0 = audit ran (findings or not — the report is informational
 * and the summary table carries the status); >0 = infrastructure failure
 * (fatal parse errors, unwritable output). A failing audit never blocks the
 * report commit: the workflow continues on lint findings by design.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

import { summarize, toJobSummary } from "./lib/report.mjs";
import { spliceAuditSection } from "./lib/readme.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIG = path.join(import.meta.dirname, "eslint.config.mjs");
const FORMATTER = path.join(import.meta.dirname, "formatters", "json-to-md.mjs");
const REPORT_DIR = path.join(ROOT, "docs", "audits");
// Canonical "latest" file the README links to (stable name) — alongside a
// timestamped archive per run (date AND time, UTC, sortable).
const REPORT = path.join(REPORT_DIR, "ts-audit.md");
const README = path.join(ROOT, "README.md");

// "2026-11-27T09:41:52.123Z" → "2026-11-27T09-41" (filename-safe)
function archiveStamp(iso) {
	return iso.slice(0, 16).replaceAll(":", "-");
}

// CI passes the exact commit being audited; local runs fall back to HEAD.
function currentCommit() {
	if (process.env.GIT_SHA) return process.env.GIT_SHA;
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
	} catch {
		return "(unknown)";
	}
}

async function main() {
	const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG });
	const results = await eslint.lintFiles(["extensions/**/*.ts"]);

	const fatal = results.flatMap((r) => r.messages.filter((m) => m.fatal));
	if (fatal.length > 0) {
		console.error("Fatal parse errors — audit cannot produce a trustworthy report:");
		for (const m of fatal) console.error(`  ${m.message}`);
		process.exitCode = 2;
		return;
	}

	const meta = {
		generatedAt: new Date().toISOString(),
		commit: currentCommit(),
		eslintVersion: ESLint.version,
		root: ROOT,
	};

	// The report is produced by the json-to-md ESLint formatter — the same
	// module `eslint --format json-to-md` would load.
	const formatter = await eslint.loadFormatter(FORMATTER);
	const md = formatter.format(results, meta);

	fs.mkdirSync(REPORT_DIR, { recursive: true });
	const archive = path.join(REPORT_DIR, `ts-audit-${archiveStamp(meta.generatedAt)}.md`);
	fs.writeFileSync(archive, md, "utf8");
	fs.writeFileSync(REPORT, md, "utf8");

	const readme = fs.readFileSync(README, "utf8");
	const summary = [
		"## TypeScript audit",
		"",
		md
			.split("\n")
			.filter((l) => l.startsWith("| Errors |") || l.startsWith("| Warnings |") || l.startsWith("| Files scanned |") || l.startsWith("| Rules triggered |"))
			.join(" · ")
			.replaceAll("|", "")
			.replaceAll("  ", " ")
			.trim(),
		"",
		`Full report: [docs/audits/ts-audit.md](docs/audits/ts-audit.md) — refreshed daily at 05:00 by the \`ts-audit\` workflow.`,
	].join("\n");

	const updated = spliceAuditSection(readme, summary);
	if (updated !== readme) fs.writeFileSync(README, updated, "utf8");

	// GitHub job summary — the run page renders this as Markdown.
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`${toJobSummary(results, meta)}\n\nArchive: \`${path.relative(ROOT, archive)}\`.\n`,
			"utf8",
		);
	}

	const s = summarize(results);
	console.log(`Audit complete: ${s.errors} errors, ${s.warnings} warnings across ${s.files} files.`);
	console.log(
		`Report: ${path.relative(ROOT, REPORT)} · archive: ${path.relative(ROOT, archive)}` +
			(updated !== readme ? " · README section updated" : " · README unchanged"),
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 2;
});
