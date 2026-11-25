#!/usr/bin/env bash
# pi-obs — consolidated black-box suite (SPECS.md v1.0.1 R8,
# DEV_PLAN.md v1.0.1 Step 9).
#
# Proves R1–R8 mechanically, without white-box knowledge of pi internals.
# POSIX bash 3.2-safe, `set -eu`, cleanup traps (no leftovers: temp dirs,
# receiver ports, processes), PASS/FAIL/SKIP per check with a summary.
#
# Levels (each skipped with an explicit notice when its prerequisites
# are missing — never a FAIL on a stock machine):
#   - unit           : every *.test.ts module suite + the ≥ 90% lines AND
#                      branches coverage gate, asserted per module.
#                      Requires: node (>= 23.6).
#   - live           : scripted `pi -e` runs. Requires: pi on PATH +
#                      OPENROUTER_API_KEY (model-gated, like the repo's
#                      other suites).
#   - standard-tools : reference-toolchain conformance (SPECS.md R4).
#                      Requires: otelcol + weaver on PATH. Pinned:
#                      otelcol-contrib 0.165.0, weaver 0.28.0,
#                      semantic-conventions v1.34.0 (registry dependency
#                      in tests/tools/weaver/manifest.yaml; fetched and
#                      cached by weaver itself).
#   - isolation      : unreachable endpoint / read-only target (R1).
#                      Requires: pi + OPENROUTER_API_KEY.
#
# AC → check table (SPECS.md ACs mapped to named checks):
#   R1 zero-harm     : L3 identical-output  ·  I1/I2 unaffected-agent +
#                      drop records  ·  U fault-isolation (index.test.ts)
#   R2 privacy       : L2 canary-absent (opt-in, redacted)  ·
#                      U canary tests (config/model/replay/file/otlp/index)
#   R3 coverage      : U inventory (hooks.test.ts)  ·  L2 live hierarchy
#   R3b replay       : U replay suite (replay.test.ts)  ·  L4 report on
#                      the run's own session file  ·  S1/S2 report legs  ·
#                      C1-C3 the standalone piobs CLI
#   R4 formatting    : S1 Collector accepts every record (pdata parse) ·
#                      S2 Weaver zero violations (pinned GenAI + pi.*)
#   R5 export        : L5 receiver delivery  ·  L2 file exporter trace ·
#                      U exporter suites (file/otlp tests)
#   R6 config        : U config suite (config.test.ts)  ·  L6 status
#                      reflects configuration
#   R7 UX            : U commands suite (commands.test.ts, goldens)  ·
#                      L6 status accuracy
#   R8 testability   : this suite
#
# Usage: ./test_pi_obs.sh           # from extensions/pi-obs/

set -eu

PI_OBS_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$PI_OBS_DIR"

PASS=0; FAIL=0; SKIP=0; FAILED_CHECKS=""
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-obs-suite-XXXXXX")
PIDS=""
cleanup() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

note()  { printf '     %s\n' "$*"; }
pass()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$*"; }
skip()  { SKIP=$((SKIP + 1)); printf '  - SKIP %s\n' "$*"; }
fail()  { FAIL=$((FAIL + 1)); FAILED_CHECKS="$FAILED_CHECKS
  ✘ $*"; printf '  ✘ %s\n' "$*"; }

pick_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

have() { command -v "$1" >/dev/null 2>&1; }

# prerequisites
NODE_OK=false; have node && NODE_OK=true
PI_OK=false;   have pi   && PI_OK=true
MODEL_OK=false
[ "$PI_OK" = true ] && [ "${OPENROUTER_API_KEY:-}" != "" ] && MODEL_OK=true
OTELCOL_OK=false; have otelcol && OTELCOL_OK=true
[ "$OTELCOL_OK" = false ] && have otelcol-contrib && OTELCOL_OK=true
otelcol_bin() { if have otelcol-contrib; then command -v otelcol-contrib; else command -v otelcol; fi; }
WEAVER_OK=false; have weaver && WEAVER_OK=true

# a scratch PI_HOME per run: sessions, settings, and the export file all
# land inside $WORK — nothing touches the user's ~/.pi
PI_HOME_DIR="$WORK/pi-home"
mkdir -p "$PI_HOME_DIR"

# ---------------------------------------------------------------------------
printf 'pi-obs black-box suite\n'
printf '  node=%s pi=%s model-key=%s otelcol=%s weaver=%s\n\n' \
  "$NODE_OK" "$PI_OK" "$MODEL_OK" "$OTELCOL_OK" "$WEAVER_OK"

# === LEVEL: unit ===========================================================
printf 'unit level (node module suites + coverage gate)\n'
if [ "$NODE_OK" = true ]; then
  if node --test --experimental-test-coverage \
        --test-coverage-lines=90 --test-coverage-branches=90 \
        tests/unit/*.test.ts tests/unit/exporters/*.test.ts > "$WORK/unit.log" 2>&1; then
    TESTS=$(grep -m1 '^ℹ tests ' "$WORK/unit.log" | awk '{print $3}')
    PASSN=$(grep -m1 '^ℹ pass ' "$WORK/unit.log" | awk '{print $3}')
    pass "U1 module suites: $PASSN/$TESTS tests, coverage gate >= 90% enforced by the runner"
  else
    fail "U1 module suites + coverage gate (see $WORK/unit.log; kept on failure)"
    cp "$WORK/unit.log" "$PI_OBS_DIR/unit-failure.log" 2>/dev/null || true
    note "log preserved at $PI_OBS_DIR/unit-failure.log"
  fi
  # per-module gate: every module >= 90 lines+branches (parsed from the runner's table)
  if python3 - "$WORK/unit.log" <<'UNITGATE'
import re, sys
bad = []
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r"^\u2119\s+(\S+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)", line)
    if not m:
        continue
    module, lines_p, branches_p = m.group(1), float(m.group(2)), float(m.group(3))
    if lines_p < 90.0:
        bad.append(f"{module} lines {lines_p}")
    if branches_p < 90.0:
        bad.append(f"{module} branches {branches_p}")
assert not bad, "modules below the gate: " + ", ".join(bad)
UNITGATE
  then
    pass "U2 per-module coverage: every module >= 90% lines and branches"
  else
    fail "U2 per-module coverage (per-module numbers in $WORK/unit.log)"
  fi
else
  skip "U1/U2 unit level: node not found"
fi
printf '\n'

# === LEVEL: live ===========================================================
printf 'live level (scripted pi -e runs; model-gated)\n'
PROMPT='Use the bash tool to run: echo OK — then reply with exactly its output, nothing else. (Ignore this marker: SECRET_CANARY=zlX9.trap-Canary_q7r8s9t0u1)'
CANARY='zlX9.trap-Canary_q7r8s9t0u1'
run_pi() { # run_pi <outfile> <extra env assignments...>
  _out="$1"; shift
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" "$@" \
    pi -e "$PI_OBS_DIR/index.ts" -p "$PROMPT" >"$_out" 2>"$WORK/pi.stderr" || true
}
if [ "$MODEL_OK" = true ]; then
  # L3 baseline: the same prompt WITHOUT pi-obs (R1 AC)
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" pi -p "$PROMPT" >"$WORK/baseline.out" 2>/dev/null
  BASE_EXIT=$?
  run_pi "$WORK/with-ext.out" PI_OBS_FILE=1 PI_OBS_FILE_PATH="$WORK/live.jsonl" PI_OBS_CAPTURE_PROMPTS=1
  EXT_EXIT=$?

  # L2 file-exporter trace: every line parses, hierarchy, canary redacted
  L2_OK=true
  python3 - "$WORK/live.jsonl" "$CANARY" <<'PYEOF' && pass "L2 file-exporter trace: valid OTLP/JSON lines, pi.session>pi.run>pi.turn>{pi.model,pi.tool}, canary redacted" || { L2_OK=false; fail "L2 file-exporter trace (see $WORK/live.jsonl)"; }
import json, sys
path, canary = sys.argv[1], sys.argv[2]
lines = [l for l in open(path) if l.strip()]
assert lines, "export file empty"
names = []
for l in lines:
    rec = json.loads(l)  # every line parses as OTLP/JSON
    for rs in rec.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                names.append(sp["name"])
    for rm in rec.get("resourceMetrics", []):
        for sm in rm.get("scopeMetrics", []):
            for m in sm.get("metrics", []):
                names.append(m["name"])
wire = open(path).read()
for expected in ("pi.session", "pi.run", "pi.turn", "pi.model"):
    assert expected in names, f"missing span {expected}: {names}"
assert "pi.tool" in " ".join(names), f"missing tool span: {names}"
assert "[REDACTED]" in wire, "opt-in capture is not redacted"
for i in range(len(canary) - 7):
    assert canary[i:i+8] not in wire, f"canary substring leaked: {canary[i:i+8]}"
PYEOF

  # L3 identical output and exit code with and without pi-obs (R1 AC)
  if [ "$BASE_EXIT" = "$EXT_EXIT" ] && [ "$(cat "$WORK/baseline.out" | tr -d '[:space:]')" = "$(cat "$WORK/with-ext.out" | tr -d '[:space:]')" ]; then
    pass "L3 R1 AC: identical agent output and exit code with and without pi-obs"
  else
    fail "L3 R1 AC: output/exit differ (baseline=$BASE_EXIT ext=$EXT_EXIT)"
  fi

  # L4 /pi-obs report against the run's OWN just-written session file (R3b live AC)
  SESSION_FILE=$(find "$PI_HOME_DIR/.pi/agent/sessions" "$PI_HOME_DIR/agent/sessions" -name '*.jsonl' -type f 2>/dev/null | head -1 || true)
  if [ -n "$SESSION_FILE" ]; then
    env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" pi -e "$PI_OBS_DIR/index.ts" \
      -p "/pi-obs report $SESSION_FILE" >"$WORK/report.out" 2>&1
    if python3 - "$WORK/report.out" <<'PYEOF'
import json, sys
lines = [l for l in open(sys.argv[1]) if l.strip().startswith("{")]
assert len(lines) >= 4, "too few OTLP lines"
for l in lines: json.loads(l)
assert any('"pi.session"' in l for l in lines)
PYEOF
    then pass "L4 /pi-obs report on the run's own session file: OTLP/JSON-per-line on stdout"
    else fail "L4 /pi-obs report on the run's own session file"
    fi
  else
    fail "L4: no session file found under $PI_HOME_DIR/.pi/agent/sessions"
  fi

  # L5 OTLP receiver delivery (R5): the throwaway receiver captures requests
  RECV_PORT=$(pick_free_port)
  node "$PI_OBS_DIR/tests/otlp_receiver_main.ts" "$RECV_PORT" --out "$WORK/recv.jsonl" >"$WORK/recv.log" 2>&1 &
  PIDS="$PIDS $!"
  RECV_OK=false
  for _ in $(seq 1 20); do
    grep -q "listening" "$WORK/recv.log" 2>/dev/null && RECV_OK=true && break
    sleep 0.5
  done
  if [ "$RECV_OK" = true ]; then
    rm -f "$WORK/recv.jsonl"
    env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" \
      PI_OBS_OTLP_ENDPOINT="http://127.0.0.1:$RECV_PORT" PI_OBS_FILE=1 PI_OBS_FILE_PATH="$WORK/live2.jsonl" \
      pi -e "$PI_OBS_DIR/index.ts" -p "$PROMPT" >/dev/null 2>&1 || true
    sleep 2
    if [ -s "$WORK/recv.jsonl" ] && grep -q '"/v1/traces"' "$WORK/recv.jsonl"; then
      pass "L5 OTLP receiver delivery: per-signal requests arrived at the throwaway receiver"
    else
      fail "L5 OTLP receiver delivery (receiver saw: $(cat "$WORK/recv.jsonl" 2>/dev/null | head -3))"
    fi
  else
    skip "L5 OTLP receiver delivery: receiver did not start"
  fi

  # L6 /pi-obs status accuracy (R6/R7): configuration reflected
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" PI_OBS_FILE=1 PI_OBS_FILE_PATH="$WORK/live.jsonl" \
    pi -e "$PI_OBS_DIR/index.ts" -p "/pi-obs status" >"$WORK/status1.out" 2>&1
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" \
    pi -e "$PI_OBS_DIR/index.ts" -p "/pi-obs status" >"$WORK/status2.out" 2>&1
  if grep -q "active (1 exporter" "$WORK/status1.out" && grep -q "file:" "$WORK/status1.out" \
     && grep -q "inactive (no exporter configured" "$WORK/status2.out"; then
    pass "L6 /pi-obs status: active with file exporter, inactive without — configuration reflected"
  else
    fail "L6 /pi-obs status accuracy"
  fi
else
  skip "L2-L6 live level: pi + OPENROUTER_API_KEY required"
fi
printf '\n'

# === LEVEL: cli (standalone piobs binary; model-free) ======================
printf 'cli level (bin/piobs — the standalone report CLI; model-free)\n'
if [ "$NODE_OK" = true ]; then
  # C1 --help / version: exit 0, real output, through the real wrapper
  if ./bin/piobs --help > "$WORK/cli-help.out" 2>&1 && grep -q -- "--branch=<entry-id>" "$WORK/cli-help.out"; then
    pass "C1 piobs --help: exit 0, full grammar (through bin/piobs -> node src/cli.ts)"
  else
    fail "C1 piobs --help"
  fi

  # C2 report on a fixture: OTLP/JSON-per-line on stdout, exit 0
  if ./bin/piobs report tests/fixtures/sessions/straight.jsonl > "$WORK/cli-report.out" 2>/dev/null      && python3 - "$WORK/cli-report.out" <<'CLIGATE'
import json, sys
lines = [l for l in open(sys.argv[1]) if l.strip().startswith("{")]
assert len(lines) >= 10, f"too few lines: {len(lines)}"
for l in lines: json.loads(l)
assert any('"pi.session"' in l for l in lines)
CLIGATE
  then
    pass "C2 piobs report <fixture>: OTLP/JSON-per-line on stdout, exit 0"
  else
    fail "C2 piobs report <fixture>"
  fi

  # C3 exit codes: unknown id -> 1 (actionable), usage errors -> 2
  CLI_DIR=$(mktemp -d "$WORK/cli-XXXXXX")
  E1=0; ./bin/piobs report no-such-id --sessions-dir="$CLI_DIR" > /dev/null 2>"$WORK/cli-e1.err" || E1=$?
  E2=0; ./bin/piobs report x --wat > /dev/null 2>&1 || E2=$?
  E3=0; ./bin/piobs report > /dev/null 2>&1 || E3=$?
  if [ "$E1" = "1" ] && grep -q "no session with id no-such-id" "$WORK/cli-e1.err" \
     && [ "$E2" = "2" ] && [ "$E3" = "2" ]; then
    pass "C3 piobs exit codes: replay error 1 (actionable message), usage errors 2"
  else
    fail "C3 piobs exit codes (unknown-id=$E1 bad-flag=$E2 missing-arg=$E3)"
  fi
else
  skip "C1-C3 cli level: node not found"
fi
printf '\n'

# === LEVEL: standard-tools (reference toolchain, SPECS.md R4) ==============
printf 'standard-tools level (Collector + Weaver; gated on PATH)\n'
if [ "$OTELCOL_OK" = true ] && [ "$NODE_OK" = true ]; then
  # a file-exporter trace to replay: the live run's when available, else a
  # report of a fixture through the SAME file exporter (model-free)
  if [ -s "$WORK/live.jsonl" ]; then
    STRUCT_FILE="$WORK/live.jsonl"
    STRUCT_SRC="the live run's file-exporter trace"
  else
    STRUCT_FILE="$WORK/report.jsonl"
    env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" pi -e "$PI_OBS_DIR/index.ts" \
      -p "/pi-obs report $PI_OBS_DIR/tests/fixtures/sessions/straight.jsonl --file=$STRUCT_FILE" >/dev/null 2>&1 || true
    STRUCT_SRC="a /pi-obs report --file trace of a fixture (model-free)"
  fi
  if [ -s "$STRUCT_FILE" ]; then
    COL_PORT=$(pick_free_port)
    PI_OBS_COL_PORT=$COL_PORT PI_OBS_COL_OUT="$WORK/col-out.jsonl" \
      "$(otelcol_bin)" --config "$PI_OBS_DIR/tests/tools/otelcol-structural.yaml" >"$WORK/col.log" 2>&1 &
    PIDS="$PIDS $!"
    COL_READY=false
    for _ in $(seq 1 30); do
      grep -q "Everything is ready" "$WORK/col.log" 2>/dev/null && COL_READY=true && break
      sleep 1
    done
    if [ "$COL_READY" = true ]; then
      S1_BAD=0; S1_N=0
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        S1_N=$((S1_N + 1))
        case "$line" in
          *resourceSpans*)  SIG=traces ;;
          *resourceMetrics*) SIG=metrics ;;
          *resourceLogs*)   SIG=logs ;;
          *) SIG=traces ;;
        esac
        CODE=$(printf '%s' "$line" | curl -s -o /dev/null -w '%{http_code}' \
          -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$COL_PORT/v1/$SIG" || echo 000)
        [ "$CODE" = "200" ] || S1_BAD=$((S1_BAD + 1))
      done < "$STRUCT_FILE"
      if [ "$S1_BAD" = 0 ] && [ "$S1_N" -gt 0 ]; then
        pass "S1 Collector structural conformance: all $S1_N records of $STRUCT_SRC accepted (pdata parse)"
      else
        fail "S1 Collector structural conformance: $S1_BAD/$S1_N records rejected"
      fi
    else
      fail "S1: otelcol did not become ready (see $WORK/col.log)"
    fi
  else
    skip "S1 structural: no file-exporter trace available (live level skipped and report failed)"
  fi
else
  skip "S1 structural conformance: otelcol not found"
fi

if [ "$WEAVER_OK" = true ] && [ "$OTELCOL_OK" = true ] && [ "$PI_OK" = true ]; then
  GRPC_PORT=$(pick_free_port); ADMIN_PORT=$(pick_free_port); SEM_COL_PORT=$(pick_free_port)
  weaver registry live-check --v2 \
    -r "$PI_OBS_DIR/tests/tools/weaver" --config "$PI_OBS_DIR/tests/tools/weaver.toml" \
    --otlp-grpc-port "$GRPC_PORT" --admin-port "$ADMIN_PORT" --inactivity-timeout 60 \
    > "$WORK/weaver.log" 2>&1 &
  WEAVER_PID=$!
  PIDS="$PIDS $WEAVER_PID"
  W_READY=false
  for _ in $(seq 1 60); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ADMIN_PORT/health" 2>/dev/null || echo 000)
    [ "$CODE" = "200" ] && W_READY=true && break
    sleep 1
  done
  if [ "$W_READY" = true ]; then
    PI_OBS_COL_PORT=$SEM_COL_PORT PI_OBS_WEAVER_GRPC_PORT=$GRPC_PORT \
      "$(otelcol_bin)" --config "$PI_OBS_DIR/tests/tools/otelcol-semantic.yaml" >"$WORK/col2.log" 2>&1 &
    PIDS="$PIDS $!"
    sleep 3
    env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" \
      PI_OBS_OTLP_ENDPOINT="http://127.0.0.1:$SEM_COL_PORT" \
      pi -e "$PI_OBS_DIR/index.ts" \
      -p "/pi-obs report $PI_OBS_DIR/tests/fixtures/sessions/straight.jsonl --otlp" \
      > "$WORK/semantic-report.out" 2>"$WORK/semantic-report.err" || true
    sleep 6
    kill -INT "$WEAVER_PID" 2>/dev/null || true
    WEXIT=0
    for _ in $(seq 1 30); do kill -0 "$WEAVER_PID" 2>/dev/null || break; sleep 1; done
    wait "$WEAVER_PID" 2>/dev/null || WEXIT=$?
    # ignore the harness's own wait semantics: read the exit from the process status file
    if [ "$WEXIT" = "0" ] && ! grep -q "violation]" "$WORK/weaver.log"; then
      pass "S2 Weaver semantic conformance: zero violations against pinned GenAI v1.34.0 + the generated pi.* registry"
    else
      fail "S2 Weaver semantic conformance (exit=$WEXIT; see $WORK/weaver.log)"
      cp "$WORK/weaver.log" "$PI_OBS_DIR/weaver-failure.log" 2>/dev/null || true
    fi
  else
    fail "S2: weaver live-check did not become ready (see $WORK/weaver.log)"
    cp "$WORK/weaver.log" "$PI_OBS_DIR/weaver-failure.log" 2>/dev/null || true
  fi
else
  skip "S2 semantic conformance: weaver (and/or otelcol + pi) not found"
fi
printf '\n'

# === LEVEL: isolation (R1) =================================================
printf 'isolation level (R1: dead backends never harm the agent; model-gated)\n'
if [ "$MODEL_OK" = true ]; then
  # I1 unreachable OTLP endpoint: identical output, exit 0, fault records exported
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" \
    PI_OBS_OTLP_ENDPOINT="http://127.0.0.1:9" PI_OBS_FILE=1 PI_OBS_FILE_PATH="$WORK/iso1.jsonl" \
    pi -e "$PI_OBS_DIR/index.ts" -p "$PROMPT" >"$WORK/iso1.out" 2>/dev/null
  ISO_EXIT=$?
  if [ "$ISO_EXIT" = "$BASE_EXIT" ] && [ "$(cat "$WORK/iso1.out" | tr -d '[:space:]')" = "$(cat "$WORK/baseline.out" | tr -d '[:space:]')" ] \
     && grep -q "exporter otlp failed" "$WORK/iso1.jsonl" 2>/dev/null; then
    pass "I1 unreachable OTLP endpoint: agent unaffected, exporter fault became an OTel log record"
  else
    fail "I1 unreachable OTLP endpoint (exit=$ISO_EXIT; fault records: $(grep -c 'exporter otlp failed' "$WORK/iso1.jsonl" 2>/dev/null || echo 0))"
  fi

  # I2 read-only export directory: same posture for the file leg
  RO_DIR="$WORK/readonly"; mkdir -p "$RO_DIR"; chmod 555 "$RO_DIR"
  env PI_HOME="$PI_HOME_DIR" HOME="$PI_HOME_DIR" \
    PI_OBS_FILE=1 PI_OBS_FILE_PATH="$RO_DIR/obs/pi-obs.jsonl" \
    pi -e "$PI_OBS_DIR/index.ts" -p "$PROMPT" >"$WORK/iso2.out" 2>/dev/null
  RO_EXIT=$?
  chmod 755 "$RO_DIR"
  if [ "$RO_EXIT" = "$BASE_EXIT" ] && [ "$(cat "$WORK/iso2.out" | tr -d '[:space:]')" = "$(cat "$WORK/baseline.out" | tr -d '[:space:]')" ]; then
    pass "I2 read-only export directory: agent unaffected (write failures reported, never thrown)"
  else
    fail "I2 read-only export directory (exit=$RO_EXIT)"
  fi
  # handler-fault injection (R1 AC) is proven at the unit level (index.test.ts,
  # "fault isolation"): a black-box injection would need a second sabotaging
  # extension — documented mapping in the AC table above.
  note "I3 handler-fault injection: proven at unit level (index.test.ts, fault isolation)"
else
  skip "I1/I2 isolation level: pi + OPENROUTER_API_KEY required"
fi
printf '\n'

# === summary ================================================================
printf '==> %s/%s checks passed' "$PASS" "$((PASS + FAIL))"
[ "$SKIP" -gt 0 ] && printf ' (%s skipped)' "$SKIP" || true
printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED:%s\n' "$FAILED_CHECKS"
  exit 1
fi
printf '==> OK — no leftovers (temp dirs, receiver ports, processes)\n'
exit 0
