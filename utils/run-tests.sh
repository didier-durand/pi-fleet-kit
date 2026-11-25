#!/usr/bin/env bash
# Runs the unit tests of an extension under V8 code coverage (c8) and emits
# a Markdown report — to $GITHUB_STEP_SUMMARY when defined, stdout otherwise.
# Usage: run-tests.sh <extension-dir-name> [test-path...]
#   Extra args narrow what runs: paths/globs passed to node --test. Default
#   is whole-directory discovery — pass e.g. "tests/unit/**/*.test.ts" when
#   the package keeps live/CLI suites out of the coverage run on purpose.
#
# Zero repo dependencies: c8 is installed ephemerally (--no-save, like tsc in
# check-extension.sh); the tests themselves run on Node's built-in test
# runner with native TypeScript type stripping (Node >= 23.6).
set -euo pipefail

NAME="${1:?usage: run-tests.sh <extension-dir-name> [test-path...]}"
shift || true
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../extensions/$NAME" && pwd)"
[[ -d "$DIR" ]] || { echo "error: no extension dir: $DIR" >&2; exit 1; }
cd "$DIR"

SUMMARY="${GITHUB_STEP_SUMMARY:-}"

npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund c8 >/dev/null 2>&1

# Human output to the console; TAP to a file for counting; JSON coverage for
# the summary table. Test files and test trees are excluded from coverage —
# only the shipped source is measured.
rm -rf .coverage .tap.out
npx c8 --reporter=json --reports-dir=.coverage --exclude 'scripts/**' \
	--exclude '**/*.test.ts' --exclude 'tests/**' \
	node --test --experimental-test-module-mocks \
	--test-reporter=spec --test-reporter-destination=stdout \
	--test-reporter=tap --test-reporter-destination=.tap.out \
	"$@"

PASS="$(grep -c '^ok ' .tap.out || true)"
FAIL="$(grep -c '^not ok ' .tap.out || true)"

# thousand separators for every number the summary displays
fmt() { node -e 'console.log(Number(process.argv[1]).toLocaleString("en-US"))' "$1"; }

# Per-test rows parsed from the TAP stream: emoticon status, test name and
# the test's own duration (ms) from the YAML block that follows each result.
awk '
	function flush() {
		if (pending) {
			gsub(/\|/, "\\|", name);
			printf "| %s | %s | %s |\n", emoji, name, dur == "" ? "—" : dur " ms";
			pending = 0;
		}
	}
	/^(ok|not ok) [0-9]+ - / {
		flush();
		emoji = (/# SKIP/ ? "⏭️" : ($1 == "ok" ? "✅" : "❌"));
		name = $0;
		sub(/^(ok|not ok) [0-9]+ - /, "", name);
		sub(/ # SKIP.*$/, "", name);
		dur = "";
		pending = 1;
		next;
	}
	pending && /^[[:space:]]+duration_ms: [0-9.]+/ {
		dur = $2;
		sub(/duration_ms:/, "", dur);
		dur = sprintf("%.1f", dur);
		sub(/^[[:space:]]+duration_ms:/, "", $0); # cleanup noop, keep vars consistent
		pending = 0;
		gsub(/\|/, "\\|", name);
		printf "| %s | %s | %s ms |\n", emoji, name, dur;
		next;
	}
	END { flush(); }
' .tap.out > /tmp/test-rows.txt || true

# Markdown table from c8's istanbul JSON (coverage-final.json): one row per
# measured source file plus an overall totals row.
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
const dir = ".coverage";
const file = readdirSync(dir).find((f) => f.endsWith("coverage-final.json"));
if (!file) process.exit(0);
const data = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
const f = (n) => n.toLocaleString("en-US");
const pct = (hit, total) => total ? `${((hit / total) * 100).toFixed(2)}% (${f(hit)}/${f(total)})` : "n/a";
const totals = { s: [0, 0], b: [0, 0], f: [0, 0] };
const rows = [];
for (const [path, cov] of Object.entries(data)) {
	if (/\.test\.ts$/.test(path)) continue;
	const name = path.replace(/^.*extensions\//, "");
	const sum = (map, counts) => {
		const total = Object.keys(map).length;
		const hit = Object.values(counts).filter((c) => c > 0).length;
		return [hit, total];
	};
	const s = sum(cov.statementMap, cov.s), b = sum(cov.branchMap, cov.b), f = sum(cov.fnMap, cov.f);
	rows.push({ name, s, b, f });
	totals.s[0] += s[0]; totals.s[1] += s[1];
	totals.b[0] += b[0]; totals.b[1] += b[1];
	totals.f[0] += f[0]; totals.f[1] += f[1];
}
rows.sort((a, b2) => a.name.localeCompare(b2.name));
for (const r of rows) {
	console.log(`| ${r.name} | ${pct(...r.s)} | ${pct(...r.b)} | ${pct(...r.f)} |`);
}
console.log(`| **All files** | **${pct(...totals.s)}** | **${pct(...totals.b)}** | **${pct(...totals.f)}** |`);
' > /tmp/cov-rows.txt || true

{
	echo "## 🧪 Unit tests — \`${NAME}\`"
	echo
	echo "| File | Statements | Branches | Functions |"
	echo "|---|---|---|---|"
	cat /tmp/cov-rows.txt
	echo
	echo "**Tests:** $(fmt "$PASS") passed, $(fmt "$FAIL") failed"
	if [[ -s /tmp/test-rows.txt ]]; then
		echo
		echo "### Per-test results"
		echo
		echo "| Result | Test | Duration |"
		echo "|---|---|---|"
		cat /tmp/test-rows.txt
	fi
} >> "${SUMMARY:-/dev/stdout}"

rm -rf .coverage .tap.out /tmp/cov-rows.txt

# c8/test already exits non-zero on failure; reaching here means green.
echo "run-tests: $(fmt "$PASS") passed, $(fmt "$FAIL") failed for ${NAME}"
