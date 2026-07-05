#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1

if ! (which cmake && which git && which make) >/dev/null 2>/dev/null; then
  echo cmake, git, make required
  exit 1
fi

rm -rf wabt
git clone --recursive https://github.com/WebAssembly/wabt

rm -rf bin build
mkdir build && cd build
cmake ../wabt && cmake --build . && cp -r ../wabt/bin ../bin
cd .. && rm -rf build
