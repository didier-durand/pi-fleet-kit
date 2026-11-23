# Changelog

## [0.1.0] - 2026-11-23

First public release.

- Watches `PI_TRIGGER_DIR`; any regular file appearing there is injected
  into the session as if typed by the user, then deleted (one file = one
  prompt).
- `/new [kickoff]` directive on the first line starts a fresh session,
  optionally with a kickoff message.
- Stability check: only files unchanged across two consecutive polls and
  older than the stability window are consumed (atomic-write friendly).
- Zero token cost while idle; caps consumption at 5 files per tick.
- Unset `PI_TRIGGER_DIR` leaves the extension dormant.
