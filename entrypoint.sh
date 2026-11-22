#!/usr/bin/env bash
# Entrypoint for the pi-sandbox image.
#
# Prepares the agent's git environment from env vars passed in by
# docker compose (host passthrough), then hands off to the real
# entrypoint `pi`.
#
# Why: the container has no macOS keyring / credential helper, so git
# identity and auth must come from the environment instead:
#   - GITHUB_TOKEN          -> credentials for git-over-HTTPS pushes/pulls
#                              (git's credential helper reads it; `gh` reads
#                              it directly too)
#   - GITHUB_USER_NAME      -> git commit author name
#   - GITHUB_USER_EMAIL     -> git commit author email
#   - OPENROUTER_API_KEY    -> Pi's "openrouter" provider (not used here,
#                              read by pi itself)
set -euo pipefail

# Git commit identity (empty vars are fine; git just won't have a name/email
# set, which only matters when the agent commits):
git config --global user.name  "${GITHUB_USER_NAME:-}"
git config --global user.email "${GITHUB_USER_EMAIL:-}"

# Auth for git-over-HTTPS without a credential helper: embed the token in
# the remote URL at clone/push time is the agent's business — here we just
# make git use it automatically via an askpass-free helper. Simplest
# reliable trick: a tiny credential helper that echoes the env token.
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f'
fi

# Optional commit signing: if a dedicated SSH signing key is mounted
# (compose: ~/.ssh/pi-agent-signing -> /home/pi/.ssh/signing_key), configure
# git to sign every commit with it. The key must be a SIGNING-ONLY key whose
# public half is registered on GitHub (Settings -> SSH and GPG keys ->
# type: Signing key); then commits made here show the Verified badge.
SIGN_KEY=/home/pi/.ssh/signing_key
if [[ -s "$SIGN_KEY" ]]; then
  git config --global gpg.format ssh
  git config --global user.signingkey "$SIGN_KEY"
  git config --global commit.gpgsign true
fi

# Hand off to the original entrypoint (pi) with the compose `command` args:
exec pi "$@"
