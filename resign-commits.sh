#!/usr/bin/env bash
# Re-sign commits so GitHub shows the "Verified" badge.
#
# Why a rewrite is needed: the Verified badge is a GPG/SSH signature made at
# commit time. Existing commits cannot be marked verified after the fact —
# they must be re-signed (history rewrite) and force-pushed, which changes
# their SHAs. Run where the private signing key is available: the host OR an
# agent sandbox configured with a dedicated signing key (see entrypoint.sh).
#
# Works WITHOUT gh: detection falls back to local unsigned-commit detection
# (%G? == N). GitHub shows Verified only if the key is registered there
# (Settings -> SSH and GPG keys -> New SSH key -> type: Signing key).
#
# One-time signing setup (SSH signing — easiest):
#   git config --global gpg.format ssh
#   git config --global user.signingkey <path-to-PRIVATE-key>   # or its .pub
#   git config --global commit.gpgsign true
#
# Usage:
#   ./resign-commits.sh             # re-sign from the first unsigned commit
#   ./resign-commits.sh <sha>       # re-sign <sha>..HEAD (inclusive)
#   ./resign-commits.sh --all       # re-sign EVERY commit from the root
#   ./resign-commits.sh --dry-run   # show what would be rewritten

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "HEAD" ]] || { echo "error: detached HEAD" >&2; exit 1; }

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
elif [[ "${1:-}" == "--all" || "${2:-}" == "--all" ]]; then
  BASE="$(git rev-list --max-parents=0 HEAD)"   # root commit
else
  echo "Detecting first unsigned commit reachable from $BRANCH..."
  # git log is newest-first -> tail gives the OLDEST unsigned commit
  SHA=$(git log --format='%H %G?' "$BRANCH" | awk '$2=="N"{print $1}' | tail -1)
  [[ -n "$SHA" ]] || { echo "No unsigned commits found. Nothing to do."; exit 0; }
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
if [[ -t 0 ]]; then
  printf 'Proceed? [y/N] '
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "aborted"; exit 1; }
else
  echo "Non-interactive session — proceeding (use --dry-run to preview)."
fi

# --- rewrite -------------------------------------------------------------------
git fetch "$REMOTE" "$BRANCH" 2>/dev/null || true
if [[ "${1:-}" == "--all" || "${2:-}" == "--all" ]]; then
  git rebase --root --exec 'git commit --amend --no-edit -S'
else
  git rebase "$BASE~1" --exec 'git commit --amend --no-edit -S'
fi

# --- verify locally ------------------------------------------------------------
RANGE_N=$(git rev-list --count "$BASE~1..HEAD" 2>/dev/null || echo 0)
echo "Local check — rewritten commits and signature status (%G? G=good, N=none):"
git log --format='%h %G? %s' -"$(( RANGE_N > 0 ? RANGE_N : 1 ))" | head -30

# --- push ----------------------------------------------------------------------
git push --force-with-lease "$REMOTE" "$BRANCH"
echo
echo "Done. GitHub re-verifies on push; badges may take a few seconds to appear."
