#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1

pushd $(npm config get prefix)/bin
sudo ln -s ../lib/node_modules/serve-wasm-http/bin/wasm_serv.js serve-wasm-http
popd
