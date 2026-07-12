#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# Auto-register Agentics CLI as a global MCP server in Claude Code.
# Best-effort: silently exits if Claude Code is not installed.

# Skip in CI environments
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ] || [ -n "$JENKINS_URL" ]; then
  exit 0
fi

# Skip during npm publish
if [ -n "$npm_command" ] && [ "$npm_command" = "publish" ]; then
  exit 0
fi

# Check if claude CLI exists
if ! command -v claude >/dev/null 2>&1; then
  exit 0
fi

# Determine the best command to register:
# 1. If `agentics` is on PATH (global install), use it directly (fastest, no cold-start)
# 2. Otherwise fall back to npx (slower due to download on first run)
if command -v agentics >/dev/null 2>&1; then
  AGENTICS_CMD="agentics"
else
  AGENTICS_CMD="npx -y @llm-dev-ops/agentics-cli@latest"
fi

# Remove stale registration if present, then re-register.
# Timeout after 5s and redirect stdin to avoid blocking npm install.
timeout 5 claude mcp remove agentics </dev/null >/dev/null 2>&1 || true
timeout 5 claude mcp add -s user agentics -- $AGENTICS_CMD </dev/null >/dev/null 2>&1 || true

exit 0
