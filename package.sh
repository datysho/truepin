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
# One zip in dist, ever: a stale zip of an older version has already been
# hand-uploaded once (see the dist-rebuild lesson in the knowledge base).
rm -f dist/truepin-*.zip
( cd dist/build && zip -rqX "../truepin-$VER.zip" . )
rm -rf dist/build

# Guard: the packaged manifest must carry the source version and no dev key.
ZIPVER=$(unzip -p "$OUT" manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);if(m.key){console.error('dev key leaked into the package');process.exit(1)}console.log(m.version)})")
if [ "$ZIPVER" != "$VER" ]; then
  echo "version mismatch: zip=$ZIPVER manifest=$VER" >&2
  exit 1
fi

echo "built $OUT (v$VER, dev key stripped)"
