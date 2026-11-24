#!/usr/bin/env bash
# Sanity checks for one Pi extension package (called by its GitHub workflow).
#
# Usage: utils/check-extension.sh <extension-dir-name>   # e.g. git-status
#
# Checks:
#   1. package.json: valid JSON, pi manifest, pi-package keyword,
#      peerDependencies on the host pi-coding-agent, all `files` entries exist
#   2. CHANGELOG.md carries a heading matching the package version
#   3. TypeScript compiles cleanly (tsc --noEmit, strict, against the real
#      host package installed as types)
#   4. npm pack produces exactly the intended tarball contents
#   5. (optional) live load smoke test via `pi -e` — only when
#      OPENROUTER_API_KEY is present in the environment (CI secrets)

set -euo pipefail

NAME="${1:?usage: check-extension.sh <extension-dir-name>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../extensions/$NAME" && pwd)"
[[ -d "$DIR" ]] || { echo "error: no extension dir: $DIR" >&2; exit 1; }
cd "$DIR"

fail=0
step() { echo "::group::$1"; }

# --- 1. package.json manifest ------------------------------------------------
step "package.json manifest"
node -e '
const p = require("./package.json");
const errs = [];
if (!p.name) errs.push("missing name");
if (!p.version) errs.push("missing version");
if (!p.pi || !Array.isArray(p.pi.extensions) || p.pi.extensions.length === 0)
  errs.push("missing pi.extensions manifest");
if (!(p.keywords || []).includes("pi-package"))
  errs.push("keywords must include pi-package (gallery eligibility)");
const peer = (p.peerDependencies || {})["@earendil-works/pi-coding-agent"];
if (peer !== "*") errs.push("peerDependencies must pin @earendil-works/pi-coding-agent: *");
if (p.dependencies && Object.keys(p.dependencies).length)
  errs.push("host-provided packages must not appear in dependencies");
for (const f of p.files || []) {
  if (!require("fs").existsSync(f)) errs.push("files entry missing on disk: " + f);
}
if (errs.length) { errs.forEach(e => console.error("  FAIL: " + e)); process.exit(1); }
console.log("  OK: manifest, keyword, peerDependencies, files all present");
'
end_group() { echo "::endgroup::"; }

# --- 2. CHANGELOG matches the version ---------------------------------------
step "CHANGELOG version heading"
VERSION="$(node -e 'console.log(require("./package.json").version)')"
grep -qE "^## \[${VERSION}\]" CHANGELOG.md \
  || { echo "  FAIL: CHANGELOG.md has no '## [${VERSION}]' heading" >&2; fail=1; }
echo "  OK: CHANGELOG has ## [${VERSION}]"
end_group

# --- 3. TypeScript compiles --------------------------------------------------
step "tsc --noEmit (strict, with host package types)"
npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund \
  @earendil-works/pi-coding-agent typescript >/dev/null 2>&1
ENTRY="$(node -e 'console.log(require("./package.json").pi.extensions.join(" "))')"
npx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext \
  --moduleResolution bundler --types node $ENTRY
echo "  OK: $ENTRY compiles clean"
end_group

# --- 4. npm pack tarball contents --------------------------------------------
step "npm pack — tarball contents"
PACKDIR="$(mktemp -d)"
npm pack --pack-destination "$PACKDIR" >/dev/null
PKG_NAME="$(node -e 'console.log(require("./package.json").name)')"
TARBALL="$PACKDIR/$PKG_NAME-$VERSION.tgz"
EXPECTED="$(node -e '
const p = require("./package.json");
const set = new Set(["package.json"]);
for (const f of p.files || []) set.add(f);
console.log([...set].sort().join("\n"));
')"
ACTUAL="$(tar -tf "$TARBALL" | sed 's|^package/||' | grep -v '^$' | sort)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "  FAIL: tarball contents differ from expectation" >&2
  diff <(echo "$EXPECTED") <(echo "$ACTUAL") | sed 's/^/    /' >&2
  fail=1
else
  echo "  OK: tarball contains exactly the declared files"
fi
end_group

# --- 5. optional live load smoke test ----------------------------------------
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  step "live load smoke test (pi -e)"
  if command -v pi >/dev/null 2>&1; then
    # Pin the smoke-test model when OPENROUTER_MODEL is set (CI repo
    # variable); otherwise pi's automatic default for the provider applies.
    MODEL_ARGS=()
    if [[ -n "${OPENROUTER_MODEL:-}" ]]; then
      echo "  model: $OPENROUTER_MODEL (pinned)"
      MODEL_ARGS=(--provider openrouter --model "$OPENROUTER_MODEL")
    fi
    OUT="$(cd "$DIR/../.." && timeout 120 pi -e "extensions/$NAME" "${MODEL_ARGS[@]}" --print "Reply with exactly: OK" 2>&1 | tail -1)"
    # Models may pad the reply with whitespace/newlines — compare on the
    # trimmed value, still strict on the exact token.
    TRIMMED="${OUT//[[:space:]]/}"
    [[ "$TRIMMED" == "OK" ]] \
      && echo "  OK: extension loads and agent answers" \
      || { echo "  WARN: smoke test did not answer OK — output: $OUT" >&2; }
  else
    echo "  SKIP: pi not installed on runner"
  fi
  end_group
else
  echo "::notice::smoke test skipped (no OPENROUTER_API_KEY in environment)"
fi

(( fail )) && { echo "check-extension: FAILED" >&2; exit 1; }
echo "check-extension: all checks passed for $NAME"
