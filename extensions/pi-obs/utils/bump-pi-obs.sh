#!/usr/bin/env bash
# bump-pi-obs.sh — version pi-obs the conventional way (single source of
# truth: package.json, derived everywhere by src/version.ts).
#
# Does exactly what the manual flow does, in one command:
#   1. bump extensions/pi-obs/package.json (+ package-lock.json)
#   2. insert the "## [X.Y.Z] - date" heading in CHANGELOG.md (the Pi
#      package changelog convention — feeds pi's "Extension Updates")
#   3. VALIDATE the Pi package shape — manifest, pi-package keyword,
#      peerDependencies, the changelog entry for THIS version, and the
#      packed payload (dry-run). A tag is only ever created on a commit
#      that is a complete, installable Pi package.
#   4. commit (GPG-signed, -S) with message "pi-obs-X.Y.Z" — the SAME
#      identifier as the tag and the tarball (searchable 1:1)
#   5. create a SIGNED annotated tag  pi-obs-X.Y.Z   (no "v" — the tag
#      name IS the tarball name: pi-obs-X.Y.Z.tgz)
#   6. push main + the tag (unless --no-push)
#   7. npm pack -> pi-obs-X.Y.Z.tgz in the pi-obs root (the release
#      artifact; gitignored, ready to install)
#   8. upload the tarball to the GitHub RELEASE for the tag (the
#      downloadable artifact; the tarball itself is never committed)
#
# Usage:
#   utils/bump-pi-obs.sh --patch              # 0.1.1 -> 0.1.2
#   utils/bump-pi-obs.sh --minor              # 0.1.1 -> 0.2.0
#   utils/bump-pi-obs.sh --major              # 0.1.1 -> 1.0.0
#   utils/bump-pi-obs.sh --version=1.2.3      # exact version
#   options: --no-push (commit+tag only), -h/--help
#
# Exit codes: 0 success · 1 failure (git/npm error, dirty tree, bad
# version) · 2 usage error. Refuses to run on a dirty tree or when the
# tag already exists. POSIX bash 3.2-safe.

set -eu

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

BUMP=""
EXACT=""
PUSH=true
while [ $# -gt 0 ]; do
	case "$1" in
		--patch) BUMP=patch ;;
		--minor) BUMP=minor ;;
		--major) BUMP=major ;;
		--version=*) EXACT="${1#--version=}" ;;
		--no-push) PUSH=false ;;
		-h|--help) usage 0 ;;
		*) echo "bump-pi-obs: unknown argument $1 (try --help)" >&2; exit 2 ;;
	esac
	shift
done

if [ -z "$BUMP" ] && [ -z "$EXACT" ]; then
	echo "bump-pi-obs: one of --patch/--minor/--major/--version=X.Y.Z is required (try --help)" >&2
	exit 2
fi
if [ -n "$BUMP" ] && [ -n "$EXACT" ]; then
	echo "bump-pi-obs: --version is mutually exclusive with --patch/--minor/--major" >&2
	exit 2
fi
if [ -n "$EXACT" ]; then
	# strict semver x.y.z (numeric, no leading zeros, no pre-release/build here)
	if ! printf '%s' "$EXACT" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
		echo "bump-pi-obs: --version wants a strict x.y.z semver, got \"$EXACT\"" >&2
		exit 2
	fi
fi

PI_OBS_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_DIR=$(cd "$PI_OBS_DIR/../.." && pwd)
cd "$PI_OBS_DIR"

# --- preconditions -----------------------------------------------------------
CURRENT=$(node -e "console.log(require('./package.json').version)")
if [ -z "$CURRENT" ]; then
	echo "bump-pi-obs: cannot read the current version from package.json" >&2
	exit 1
fi
if [ -n "$(git -C "$REPO_DIR" status --porcelain -- extensions/pi-obs)" ]; then
	echo "bump-pi-obs: extensions/pi-obs has uncommitted changes — commit them first" >&2
	git -C "$REPO_DIR" status --short -- extensions/pi-obs >&2
	exit 1
fi

if [ -n "$EXACT" ]; then
	NEW="$EXACT"
else
	NEW=$(npm version "$BUMP" --no-git-tag-version)
fi
NEW=${NEW#v}   # npm version prints v-prefixed; normalize

if [ "$NEW" = "$CURRENT" ]; then
	echo "bump-pi-obs: version unchanged ($CURRENT) — nothing to do" >&2
	exit 1
fi
TAG="pi-obs-$NEW"
if git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	echo "bump-pi-obs: tag $TAG already exists" >&2
	git -C "$REPO_DIR" tag -l "$TAG" >&2
	exit 1
fi

echo "bump: $CURRENT -> $NEW (tag $TAG)"

# --- the version must derive everywhere (the convention's own proof) ---------
DERIVED=$(./bin/piobs version | awk '{print $2}')
if [ "$DERIVED" != "$NEW" ]; then
	echo "bump-pi-obs: FATAL — piobs reports \"$DERIVED\", expected \"$NEW\" (the version is not deriving from package.json)" >&2
	exit 1
fi

# --- changelog: the Pi package convention (version-headed entry) -------------
#   ## [X.Y.Z] - YYYY-MM-DD, matched by pi against package.json's version.
node - "$NEW" "$CURRENT" <<'NODE'
const fs = require("node:fs");
const [NEW, CURRENT] = process.argv.slice(2);
const heading = `## [${NEW}]`;
let s = fs.readFileSync("CHANGELOG.md", "utf8");
if (s.includes(heading + " ")) {
	console.error(`bump-pi-obs: ${heading} already has an entry — leaving it in place`);
} else {
	const date = new Date().toISOString().slice(0, 10);
	const entry = `${heading} - ${date}

- Version bump from ${CURRENT} (see \`git log pi-obs-${CURRENT}..pi-obs-${NEW}\` for changes).

`;
	s = s.replace(/^# Changelog\n\n/, `# Changelog\n\n${entry}`);
	fs.writeFileSync("CHANGELOG.md", s);
	console.log(`changelog: ${heading} - ${date} inserted`);
}
NODE

# --- the tagged commit MUST be a complete Pi package -----------------------
#   Everything pi's packages doc makes loadable/installable is checked BEFORE
#   the commit and tag exist: manifest, keyword, peer declaration, the
#   changelog entry for THIS version, and the packed payload (dry-run).
node - "$NEW" <<'NODE'
const fs = require("node:fs");
const NEW = process.argv[2];
const errors = [];
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); }
catch { errors.push("package.json is not valid JSON"); }
if (pkg) {
	if (!pkg.pi || !Array.isArray(pkg.pi.extensions) || pkg.pi.extensions.length === 0)
		errors.push("pi manifest missing (pi.extensions)");
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package"))
		errors.push("'pi-package' keyword missing");
	if (!pkg.peerDependencies || !pkg.peerDependencies["@earendil-works/pi-coding-agent"])
		errors.push("host package not declared in peerDependencies");
	if (pkg.dependencies && pkg.dependencies["@earendil-works/pi-coding-agent"])
		errors.push("host package in dependencies (must be peerDependencies only - pi warns on this)");
	if (Array.isArray(pkg.files) && !pkg.files.includes("CHANGELOG.md"))
		errors.push("CHANGELOG.md not in the files allowlist (Extension Updates could not ship)");
	if (pkg.version !== NEW)
		errors.push("package.json version is " + pkg.version + ", expected " + NEW);
}
try {
	const cl = fs.readFileSync("CHANGELOG.md", "utf8");
	if (!cl.includes("## [" + NEW + "]"))
		errors.push("CHANGELOG.md has no '## [" + NEW + "]' heading for this release");
} catch {
	errors.push("CHANGELOG.md missing at the package root");
}
if (errors.length) {
	console.error("bump-pi-obs: refusing to commit/tag - not a complete Pi package:");
	for (const e of errors) console.error("  - " + e);
	process.exit(1);
}
console.log("pi package shape: manifest, keyword, peerDeps, changelog entry - all present");
NODE
#   npm pack --dry-run lists contents WITHOUT the package/ tarball prefix
#   ("npm notice  327B index.ts"), so match each name at end-of-line.
DRY=$(npm pack --dry-run 2>&1)
for REQUIRED in index.ts CHANGELOG.md package.json; do
	echo "$DRY" | grep -Eq " +$REQUIRED\$" || {
		echo "bump-pi-obs: refusing to tag - the packed payload would not include $REQUIRED" >&2
		exit 1
	}
done
echo "packed payload: shim + changelog + manifest all ship"

# --- commit + signed tag ------------------------------------------------------
cd "$REPO_DIR"
git add extensions/pi-obs/package.json extensions/pi-obs/package-lock.json extensions/pi-obs/CHANGELOG.md
git commit -q -S -m "$TAG"
git tag -s "$TAG" -m "$TAG"

if [ "$PUSH" = true ]; then
	git push origin main "$TAG"
	echo "==> pushed main + $TAG"
else
	echo "==> committed and tagged locally (not pushed): $TAG"
fi

# --- the release artifact: the packed extension in the pi-obs root -------
cd "$PI_OBS_DIR"
TARBALL=$(npm pack --silent)
# npm pack names it pi-obs-X.Y.Z.tgz — identical to the tag, by design
SHA=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
FILES=$(tar tzf "$TARBALL" | grep -vc '^$')
echo "==> packed: $TARBALL ($FILES files, $(du -h "$TARBALL" | cut -f1))"
echo "    sha256: $SHA"
echo "==> pi-obs $NEW (from $CURRENT) — tag $TAG = tarball name"

# --- upload the tarball to the GitHub release for the tag ---------------
#   The tarball is a build artifact: never committed (gitignored), but it
#   IS the distributable — so it is attached to the release pi cuts the
#   tag for. Notes come from this version's CHANGELOG.md section.
if [ "$PUSH" = true ]; then
	if ! command -v gh >/dev/null 2>&1; then
		echo "bump-pi-obs: gh CLI not found — the tarball stays local and unuploaded" >&2
		exit 1
	fi
	#   Include the '## [X.Y.Z] - date' heading itself, not just the body:
	#   the release-gate workflow (tag-pi-obs) requires the notes to carry
	#   the section for THIS version — one convention everywhere.
	NOTES=$(awk -v h="## [$NEW]" '
		!found && index($0, h) == 1 { found = 1; print; next }
		found && /^## \[/ { exit }
		found { print }
	' "$PI_OBS_DIR/CHANGELOG.md")
	if ! gh release view "$TAG" >/dev/null 2>&1; then
		gh release create "$TAG" "$TARBALL" --title "$TAG" --notes "pi-obs $NEW — release notes from CHANGELOG.md:

$NOTES

Asset: \`$TARBALL\` (sha256: $SHA)"
	else
		gh release upload "$TAG" "$TARBALL" --clobber
	fi
	echo "==> uploaded: $TARBALL attached to the GitHub release $TAG"
else
	echo "==> not pushed (--no-push): release + upload skipped"
fi
