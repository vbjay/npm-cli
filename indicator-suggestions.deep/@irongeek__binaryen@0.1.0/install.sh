#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1

if ! (which cmake && which git && which make) >/dev/null 2>/dev/null; then
  echo cmake, git, make required
  exit 1
fi

rm -rf binaryen
git clone https://github.com/WebAssembly/binaryen

rm -rf bin
cd binaryen
cmake . && make && cp -r bin ../bin
cd ..
