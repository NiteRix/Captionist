#!/bin/bash
#
# Captionist installer for macOS.
# Copies the panel into Premiere's user extension folder and tells CEP that
# unsigned extensions may load. No admin rights required.
#
# Flags: --silent

set -u

EXT_ID="com.niterix.captionist"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
SILENT=0

for arg in "$@"; do
  case "$arg" in
    --silent) SILENT=1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "  ==========================================="
echo "    Captionist for Premiere Pro"
echo "  ==========================================="
echo

# --- locate the payload ------------------------------------------------------
SRC=""
for candidate in "$HERE/extension" "$HERE/../../extension" "$HERE/../extension"; do
  if [ -f "$candidate/CSXS/manifest.xml" ]; then
    SRC="$(cd "$candidate" && pwd)"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "  [X] Could not find the \"extension\" folder next to this installer."
  echo "      Keep Install-Mac.command in the same folder as \"extension\"."
  [ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
  exit 1
fi

if pgrep -x "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "  [!] Premiere Pro is open. The panel appears after you restart it."
  echo
fi

# --- copy --------------------------------------------------------------------
echo "  Installing to:"
echo "    $DEST"
echo

rm -rf "$DEST"
mkdir -p "$DEST"
if ! cp -R "$SRC/." "$DEST/"; then
  echo "  [X] Copy failed."
  [ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
  exit 1
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
echo "  [ok] Panel files copied."

# --- allow unsigned extensions ----------------------------------------------
for v in 6 7 8 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
killall cfprefsd >/dev/null 2>&1 || true
echo "  [ok] Unsigned extensions enabled for CEP 6-12."

# --- tools -------------------------------------------------------------------
# No macOS binaries are bundled yet, so both tools come from Homebrew.
# Captionist looks on your PATH automatically.
MISSING=""
command -v ffmpeg      >/dev/null 2>&1 || MISSING="$MISSING ffmpeg"
[ -x "$DEST/bin/whisper-cli" ] || command -v whisper-cli >/dev/null 2>&1 || MISSING="$MISSING whisper-cli"

if [ -z "$MISSING" ]; then
  echo "  [ok] ffmpeg and whisper-cli are both available."
else
  echo "  [!] Not found on this Mac:$MISSING"
  echo
  echo "      Captionist does not yet bundle macOS binaries. Install them with:"
  echo "          brew install ffmpeg whisper-cpp"
  echo
  echo "      Or point the panel at your own copies in its Details section."
fi

echo
echo "  Speech models are NOT bundled - they run to hundreds of megabytes and"
echo "  which one you want is your call. Pick one in the panel's Models tab;"
echo "  they live in ~/Library/Application Support/Captionist/models and"
echo "  survive updates."

echo
echo "  ==========================================="
echo "    Done."
echo
echo "    Restart Premiere Pro, then open:"
echo "      Window  >  Extensions  >  Captionist"
echo "  ==========================================="
echo
[ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
exit 0
