#!/bin/sh
# Render the product mark to the PNG sizes Chrome asks an extension for.
#
# The mark is authored once, as SVG, in the product site's assets. Chrome takes
# PNGs and picks per surface and per display density: 16 for the favicon-sized
# slot, 32 for Windows, 48 for the management page, 128 for the store and the
# install dialog. A size it wants and cannot find is upscaled from one it can,
# which is how a toolbar ends up showing a blurred 16px mark on a retina screen.
#
# System tools only, and deliberately: the extension takes no dependencies, and
# a build step that needs an npm install of a native image library to produce
# four files that change once a year is a worse trade than a shell script that
# only runs on the machine the mark changes on. `qlmanage` is macOS's own
# renderer (WebKit underneath, so the SVG is read the way a browser reads it)
# and `sips` is its resampler. The output is committed, so nobody else needs
# either of them to build or load the extension.
#
# Usage:  sh scripts/render-icons.sh [path/to/mark.svg]
set -eu

MARK="${1:-../virgil-product-site/site/virgil/assets/mark.svg}"
HERE=$(dirname "$0")
OUT="$HERE/../extension/assets"

[ -f "$MARK" ] || { echo "no mark at $MARK" >&2; exit 1; }
command -v qlmanage >/dev/null || { echo "qlmanage is macOS-only; render the sizes by hand" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Rendered once, large, then resampled down. Rendering each size from the SVG
# would be better still if the renderer took a size; qlmanage takes a bounding
# box and rounds, and 16 is small enough that its rounding is visible.
cp "$MARK" "$WORK/mark.svg"
qlmanage -t -s 1024 -o "$WORK" "$WORK/mark.svg" >/dev/null 2>&1
[ -f "$WORK/mark.svg.png" ] || { echo "qlmanage produced no thumbnail" >&2; exit 1; }

mkdir -p "$OUT"
for size in 16 32 48 128; do
  cp "$WORK/mark.svg.png" "$OUT/icon-$size.png"
  sips -Z "$size" "$OUT/icon-$size.png" >/dev/null
done

echo "wrote $OUT/icon-{16,32,48,128}.png"
