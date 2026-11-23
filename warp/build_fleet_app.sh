#!/usr/bin/env bash
# Build "Pi Agent Fleet.app" — a stay-open macOS app for the Dock.
#
# Why: a plain one-shot launcher (e.g. an Automator app) exits immediately
# after the click — no Dock "running" dot, and no way to handle a click
# while running. osacompile applets have the same flaw: they are NOT
# stay-open by default and quit as soon as the run handler returns (an
# idle handler alone does not keep them alive). This builder therefore
# compiles a tiny native Swift app (via swiftc from the Xcode Command Line
# Tools) that:
#   - runs agents_start.sh on launch AND on every Dock click while running
#     (applicationShouldHandleReopen) — every click converges the fleet;
#   - stays running while any agent container is up  -> black dot visible;
#   - terminates ~60s after the last agent stops      -> dot disappears.
#
# If swiftc is not available, it falls back to the osacompile applet
# (functional for launching, but it will not stay running / show the dot).
#
# Usage:
#   ./build_fleet_app.sh               # build into ~/Applications
#   ./build_fleet_app.sh /Applications # build into /Applications
#
# Requirements: macOS. Icon: repo's precomputed iconset/ (preferred) or
# AI-agent-fleet-Icon-rounded.png via sips. After building, remove any old
# launcher app from the Dock and drag "Pi Agent Fleet.app" in.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Pi Agent Fleet.app"
DEST="${1:-$HOME/Applications}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: macOS only" >&2; exit 1; }
[[ -f "$WARP_DIR/agents_start.sh" ]] || { echo "error: agents_start.sh not found next to this script" >&2; exit 1; }

SWIFTC="$(command -v swiftc || true)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$APP_NAME"

# --- Icon (.icns) ----------------------------------------------------------------

gen_icns() {  # gen_icns <app-bundle>
  local app="$1" iconset="$WORK/AppIcon.iconset"
  mkdir -p "$iconset" "$app/Contents/Resources"
  if ls "$WARP_DIR/iconset"/icon_*.png >/dev/null 2>&1; then
    cp "$WARP_DIR/iconset"/icon_*.png "$iconset/"
    echo "  icon: precomputed iconset/ (10 sizes, 16..1024)"
  else
    local src="$WARP_DIR/AI-agent-fleet-Icon-rounded.png"
    [[ -f "$src" ]] || src="$WARP_DIR/AI-agent-fleet-Icon.png"
    local s s2
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s" "$src" --out "$iconset/icon_${s}x${s}.png" >/dev/null
      s2=$(( s * 2 ))
      sips -z "$s2" "$s2" "$src" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
    done
    echo "  icon: generated from $(basename "$src") (sips)"
  fi
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
}

plist_set() {  # plist_set <plist> <key> <value>  (Set if present, Add as string otherwise)
  local plist="$1" key="$2" val="$3"
  /usr/libexec/PlistBuddy -c "Set :$key $val" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$key string $val" "$plist"
}

# --- Build the app ---------------------------------------------------------------

if [[ -n "$SWIFTC" ]]; then
  echo "Building native Swift app (stay-open, Dock dot, reopen support)..."
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

  cat > "$WORK/main.swift" <<'EOF'
// Pi Agent Fleet — Dock app for ~/pi-fleet-kit/warp (built by build_fleet_app.sh)
// Launch and every Dock click run agents_start.sh (idempotent: adds missing
// agents, skips running ones, heals orphans). Stays running while any agent
// container is up (Dock black dot); terminates ~60s after the fleet stops.

import Cocoa

final class FleetDelegate: NSObject, NSApplicationDelegate {
    let agents = ["pi-configs", "pi-coding", "pi-research", "pi-personal"]
    let grace: TimeInterval = 60
    var lastSeenUp = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        startFleet()
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in self.poll() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        startFleet()
        return true
    }

    func startFleet() {
        lastSeenUp = Date()
        _ = shell("nohup \"$HOME/pi-fleet-kit/warp/agents_start.sh\" > /tmp/pi-agent-fleet.log 2>&1 & exit 0")
    }

    func poll() {
        if fleetUp() {
            lastSeenUp = Date()
        } else if Date().timeIntervalSince(lastSeenUp) > grace {
            NSApp.terminate(nil)
        }
    }

    func fleetUp() -> Bool {
        for a in agents {
            if shell("\"$HOME/pi-fleet-kit/warp/agent_run.sh\" --check " + a) == 0 { return true }
        }
        return false
    }

    @discardableResult
    func shell(_ command: String) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", command]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit() } catch { return -1 }
        return p.terminationStatus
    }
}

let app = NSApplication.shared
let delegate = FleetDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
EOF

  "$SWIFTC" -O -o "$APP/Contents/MacOS/PiAgentFleet" "$WORK/main.swift"

  cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>PiAgentFleet</string>
	<key>CFBundleIconFile</key><string>AppIcon.icns</string>
	<key>CFBundleIdentifier</key><string>com.pi-fleet-kit.agent-fleet</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>Pi Agent Fleet</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.1</string>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF

  gen_icns "$APP"
  codesign --force -s - "$APP" >/dev/null 2>&1 || true   # ad-hoc signature
  echo "  compiled: Contents/MacOS/PiAgentFleet (swiftc -O)"
else
  echo "warning: swiftc not found (install Xcode Command Line Tools: xcode-select --install)" >&2
  echo "warning: falling back to osacompile applet — launching works, but the app" >&2
  echo "warning: will NOT stay running (no Dock dot, no click-while-running)." >&2
  cat > "$WORK/fleet.applescript" <<'EOF'
property GraceSeconds : 60
property LastSeenUp : missing value

on run
	try
		do shell script "nohup $HOME/pi-fleet-kit/warp/agents_start.sh > /tmp/pi-agent-fleet.log 2>&1 & exit 0"
	end try
end run

on reopen
	try
		do shell script "nohup $HOME/pi-fleet-kit/warp/agents_start.sh > /tmp/pi-agent-fleet.log 2>&1 & exit 0"
	end try
end reopen

on idle
	set LastSeenUp to (current date)
	return 15
end idle
EOF
  osacompile -o "$APP" "$WORK/fleet.applescript"
  gen_icns "$APP"
  plist_set "$APP/Contents/Info.plist" CFBundleIconFile AppIcon.icns
  plist_set "$APP/Contents/Info.plist" CFBundleIdentifier com.pi-fleet-kit.agent-fleet
  plist_set "$APP/Contents/Info.plist" CFBundleName "Pi Agent Fleet"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIcons" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
fi

touch "$APP"

# sanity: the icon reference must be exactly this (no stray "string")
grep -q "<string>AppIcon.icns</string>" "$APP/Contents/Info.plist" \
  || { echo "error: CFBundleIconFile not set correctly" >&2; exit 1; }

# --- Install -----------------------------------------------------------------------

mkdir -p "$DEST"
rm -rf "$DEST/$APP_NAME"
cp -R "$APP" "$DEST/$APP_NAME"
touch "$DEST/$APP_NAME"

# Force LaunchServices to re-read the bundle (icon cache busting).
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[[ -x "$LSREG" ]] && "$LSREG" -f "$DEST/$APP_NAME" >/dev/null 2>&1 || true

echo
echo "Built: $DEST/$APP_NAME"
echo "Next:"
echo "  1. Remove any previous launcher app from the Dock."
echo "  2. Drag '$APP_NAME' into the Dock."
echo "  3. Click it: the dot appears while agents run and disappears ~60s after the last one stops."
