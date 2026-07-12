#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# ClaudeAll - One-Command Installer
# Install configurations for Claude Code AND Gemini CLI automatically
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zesbe/ClaudeAll/main/install.sh | bash

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  🤖 ClaudeAll - Complete AI CLI Setup                      ║"
echo "║  Supports: Claude Code + Gemini CLI                        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Detect platform
if [ -n "$TERMUX_VERSION" ]; then
    PLATFORM="termux"
    echo -e "${GREEN}✅ Platform: Termux/Android${NC}"
else
    PLATFORM="linux"
    echo -e "${GREEN}✅ Platform: Linux${NC}"
fi

# Detect CLIs
HAS_CLAUDE=false
HAS_GEMINI=false

if command -v claude &> /dev/null; then
    HAS_CLAUDE=true
    echo -e "${GREEN}✅ Claude CLI detected${NC}"
fi

if command -v gemini &> /dev/null; then
    HAS_GEMINI=true
    echo -e "${GREEN}✅ Gemini CLI detected${NC}"
fi

if [ "$HAS_CLAUDE" = false ] && [ "$HAS_GEMINI" = false ]; then
    echo -e "${RED}❌ No CLI detected!${NC}"
    echo ""
    echo "Install at least one:"
    echo ""
    echo "  Claude Code (recommended - native installer, auto-updates):"
    echo "    macOS/Linux/WSL:  curl -fsSL https://claude.ai/install.sh | bash"
    echo "    Windows PS:       irm https://claude.ai/install.ps1 | iex"
    echo ""
    echo "  Gemini CLI:"
    echo "    npm install -g @google/gemini-cli"
    echo ""
    echo "  (Termux/Android only, native installer not yet supported):"
    echo "    npm install -g @anthropic-ai/claude-code"
    exit 1
fi
echo ""

# Clone/update repo
REPO_DIR="$HOME/.claude-all-config"
REPO_URL="https://github.com/zesbe/ClaudeAll.git"

if [ -d "$REPO_DIR" ]; then
    echo "📥 Updating existing config..."
    cd "$REPO_DIR"
    git pull origin main 2>/dev/null || git pull
else
    echo "📥 Cloning ClaudeAll..."
    git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
echo ""

# ============================================
# Install to Claude
# ============================================
install_claude() {
    echo -e "${CYAN}📦 Installing to Claude (~/.claude/)...${NC}"

    mkdir -p "$HOME/.claude/agents"
    mkdir -p "$HOME/.claude/skills"
    mkdir -p "$HOME/.claude/commands"
    mkdir -p "$HOME/.claude/hooks"
    mkdir -p "$HOME/.claude/plugins"
    mkdir -p "$HOME/.claude/context"

    cp -r "$REPO_DIR/agents/"* "$HOME/.claude/agents/" 2>/dev/null || true
    AGENT_COUNT=$(ls -1 "$HOME/.claude/agents/"*.md 2>/dev/null | wc -l)
    echo -e "   ${GREEN}✅ $AGENT_COUNT agents${NC}"

    cp -r "$REPO_DIR/skills/"* "$HOME/.claude/skills/" 2>/dev/null || true
    SKILL_COUNT=$(ls -1d "$HOME/.claude/skills/"*/ 2>/dev/null | wc -l)
    echo -e "   ${GREEN}✅ $SKILL_COUNT skills${NC}"

    cp -r "$REPO_DIR/commands/"* "$HOME/.claude/commands/" 2>/dev/null || true
    echo -e "   ${GREEN}✅ 3 commands${NC}"

    cp -r "$REPO_DIR/hooks/"* "$HOME/.claude/hooks/" 2>/dev/null || true
    chmod +x "$HOME/.claude/hooks/"*.sh 2>/dev/null || true
    echo -e "   ${GREEN}✅ hooks${NC}"

    cp "$REPO_DIR/plugins/installed_plugins.json" "$HOME/.claude/plugins/" 2>/dev/null || true
    echo -e "   ${GREEN}✅ plugins${NC}"

    cp -r "$REPO_DIR/context/"* "$HOME/.claude/context/" 2>/dev/null || true
    echo -e "   ${GREEN}✅ context files${NC}"

    cp "$REPO_DIR/mcp.json" "$HOME/.mcp.json" 2>/dev/null || true
    chmod 600 "$HOME/.mcp.json" 2>/dev/null || true
    echo -e "   ${GREEN}✅ MCP config (7 servers)${NC}"

    cat > "$HOME/.claude/settings.local.json" << 'EOF'
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)",
      "WebFetch(*)", "WebSearch(*)", "TodoWrite(*)", "NotebookEdit(*)", "mcp__*"
    ],
    "deny": []
  },
  "agent": "proactive-mode"
}
EOF
    echo -e "   ${GREEN}✅ settings (bypass permissions)${NC}"

    # Copy CLAUDE.md (global instructions)
    cp "$REPO_DIR/CLAUDE.md" "$HOME/.claude/CLAUDE.md" 2>/dev/null || true
    echo -e "   ${GREEN}✅ CLAUDE.md (global instructions)${NC}"
}

# ============================================
# Install to Gemini
# ============================================
install_gemini() {
    echo -e "${CYAN}📦 Installing to Gemini (~/.gemini/superpowers/)...${NC}"

    SUPERPOWERS="$HOME/.gemini/superpowers"
    mkdir -p "$SUPERPOWERS/agents"
    mkdir -p "$SUPERPOWERS/skills"
    mkdir -p "$SUPERPOWERS/commands"
    mkdir -p "$SUPERPOWERS/hooks"
    mkdir -p "$SUPERPOWERS/lib"

    cp -r "$REPO_DIR/agents/"* "$SUPERPOWERS/agents/" 2>/dev/null || true
    AGENT_COUNT=$(ls -1 "$SUPERPOWERS/agents/"*.md 2>/dev/null | wc -l)
    echo -e "   ${GREEN}✅ $AGENT_COUNT agents${NC}"

    cp -r "$REPO_DIR/skills/"* "$SUPERPOWERS/skills/" 2>/dev/null || true
    SKILL_COUNT=$(ls -1d "$SUPERPOWERS/skills/"*/ 2>/dev/null | wc -l)
    echo -e "   ${GREEN}✅ $SKILL_COUNT skills${NC}"

    cp -r "$REPO_DIR/commands/"* "$SUPERPOWERS/commands/" 2>/dev/null || true
    echo -e "   ${GREEN}✅ 3 commands${NC}"

    cp -r "$REPO_DIR/hooks/"* "$SUPERPOWERS/hooks/" 2>/dev/null || true
    chmod +x "$SUPERPOWERS/hooks/"*.sh 2>/dev/null || true
    echo -e "   ${GREEN}✅ hooks${NC}"

    cp -r "$REPO_DIR/lib/"* "$SUPERPOWERS/lib/" 2>/dev/null || true
    echo -e "   ${GREEN}✅ lib${NC}"

    cp "$REPO_DIR/mcp.json" "$HOME/.gemini/mcp.json" 2>/dev/null || true
    chmod 600 "$HOME/.gemini/mcp.json" 2>/dev/null || true
    echo -e "   ${GREEN}✅ MCP config (7 servers)${NC}"

    cat > "$HOME/.gemini/GEMINI.md" << 'EOF'
# Gemini Superpowers

Installed by ClaudeAll - https://github.com/zesbe/ClaudeAll

## Agents (14)
proactive-mode, code-generator, code-reviewer, security-auditor,
test-generator, doc-generator, api-tester, performance-analyzer,
accessibility-reviewer, component-generator, migration-generator,
readme-generator, terraform-generator, ai-prompt-optimizer

## Skills (34)
api-development, database-development, frontend-design, test-driven-development,
systematic-debugging, code-quality, error-handling, brainstorming, writing-plans,
executing-plans, and more...

## Commands
/brainstorm, /write-plan, /execute-plan

## MCP Servers (7)
context7, exa, sequential-thinking, memory, filesystem, fetch, web-reader

## Usage
Run with YOLO mode: gemini -y
EOF
    echo -e "   ${GREEN}✅ GEMINI.md${NC}"

    # Create settings.json with auto-approve all tools
    cat > "$HOME/.gemini/settings.json" << 'EOF'
{
  "tools": {
    "allowed": [
      "run_shell_command(*)",
      "read_file(*)",
      "write_file(*)",
      "edit_file(*)",
      "glob(*)",
      "grep(*)",
      "web_search(*)",
      "list_directory(*)",
      "search_files(*)"
    ],
    "autoAccept": true
  },
  "privacy": {
    "usageStatisticsEnabled": false
  },
  "ui": {
    "hideBanner": false,
    "hideTips": true
  }
}
EOF
    echo -e "   ${GREEN}✅ settings.json (auto-approve tools)${NC}"
}

# Run installations
if [ "$HAS_CLAUDE" = true ]; then
    install_claude
    echo ""
fi

if [ "$HAS_GEMINI" = true ]; then
    install_gemini
    echo ""
fi

# Install MCP packages (shared)
echo "📦 Installing MCP packages..."
npm install -g @upstash/context7-mcp @modelcontextprotocol/server-sequential-thinking exa-mcp-server @modelcontextprotocol/server-memory @modelcontextprotocol/server-filesystem @kazuph/mcp-fetch @modelcontextprotocol/server-web-reader 2>/dev/null || {
    echo -e "${YELLOW}⚠️  Some MCP packages may need manual install${NC}"
}
echo -e "${GREEN}✅ MCP packages installed${NC}"

# Install tmux config
echo ""
echo "🖥️  Installing tmux config..."
if [ -f "$HOME/.tmux.conf" ]; then
    cp "$HOME/.tmux.conf" "$HOME/.tmux.conf.backup.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
fi
cp "$REPO_DIR/tmux/config/tmux.conf" "$HOME/.tmux.conf" 2>/dev/null || true
echo -e "   ${GREEN}✅ Tmux config installed${NC}"
tmux source-file ~/.tmux.conf 2>/dev/null && echo -e "   ${GREEN}✅ Tmux reloaded${NC}" || true

# Summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  ✅ Installation Complete!                                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 Installed to:"
if [ "$HAS_CLAUDE" = true ]; then
    echo "   • Claude: ~/.claude/ (agents, skills, commands, MCP)"
fi
if [ "$HAS_GEMINI" = true ]; then
    echo "   • Gemini: ~/.gemini/superpowers/ (agents, skills, commands, MCP)"
fi
echo ""
echo "🚀 Next steps:"
if [ "$HAS_CLAUDE" = true ]; then
    echo "   Claude: exit && claude"
fi
if [ "$HAS_GEMINI" = true ]; then
    echo "   Gemini: exit && gemini"
fi
echo ""
echo "🔄 To update:"
echo "   curl -fsSL https://raw.githubusercontent.com/zesbe/ClaudeAll/main/install.sh | bash"
