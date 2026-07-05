#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# Build script for jatin-lean Node.js bindings

set -e

echo "🔨 Building jatin-lean Node.js bindings..."

# Build the Rust library with napi feature
cargo build --release --features napi

# Copy the built library to the correct location
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    cp target/release/libjatin_lean.so index.node
    echo "✅ Built for Linux (index.node)"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    cp target/release/libjatin_lean.dylib index.node
    echo "✅ Built for macOS (index.node)"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    cp target/release/jatin_lean.dll index.node
    echo "✅ Built for Windows (index.node)"
else
    echo "❌ Unknown platform: $OSTYPE"
    exit 1
fi

echo "✅ Build complete!"
