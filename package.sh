#!/usr/bin/env bash
# Build the Chrome Web Store upload zip.
#
# The store assigns the production extension id, so the dev `key` (which pins a
# stable id for unpacked multi-machine testing) is stripped from the packaged
# manifest. Output: dist/truepin-<version>.zip with manifest.json at the root.
set -euo pipefail
cd "$(dirname "$0")"

VER=$(node -e "console.log(require('./extension/manifest.json').version)")
OUT="dist/truepin-$VER.zip"

rm -rf dist/build
mkdir -p dist/build
cp -R extension/. dist/build/

# Strip the dev-only `key` so the Web Store owns the production id.
node -e "const fs=require('fs');const p='dist/build/manifest.json';const m=JSON.parse(fs.readFileSync(p));delete m.key;fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n')"

find dist/build -name '.DS_Store' -delete
rm -f "$OUT"
( cd dist/build && zip -rqX "../truepin-$VER.zip" . )
rm -rf dist/build

echo "built $OUT"
