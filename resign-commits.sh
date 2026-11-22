#!/usr/bin/env bash
# Re-sign unverified commits so GitHub shows the "Verified" badge.
#
# Why a rewrite is needed: the Verified badge is a GPG/SSH signature made at
# commit time. Existing commits cannot be marked verified after the fact —
# they must be re-signed (history rewrite) and force-pushed, which changes
# their SHAs. Run this on a machine holding the private signing key; never in
# an agent sandbox.
#
# One-time setup (macOS/Linux, SSH signing — easiest path):
#   git config --global gpg.format ssh
#   git config --global user.signingkey ~/.ssh/id_ed25519.pub   # your public key
#   git config --global commit.gpgsign true
#   # GitHub -> Settings -> SSH and GPG keys -> New SSH key -> type: SIGNING key
#
# Usage:
#   ./resign-commits.sh            # re-sign everything from the first
#                                  # unverified commit reachable from HEAD
#   ./resign-commits.sh <sha>      # re-sign <sha>..HEAD (inclusive)
#   ./resign-commits.sh --dry-run  # show what would be rewritten
#
# Requires: gh CLI (to detect unverified commits) OR a first-commit SHA.

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "HEAD" ]] || { echo "error: detached HEAD" >&2; exit 1; }

# --- locate gh (PATH may be minimal) ------------------------------------------
GH=gh
command -v gh >/dev/null 2>&1 || GH="/opt/homebrew/bin/gh"
[[ -x "$GH" ]] || GH="/usr/local/bin/gh"
[[ -x "$GH" ]] || { echo "error: gh CLI not found (brew install gh)" >&2; exit 1; }

REPO="$("$GH" repo view --json nameWithOwner -q .nameWithOwner)"

# --- signing must be configured BEFORE rewriting -------------------------------
fmt="$(git config gpg.format || true)"
key="$(git config user.signingkey || true)"
[[ "$fmt" == "gpg" || "$fmt" == "ssh" ]] || { echo "error: no signing format configured (gpg.format = gpg|ssh)" >&2; exit 1; }
[[ -n "$key" ]] || { echo "error: user.signingkey not configured" >&2; exit 1; }
echo "Signing: format=$fmt key=$key"

# --- find the base commit -------------------------------------------------------
BASE=""
if [[ "${1:-}" == "--dry-run" || "${2:-}" == "--dry-run" ]]; then
  :
elif [[ -n "${1:-}" && "$1" != "--dry-run" ]]; then
  BASE="$1"
else
  echo "Detecting first unverified commit in $REPO..."
  SHA="$("$GH" api "repos/$REPO/commits?per_page=100&sha=$BRANCH" \
    --jq '[.[] | select(.commit.verification.verified != true)][-1].sha' 2>/dev/null || true)"
  [[ -n "$SHA" && "$SHA" != "null" ]] || {
    echo "No unverified commits found in the last 100 (or API failed). Nothing to do."
    exit 0
  }
  BASE="$SHA"
fi
[[ -z "$BASE" ]] || echo "Re-signing from: $(git log -1 --format='%h %s' "$BASE")"

# --- plan ----------------------------------------------------------------------
if [[ "${1:-}" == "--dry-run" || "${2:-}" == "--dry-run" ]]; then
  if [[ -n "$BASE" ]]; then RANGE="$BASE~1..HEAD"; else RANGE="HEAD"; fi
  echo "Would rewrite: $(git rev-list --count "$RANGE" 2>/dev/null || echo '?') commit(s)"
  git log --oneline $RANGE 2>/dev/null | head -20
  exit 0
fi

echo
echo "This REWRITES history and FORCE-PUSHES '$BRANCH' to $REMOTE."
echo "Any open PRs referencing these commits keep working (same branch), but"
echo "commit SHAs in comments/links change. Protected branches will refuse the"
echo "force-push — unprotect temporarily if needed."
printf 'Proceed? [y/N] '
read -r answer
[[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "aborted"; exit 1; }

# --- rewrite -------------------------------------------------------------------
git fetch "$REMOTE" "$BRANCH"
RANGE="$BASE~1..HEAD"
git rebase "$BASE~1" --exec 'git commit --amend --no-edit -S'

# --- verify locally ------------------------------------------------------------
BAD=$(git rev-list "$REMOTE/$BRANCH..HEAD" --count 2>/dev/null || echo "?")
echo "Local check — commits with signatures:"
git log --format='%h %G? %s' -"$(( BAD > 0 ? BAD : 1 ))" | head -20

# --- push ----------------------------------------------------------------------
git push --force-with-lease "$REMOTE" "$BRANCH"
echo
echo "Done. GitHub re-verifies on push; badges may take a few seconds to appear."
echo "Check: $GH api repos/$REPO/commits --jq '.[] | \"\\(.sha[0:8]) \\(.commit.verification.verified)\"' | head -5"
