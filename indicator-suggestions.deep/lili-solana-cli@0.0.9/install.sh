#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
#!/bin/bash
set -euo pipefail


# Lili CLI Installation Script
# This script installs all dependencies and sets up the Lili CLI

echo "🚀 Installing Lili CLI..."
echo ""

npm run build >/dev/null 2>&1 || true
# Check Node.js version
echo "📋 Checking Node.js version..."
NODE_VERSION=$(node -v 2>/dev/null)

if [ -z "$NODE_VERSION" ]; then
    echo "❌ Node.js is not installed!"
    echo "Please install Node.js v18 or higher from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js $NODE_VERSION detected"
echo ""

# Make lili.js executable
echo "🔧 Making lili.js executable..."
chmod +x dist/lili.js || chmod +x lili.js || true

echo "✅ lili.js is now executable"
echo ""

# In postinstall context, npm has already installed deps and created bin links.
# Skip redundant npm install/link to avoid recursion and permission issues.
if [ "${npm_lifecycle_event-}" != "postinstall" ]; then
  echo "📦 Installing npm dependencies..."
  # Pin compatible Metaplex JS version to avoid notarget errors
  if grep -q '"@metaplex-foundation/js"' package.json; then
    npm pkg set 'dependencies.@metaplex-foundation/js=^0.19.4' >/dev/null 2>&1 || true
  fi
  npm install || { echo "❌ Failed to install dependencies"; exit 1; }
  echo "✅ Dependencies installed successfully"
  echo ""

  echo "🔗 Linking Lili CLI globally..."
  npm link || { echo "❌ Failed to link globally"; echo "   Try: sudo npm link"; exit 1; }
  echo "✅ Global command 'lili' is now available"
  echo ""
fi

# Ensure Solana CLI is installed automatically
if ! command -v solana &> /dev/null; then
    echo "🛰️  Solana CLI not detected. Installing stable release..."

    install_solana_cli() {
        # Try official installer with retries, handling download errors explicitly
        local installer_tmp
        installer_tmp=$(mktemp -t solana-installer-XXXXXX)
        if curl --fail --retry 3 --retry-delay 2 -sSfL https://release.solana.com/stable/install -o "$installer_tmp"; then
            chmod +x "$installer_tmp"
            # Run installer non-interactively; suppress output to keep script tidy
            if sh "$installer_tmp" >/tmp/lili-solana-install.log 2>&1; then
                rm -f "$installer_tmp"
                return 0
            fi
            rm -f "$installer_tmp"
            return 1
        fi
        rm -f "$installer_tmp"
        return 1
    }

    ensure_solana_path() {
        local solana_bin="$HOME/.local/share/solana/install/active_release/bin"
        if [ -d "$solana_bin" ]; then
            case ":$PATH:" in
                *":$solana_bin:"*) : ;; # already present
                *) export PATH="$solana_bin:$PATH" ;; 
            esac
            # Persist for future shells when possible
            local profile="$HOME/.zprofile"
            if [ -w "$profile" ] || [ ! -e "$profile" ]; then
                if ! grep -qs "$solana_bin" "$profile" 2>/dev/null; then
                    echo "export PATH=\"$solana_bin:\$PATH\"" >> "$profile"
                fi
            fi
        fi
    }

    if install_solana_cli; then
        echo "✅ Solana CLI installed via official installer"
        ensure_solana_path
    else
        echo "⚠️  Solana installer download failed; attempting Homebrew fallback"
        if command -v brew &> /dev/null; then
            if brew install solana >/tmp/lili-solana-install.log 2>&1; then
                echo "✅ Solana CLI installed via Homebrew"
                # Ensure common Homebrew paths are in PATH for current session
                for brew_prefix in /opt/homebrew /usr/local; do
                    if [ -d "$brew_prefix/bin" ]; then
                        case ":$PATH:" in
                            *":$brew_prefix/bin:"*) : ;;
                            *) export PATH="$brew_prefix/bin:$PATH" ;;
                        esac
                        profile="$HOME/.zprofile"
                        if [ -w "$profile" ] || [ ! -e "$profile" ]; then
                            if ! grep -qs "$brew_prefix/bin" "$profile" 2>/dev/null; then
                                echo "export PATH=\"$brew_prefix/bin:\$PATH\"" >> "$profile"
                            fi
                        fi
                    fi
                done
            else
                echo "❌ Homebrew installation of Solana CLI failed"
                echo "   Inspect /tmp/lili-solana-install.log for details"
                exit 1
            fi
        else
            echo "❌ Could not install Solana CLI automatically"
            echo "   Please install Homebrew (https://brew.sh) then run: brew install solana"
            echo "   After installation re-run ./install.sh"
            exit 1
        fi
    fi

    ensure_solana_path

    if ! command -v solana &> /dev/null; then
        echo "❌ Solana CLI installation completed but binary not found on PATH"
        echo "   Ensure \"$HOME/.local/share/solana/install/active_release/bin\" or Homebrew bin directory is in PATH"
        exit 1
    fi

    echo "✅ Solana CLI ready: $(solana --version)"
else
    echo "✅ Solana CLI detected: $(solana --version)"
    # Ensure the official Solana bin (which may contain cargo-build-sbf) is on PATH
    SOL_BIN="$HOME/.local/share/solana/install/active_release/bin"
    if [ -d "$SOL_BIN" ]; then
      case ":$PATH:" in *":$SOL_BIN:"*) : ;; *) export PATH="$SOL_BIN:$PATH" ;; esac
      profile="$HOME/.zprofile"
      if [ -w "$profile" ] || [ ! -e "$profile" ]; then
        if ! grep -qs "$SOL_BIN" "$profile" 2>/dev/null; then
          echo "export PATH=\"$SOL_BIN:\$PATH\"" >> "$profile"
        fi
      fi
    fi
fi

# Ensure SBF SDK exists; if missing, initialize via solana-install
SOL_SDK_DIR="$HOME/.local/share/solana/install/active_release/bin/sdk/sbf"
if [ ! -d "$SOL_SDK_DIR" ]; then
  if command -v solana-install >/dev/null 2>&1; then
    echo "🧰 Installing Solana SBF SDK (stable)..."
    solana-install init stable >/tmp/lili-solana-install.log 2>&1 || true
    # Refresh PATH and re-check
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
  fi
fi

echo ""

# Ensure Rust toolchain (Cargo) is installed
if ! command -v cargo &> /dev/null; then
    echo "🦀 Rust toolchain not detected. Installing via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

    if [ -f "$HOME/.cargo/env" ]; then
        # shellcheck source=/dev/null
        . "$HOME/.cargo/env"
# Ensure Cargo uses system git to avoid auth prompts in corporate envs
mkdir -p "$HOME/.cargo"
CARGO_CFG="$HOME/.cargo/config.toml"
if ! grep -q "git-fetch-with-cli" "$CARGO_CFG" 2>/dev/null; then
  {
    echo "[net]"
    echo "git-fetch-with-cli = true"
  } >> "$CARGO_CFG"
fi

# Skip cargo-build-sbf plugin install (no git). Use fallbacks at build time.
echo "ℹ️  Skipping cargo-build-sbf install (no git). CLI will use solana program build/cargo build-bpf/anchor build."

    fi

    if ! command -v cargo &> /dev/null; then
        echo "❌ Rust installation failed"
        exit 1
    fi
else
    echo "✅ Rust detected: $(cargo --version)"
fi

# Ensure Solana and Cargo bins are on PATH for current session
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Ensure cargo-build-sbf is available (install if missing)
SOL_BIN="$HOME/.local/share/solana/install/active_release/bin"
if ! command -v cargo-build-sbf >/dev/null 2>&1 && [ ! -x "$SOL_BIN/cargo-build-sbf" ]; then
  echo "ℹ️  cargo-build-sbf not found; skipping install to keep setup fast."
  echo "   Builds will auto-fallback to: cargo build-bpf / solana program build / anchor build."
  echo "   Optional later install: CARGO_NET_GIT_FETCH_WITH_CLI=true cargo install --git https://github.com/solana-labs/cargo-build-sbf"
fi

# Install cargo-build-sbf without git (prebuilt Solana release)
echo "⬇️  Fetching prebuilt cargo-build-sbf..."
ver=v1.18.20
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) triple=aarch64-apple-darwin;;
  Darwin-x86_64) triple=x86_64-apple-darwin;;
  Linux-aarch64) triple=aarch64-unknown-linux-gnu;;
  Linux-x86_64) triple=x86_64-unknown-linux-gnu;;
  *) triple="";;
esac
fetch_cargo_build_sbf() {
  tmpdir="$(mktemp -d)"
  dest="$HOME/.local/share/solana/install/active_release/bin"; mkdir -p "$dest"
  _curl_bin="curl"
  # Prefer Homebrew curl if available (fixes macOS LibreSSL issues)
  if command -v brew >/dev/null 2>&1 && brew --prefix curl >/dev/null 2>&1; then
    _brew_curl="$(brew --prefix curl 2>/dev/null)/bin/curl"
    [ -x "$_brew_curl" ] && _curl_bin="$_brew_curl"
  fi
  # Try Solana CDN
  if ! "$_curl_bin" -L --retry 3 --retry-delay 2 --tlsv1.2 "https://release.solana.com/$ver/solana-release-$triple.tar.bz2" -o "$tmpdir/sol.t"; then
    # Try GitHub release mirror (no auth)
    if ! "$_curl_bin" -L --retry 3 --retry-delay 2 --tlsv1.2 "https://github.com/solana-labs/solana/releases/download/$ver/solana-release-$triple.tar.bz2" -o "$tmpdir/sol.t"; then
      # As last resort, use Python downloader
      if command -v python3 >/dev/null 2>&1; then
        python3 - <<PY || true
import ssl,urllib.request,sys
ctx=ssl.create_default_context()
for url in [
  f"https://release.solana.com/{sys.argv[1]}/solana-release-{sys.argv[2]}.tar.bz2",
  f"https://github.com/solana-labs/solana/releases/download/{sys.argv[1]}/solana-release-{sys.argv[2]}.tar.bz2"
]:
  try:
    with urllib.request.urlopen(url, context=ctx) as r, open(sys.argv[3], 'wb') as f:
      f.write(r.read()); sys.exit(0)
  except Exception as e:
    pass
sys.exit(1)
PY
 "$ver" "$triple" "$tmpdir/sol.t" || { echo "❌ Unable to download prebuilt cargo-build-sbf"; rm -rf "$tmpdir"; return 1; }
      else
        echo "❌ Unable to download prebuilt cargo-build-sbf (no working curl/python)"; rm -rf "$tmpdir"; return 1
      fi
    fi
  fi
  tar -xjf "$tmpdir/sol.t" -C "$tmpdir" || true
  if [ -x "$tmpdir/solana-release/bin/cargo-build-sbf" ]; then src="$tmpdir/solana-release/bin/cargo-build-sbf"; else src="$tmpdir/bin/cargo-build-sbf"; fi
  sdk_src_root="$tmpdir/solana-release/sdk"
  dest_root="$HOME/.local/share/solana/install/active_release"
# Ensure cargo build-sbf subcommand is available via cargo if not in PATH
if ! command -v cargo-build-sbf >/dev/null 2>&1 && [ -x "$HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf" ]; then
  ln -sf "$HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf" "$HOME/.cargo/bin/cargo-build-sbf" 2>/dev/null || true
fi


  if [ -x "$src" ]; then
    # Fallback: locate SDK in archive and install if copy above didn’t run
    if [ ! -d "$dest_root/sdk/sbf" ]; then
      sdk_found_dir="$(find "$tmpdir" -maxdepth 5 -type d -path "*/sdk/sbf" 2>/dev/null | head -n1 || true)"
      if [ -n "$sdk_found_dir" ]; then
        mkdir -p "$dest_root"
        cp -R "$(dirname "$sdk_found_dir")" "$dest_root/" 2>/dev/null || true
        [ -d "$dest_root/sdk/sbf" ] || echo "❌ Failed to copy SBF SDK"
        # Ensure bin/sdk -> ../sdk symlink
        [ -L "$dest/sdk" ] || ln -s ../sdk "$dest/sdk" 2>/dev/null || true
      fi
    fi
    # Ensure cargo subcommand is resolvable via cargo build-sbf
    mkdir -p "$HOME/.cargo/bin"
    [ -x "$HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf" ] && ln -sf "$HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf" "$HOME/.cargo/bin/cargo-build-sbf" 2>/dev/null || true


# Ensure compatibility symlink for cargo subcommand relative SDK resolution
SOLROOT="$HOME/.local/share/solana/install/active_release"
if [ -d "$SOLROOT/sdk/sbf" ]; then
  mkdir -p "$HOME/.cargo/bin"
  ln -sfn "$SOLROOT/sdk" "$HOME/.cargo/bin/sdk" 2>/dev/null || true
fi

    cp "$src" "$dest/" && chmod +x "$dest/cargo-build-sbf"
    if [ -d "$sdk_src_root/sbf" ]; then
      mkdir -p "$dest_root"
      rm -rf "$dest_root/sdk" && cp -R "$sdk_src_root" "$dest_root/"
      # Ensure bin/sdk -> ../sdk symlink so cargo-build-sbf finds sdk under bin
      [ -L "$dest/sdk" ] || ln -s ../sdk "$dest/sdk" 2>/dev/null || true
    fi
    # Create compatibility symlink so cargo (which finds ~/.cargo/bin/cargo-build-sbf) resolves sdk sibling
    mkdir -p "$HOME/.cargo/bin"
    ln -sfn "$dest_root/sdk" "$HOME/.cargo/bin/sdk" 2>/dev/null || true
    echo "✅ cargo-build-sbf and SBF SDK installed to $dest_root"
    rm -rf "$tmpdir"; return 0
  else
    echo "⚠️  Prebuilt cargo-build-sbf not found in archive"; rm -rf "$tmpdir"; return 1
  fi
}
if [ -n "$triple" ] && { ! command -v cargo-build-sbf >/dev/null 2>&1 || [ ! -d "$HOME/.local/share/solana/install/active_release/bin/sdk/sbf" ]; }; then
  fetch_cargo_build_sbf || true
fi
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"



echo ""

# Configure Solana CLI defaults for a ready-to-deploy setup
echo "⚙️  Configuring Solana CLI defaults (devnet)..."
solana config set --url https://api.devnet.solana.com >/dev/null 2>&1 || true
solana config set --commitment confirmed >/dev/null 2>&1 || true
echo "✅ Solana CLI configured for devnet deployments"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "🎉 Lili CLI installed successfully!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "To run Lili CLI:"
echo "  lili"
echo ""
echo "Happy building on Solana! 🚀"
echo ""
