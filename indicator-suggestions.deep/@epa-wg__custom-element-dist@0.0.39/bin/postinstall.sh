#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# to be treated as internal by test coverage
#npm link @epa-wg/custom-element

# Resolve package path — works with yarn PnP, yarn node-modules linker, and npm
PKG_DIR=$(node -e "console.log(require.resolve('@epa-wg/custom-element/package.json').replace(/[\/\\\\]package\\.json\$/, '').replace(/\\\\/g, '/'))")
CEM_THEME_DIR=$(node -e "console.log(require.resolve('@epa-wg/cem-theme/package.json').replace(/[\/\\\\]package\\.json\$/, '').replace(/\\\\/g, '/'))")

cd src/custom-element
mkdir -p demo
mkdir -p ide

rm -f *.d.ts
rm -f *.js
pwd
cp "$PKG_DIR"/*.d.ts .
cp "$PKG_DIR"/*.js .
cp "$PKG_DIR"/index.html index.html
cp -r "$PKG_DIR"/demo/* demo/
cp -r "$PKG_DIR"/ide/* ide/

cd ..
mkdir -p css
cp "$CEM_THEME_DIR"/dist/lib/css/cem-combined.css css/

cp -r demo ../../public
