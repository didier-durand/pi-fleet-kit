#!/usr/bin/env bash
# Runs the unit tests of an extension under V8 code coverage (c8) and emits
# a Markdown report — to $GITHUB_STEP_SUMMARY when defined, stdout otherwise.
# Usage: run-tests.sh <extension-dir-name>
#
# Zero repo dependencies: c8 is installed ephemerally (--no-save, like tsc in
# check-extension.sh); the tests themselves run on Node's built-in test
# runner with native TypeScript type stripping (Node >= 23.6).
set -euo pipefail

NAME="${1:?usage: run-tests.sh <extension-dir-name>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../extensions/$NAME" && pwd)"
[[ -d "$DIR" ]] || { echo "error: no extension dir: $DIR" >&2; exit 1; }
cd "$DIR"

SUMMARY="${GITHUB_STEP_SUMMARY:-}"

npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund c8 >/dev/null 2>&1

# Human output to the console; TAP to a file for counting; JSON coverage for
# the summary table.
rm -rf .coverage .tap.out
npx c8 --reporter=json --reports-dir=.coverage \
	node --test \
	--test-reporter=spec --test-reporter-destination=stdout \
	--test-reporter=tap --test-reporter-destination=.tap.out

PASS="$(grep -c '^ok ' .tap.out || true)"
FAIL="$(grep -c '^not ok ' .tap.out || true)"

# Markdown table from c8's istanbul JSON (coverage-final.json)
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
const dir = ".coverage";
const file = readdirSync(dir).find((f) => f.endsWith("coverage-final.json"));
if (!file) { console.log("| Metric | n/a |"); process.exit(0); }
const data = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
const rows = [];
for (const [path, cov] of Object.entries(data)) {
	const name = path.split("/").pop();
	const sum = (map, counts) => {
		const total = Object.keys(map).length;
		const hit = Object.values(counts).filter((c) => c > 0).length;
		return [hit, total];
	};
	const metrics = Object.entries({
		Statements: sum(cov.statementMap, cov.s),
		Branches: sum(cov.branchMap, cov.b),
		Functions: sum(cov.fnMap, cov.f),
	});
	for (const [label, [hit, total]] of metrics) {
		const pct = total ? ((hit / total) * 100).toFixed(2) : "100";
		rows.push(`| ${label} | ${pct}% (${hit}/${total}) |`);
	}
	break; // single source file per extension
}
console.log(rows.join("\n"));
' > /tmp/cov-rows.txt || true

{
	echo "## 🧪 Unit tests — \`${NAME}\`"
	echo
	echo "| Metric | Coverage |"
	echo "|---|---|"
	cat /tmp/cov-rows.txt
	echo
	echo "**Tests:** ${PASS} passed, ${FAIL} failed"
} >> "${SUMMARY:-/dev/stdout}"

rm -rf .coverage .tap.out /tmp/cov-rows.txt

# c8/test already exits non-zero on failure; reaching here means green.
echo "run-tests: ${PASS} passed, ${FAIL} failed for ${NAME}"
