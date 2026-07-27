#!/usr/bin/env bash
# Re-copy the vendored luting core from the Luting Studio repo.
#
# src/luting-core/ is a verbatim copy of Luting Studio's src/lib/ modules that
# Luting Hero depends on (the .lute parser, the Web Audio engine, the sample
# loader, Web MIDI input) plus its sample packs and mascot art. Nothing in
# src/luting-core/ should ever be hand-edited — run this after an upstream fix
# and the copies stay diffable against their source.
#
# Usage:  ./scripts/sync-core.sh [path-to-luting-studio]   (default: ../luting)
set -euo pipefail

SRC="${1:-../luting}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$SRC/src/lib/luting.ts" ]; then
  echo "Not a Luting Studio checkout: $SRC" >&2
  echo "Usage: $0 [path-to-luting-studio]" >&2
  exit 1
fi

echo "Syncing from $SRC"
for f in luting.ts player.ts samples.ts midi.ts; do
  cp "$SRC/src/lib/$f" "$HERE/src/luting-core/$f"
  echo "  src/luting-core/$f"
done

# gmDrum.ts is the GM_DRUM table lifted out of Luting Studio's convert.ts (the
# rest of that module pulls in @tonejs/midi, which the game has no use for), so
# it can't be copied wholesale. Flag a drift instead of silently diverging.
if ! grep -q "GM_DRUM" "$SRC/src/lib/convert.ts"; then
  echo "  ! GM_DRUM no longer in convert.ts — check src/luting-core/gmDrum.ts by hand" >&2
elif ! diff -q \
  <(sed -n '/^export const GM_DRUM/,/^}/p' "$SRC/src/lib/convert.ts") \
  <(sed -n '/^export const GM_DRUM/,/^}/p' "$HERE/src/luting-core/gmDrum.ts") >/dev/null; then
  echo "  ! GM_DRUM differs upstream — update src/luting-core/gmDrum.ts by hand" >&2
else
  echo "  src/luting-core/gmDrum.ts (up to date)"
fi

for f in luting.webp conducting.webp dumb.webp; do
  cp "$SRC/src/assets/$f" "$HERE/src/assets/$f"
  echo "  src/assets/$f"
done

rm -rf "$HERE/public/samples"
cp -R "$SRC/public/samples" "$HERE/public/samples"
echo "  public/samples/ ($(ls "$HERE/public/samples" | wc -l | tr -d ' ') files)"

# Songs are deliberately NOT copied: Luting Hero ships with none, and the
# player's collection lives in their own browser.

echo "Done. Review with: git diff src/luting-core"
