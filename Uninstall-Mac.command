#!/bin/bash
set -u
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.niterix.captionist"

echo
echo "  Removing Captionist from:"
echo "    $DEST"
echo

if [ ! -d "$DEST" ]; then
  echo "  Nothing to remove - Captionist is not installed for this user."
else
  rm -rf "$DEST"
  if [ -d "$DEST" ]; then
    echo "  [X] Could not remove it. Close Premiere Pro and try again."
  else
    echo "  [ok] Captionist removed."
  fi
fi

echo
echo "  The CEP \"unsigned extensions\" setting was left alone, because other"
echo "  extensions may rely on it. To clear it yourself:"
echo "    defaults delete com.adobe.CSXS.11 PlayerDebugMode"
echo
read -r -p "  Press return to close." _
