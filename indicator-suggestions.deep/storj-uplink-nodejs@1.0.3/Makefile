# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

# =============================================================================
# Makefile for storj-uplink-nodejs
# =============================================================================
#
# Three install methods:
#
#   prebuilt  — Download libuplink + uplink_native.node + headers from GitHub
#               Releases.  No compiler or Go needed.
#               Archive: uplink-nodejs-v<VERSION>-<PLATFORM>.tar.gz
#
#   hybrid    — Download libuplink from GitHub Releases, then compile
#               uplink_native.node locally with node-gyp.
#               Needs: C compiler, Python.  No Go needed.
#
#   source    — Clone storj/uplink-c, build libuplink with Go, then compile
#               uplink_native.node locally with node-gyp.
#               Needs: Go, Git, C compiler, Python.
#
# Auto-detect order (default): prebuilt → hybrid → source
#
# Usage:
#   make install                         # auto-detect
#   make install UPLINK_INSTALL=prebuilt
#   make install UPLINK_INSTALL=hybrid
#   make install UPLINK_INSTALL=source
#
#   npm install storj-uplink-nodejs                          # auto
#   UPLINK_INSTALL=hybrid npm install storj-uplink-nodejs    # hybrid
#   UPLINK_INSTALL=source npm install storj-uplink-nodejs    # source
# =============================================================================

# -----------------------------------------------------------------------------
# OS / platform detection
# -----------------------------------------------------------------------------
ifeq ($(OS),Windows_NT)
    DETECTED_OS   := windows
    PLATFORM      := win32-x64
    LIB_NAME      := libuplink.dll
    LIB_EXT       := .dll
    # Detect MSYS2 / Git Bash on Windows (GitHub Actions)
    ifneq ($(MSYSTEM),)
        USE_POSIX_CMDS := 1
    else ifneq ($(shell echo $$BASH_VERSION 2>/dev/null),)
        USE_POSIX_CMDS := 1
    endif
    ifdef USE_POSIX_CMDS
        MKDIR   = mkdir -p $1
        RM      = rm -f $1
        RMDIR   = rm -rf $1
        CP      = cp -f $1 $2
    else
        WINDOWS_NATIVE := 1
        MKDIR   = if not exist "$(subst /,\,$1)" mkdir "$(subst /,\,$1)"
        RM      = if exist "$(subst /,\,$1)" del /q "$(subst /,\,$1)"
        RMDIR   = if exist "$(subst /,\,$1)" rmdir /s /q "$(subst /,\,$1)"
        CP      = copy /y "$(subst /,\,$1)" "$(subst /,\,$2)"
    endif
else
    UNAME_S := $(shell uname -s)
    UNAME_M := $(shell uname -m)
    ifeq ($(UNAME_S),Darwin)
        DETECTED_OS := darwin
        LIB_NAME    := libuplink.dylib
        LIB_EXT     := .dylib
    else
        DETECTED_OS := linux
        LIB_NAME    := libuplink.so
        LIB_EXT     := .so
    endif
    ifeq ($(UNAME_M),x86_64)
        DETECTED_ARCH := x64
    else
        DETECTED_ARCH := arm64
    endif
    PLATFORM := $(DETECTED_OS)-$(DETECTED_ARCH)
    MKDIR    = mkdir -p $1
    RM       = rm -f $1
    RMDIR    = rm -rf $1
    CP       = cp -f $1 $2
endif

# Derive Go arch from PLATFORM (supports cross-compilation override)
PLATFORM_ARCH := $(lastword $(subst -, ,$(PLATFORM)))
GO_ARCH_x64   := amd64
GO_ARCH_arm64 := arm64
GO_ARCH       := $(GO_ARCH_$(PLATFORM_ARCH))

GO_OS_darwin  := darwin
GO_OS_linux   := linux
GO_OS_windows := windows
GO_OS         := $(GO_OS_$(DETECTED_OS))

# -----------------------------------------------------------------------------
# Directories & file names
# -----------------------------------------------------------------------------
PROJECT_DIR      := $(CURDIR)
PREBUILDS_DIR    := $(PROJECT_DIR)/native/prebuilds
PLATFORM_DIR     := $(PREBUILDS_DIR)/$(PLATFORM)
INCLUDE_DIR      := $(PROJECT_DIR)/native/include
BUILD_DIR        := $(PROJECT_DIR)/build
DIST_DIR         := $(PROJECT_DIR)/dist
DOWNLOAD_DIR     := $(PROJECT_DIR)/.downloads
UPLINK_C_SRC_DIR := $(PROJECT_DIR)/.uplink-c-build

NODE_ADDON       := uplink_native.node

# node-gyp: prefer the local devDependency over any globally installed version
NODE_GYP         := $(PROJECT_DIR)/node_modules/.bin/node-gyp

# uplink-c to clone / build from source
UPLINK_C_REPO    := https://github.com/storj/uplink-c.git

# Build output: libuplink.h is emitted as libuplink.h; we rename to uplink.h
# (binding.gyp and C sources include "uplink.h")
UPLINK_HEADER_SRC := libuplink.h
UPLINK_HEADER_DST := uplink.h

# -----------------------------------------------------------------------------
# GitHub release — single archive per platform
#
#   URL:  https://github.com/<OWNER>/<REPO>/releases/download/v<VER>/<ARCHIVE>
#   File: uplink-nodejs-v<VER>-<PLATFORM>.tar.gz
#
#   Archive contents:
#     libuplink.{dylib,so,dll}
#     uplink_native.node
#     include/uplink.h
#     include/uplink_definitions.h
#     include/uplink_compat.h
# -----------------------------------------------------------------------------
GITHUB_OWNER  ?= shivamkumar99
GITHUB_REPO   ?= storj-uplink-nodejs
VERSION       ?= $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
RELEASE_URL   := https://github.com/$(GITHUB_OWNER)/$(GITHUB_REPO)/releases/download/v$(VERSION)
ARCHIVE_NAME  := uplink-nodejs-v$(VERSION)-$(PLATFORM).tar.gz

# -----------------------------------------------------------------------------
# Verbosity
# -----------------------------------------------------------------------------
VERBOSE ?= 0
ifeq ($(VERBOSE),1)
    Q           =
    CURL_FLAGS  = -L -f --progress-bar
else
    Q           = @
    CURL_FLAGS  = -L -f -s
endif

# -----------------------------------------------------------------------------
# Default goal
# -----------------------------------------------------------------------------
.PHONY: all
all: install

# -----------------------------------------------------------------------------
# Directory helpers
# -----------------------------------------------------------------------------
$(PLATFORM_DIR):
	$(call MKDIR,$(PLATFORM_DIR))

$(INCLUDE_DIR):
	$(call MKDIR,$(INCLUDE_DIR))

$(DOWNLOAD_DIR):
	$(call MKDIR,$(DOWNLOAD_DIR))

# =============================================================================
# .uplinkrc persistence — survives rm -rf node_modules
# =============================================================================
UPLINKRC         := $(PROJECT_DIR)/.uplinkrc
VALID_METHODS    := prebuilt hybrid source skip

# Read saved method from .uplinkrc (empty string if missing/invalid)
SAVED_METHOD     := $(strip $(shell cat "$(UPLINKRC)" 2>/dev/null))
SAVED_IS_VALID   := $(filter $(SAVED_METHOD),$(VALID_METHODS))

# Resolve effective method: env > .uplinkrc > auto
ifdef UPLINK_INSTALL
  EFFECTIVE_METHOD := $(UPLINK_INSTALL)
  METHOD_SOURCE    := environment
else ifdef SAVED_IS_VALID
  EFFECTIVE_METHOD := $(SAVED_METHOD)
  METHOD_SOURCE    := .uplinkrc
else ifneq ($(SAVED_METHOD),)
  # .uplinkrc exists but contains invalid value
  EFFECTIVE_METHOD := auto
  METHOD_SOURCE    := auto (invalid .uplinkrc value "$(SAVED_METHOD)" ignored)
else
  EFFECTIVE_METHOD := auto
  METHOD_SOURCE    := auto
endif

# =============================================================================
# INSTALL ENTRY POINT
# =============================================================================
.PHONY: install
install:
	@echo ""
	@echo "========================================================"
	@echo "  storj-uplink-nodejs — Native Module Installer"
	@echo "========================================================"
	@echo "  Version  : $(VERSION)"
	@echo "  Platform : $(PLATFORM)"
	@echo "  Method   : $(EFFECTIVE_METHOD)"
ifeq ($(METHOD_SOURCE),environment)
	@echo "  Source   : environment variable UPLINK_INSTALL"
else ifeq ($(METHOD_SOURCE),.uplinkrc)
	@echo "  Source   : $(UPLINKRC)"
else
	@echo "  Source   : $(METHOD_SOURCE)"
endif
	@echo "========================================================"
	@echo ""
ifeq ($(EFFECTIVE_METHOD),skip)
	@echo "[storj-uplink] Method: skip — skipping native build"
	@echo "$(EFFECTIVE_METHOD)" > "$(UPLINKRC)"
	@echo "Saved install method \"$(EFFECTIVE_METHOD)\" to $(UPLINKRC)"
else ifeq ($(EFFECTIVE_METHOD),prebuilt)
	@$(MAKE) install-prebuilt
	@echo "$(EFFECTIVE_METHOD)" > "$(UPLINKRC)"
	@echo "Saved install method \"$(EFFECTIVE_METHOD)\" to $(UPLINKRC)"
else ifeq ($(EFFECTIVE_METHOD),hybrid)
	@$(MAKE) install-hybrid
	@echo "$(EFFECTIVE_METHOD)" > "$(UPLINKRC)"
	@echo "Saved install method \"$(EFFECTIVE_METHOD)\" to $(UPLINKRC)"
else ifeq ($(EFFECTIVE_METHOD),source)
	@$(MAKE) install-source
	@echo "$(EFFECTIVE_METHOD)" > "$(UPLINKRC)"
	@echo "Saved install method \"$(EFFECTIVE_METHOD)\" to $(UPLINKRC)"
else
	@$(MAKE) install-auto
endif

# =============================================================================
# METHOD 1 — PREBUILT
# Download libuplink + uplink_native.node + headers from GitHub Releases.
# No compiler or Go needed.
# =============================================================================
.PHONY: install-prebuilt
install-prebuilt: check-curl $(PLATFORM_DIR) $(INCLUDE_DIR) $(DOWNLOAD_DIR)
	@echo ""
	@echo "--------------------------------------------------------"
	@echo "  METHOD: prebuilt (download lib + addon from GitHub)"
	@echo "--------------------------------------------------------"
	@echo "  Archive : $(RELEASE_URL)/$(ARCHIVE_NAME)"
	@echo "  Dest    : $(PLATFORM_DIR)"
	@echo ""
	$(Q)echo "Downloading $(ARCHIVE_NAME) ..."
	$(Q)curl $(CURL_FLAGS) \
		"$(RELEASE_URL)/$(ARCHIVE_NAME)" \
		-o "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)" \
		|| (echo ""; \
		    echo "ERROR: Download failed."; \
		    echo "  URL: $(RELEASE_URL)/$(ARCHIVE_NAME)"; \
		    echo "  Check that v$(VERSION) has a release for $(PLATFORM)."; \
		    exit 1)
	$(Q)echo "Extracting archive ..."
	$(Q)tar -xzf "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)" -C "$(PLATFORM_DIR)"
	$(Q)echo "Installing headers ..."
	$(Q)if [ -d "$(PLATFORM_DIR)/include" ]; then \
		cp -f "$(PLATFORM_DIR)/include"/*.h "$(INCLUDE_DIR)/" ; \
		rm -rf "$(PLATFORM_DIR)/include" ; \
		echo "  Headers  -> $(INCLUDE_DIR)/" ; \
	else \
		echo "WARNING: no include/ in archive — headers not installed" ; \
	fi
	$(Q)rm -f "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)"
	@$(MAKE) _verify
	@echo ""
	@echo "========================================================"
	@echo "  SUCCESS: prebuilt install complete"
	@echo "========================================================"
	@echo ""

# =============================================================================
# METHOD 2 — HYBRID
# Download libuplink + headers from GitHub Releases, compile addon locally.
# Needs: C compiler, Python.  No Go.
# =============================================================================
.PHONY: install-hybrid
install-hybrid: check-curl check-compiler check-python $(PLATFORM_DIR) $(INCLUDE_DIR) $(DOWNLOAD_DIR)
	@echo ""
	@echo "--------------------------------------------------------"
	@echo "  METHOD: hybrid (download lib, compile addon locally)"
	@echo "--------------------------------------------------------"
	@echo "  Archive : $(RELEASE_URL)/$(ARCHIVE_NAME)"
	@echo "  Dest    : $(PLATFORM_DIR)"
	@echo ""
	$(Q)echo "Downloading $(ARCHIVE_NAME) ..."
	$(Q)curl $(CURL_FLAGS) \
		"$(RELEASE_URL)/$(ARCHIVE_NAME)" \
		-o "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)" \
		|| (echo ""; \
		    echo "ERROR: Download failed."; \
		    echo "  URL: $(RELEASE_URL)/$(ARCHIVE_NAME)"; \
		    exit 1)
	$(Q)echo "Extracting library and headers ..."
	$(Q)TMP="$(DOWNLOAD_DIR)/hybrid-extract" ; \
	rm -rf "$$TMP" && mkdir -p "$$TMP" ; \
	tar -xzf "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)" -C "$$TMP" ; \
	cp -f "$$TMP/$(LIB_NAME)" "$(PLATFORM_DIR)/$(LIB_NAME)" ; \
	echo "  Library  -> $(PLATFORM_DIR)/$(LIB_NAME)" ; \
	if [ -d "$$TMP/include" ]; then \
		cp -f "$$TMP/include"/*.h "$(INCLUDE_DIR)/" ; \
		echo "  Headers  -> $(INCLUDE_DIR)/" ; \
	else \
		echo "WARNING: no include/ in archive — headers not found" ; \
	fi ; \
	rm -rf "$$TMP"
	$(Q)rm -f "$(DOWNLOAD_DIR)/$(ARCHIVE_NAME)"
	$(Q)if [ ! -f "$(INCLUDE_DIR)/$(UPLINK_HEADER_DST)" ]; then \
		echo "ERROR: $(INCLUDE_DIR)/$(UPLINK_HEADER_DST) not found — cannot compile addon." ; \
		exit 1 ; \
	fi
	$(Q)echo ""
	$(Q)echo "Compiling uplink_native.node ..."
	$(Q)$(NODE_GYP) rebuild
	$(Q)cp -f "$(BUILD_DIR)/Release/$(NODE_ADDON)" "$(PLATFORM_DIR)/$(NODE_ADDON)"
	$(Q)echo "  Addon    -> $(PLATFORM_DIR)/$(NODE_ADDON)"
	@$(MAKE) _verify
	@echo ""
	@echo "========================================================"
	@echo "  SUCCESS: hybrid install complete"
	@echo "========================================================"
	@echo ""

# =============================================================================
# METHOD 3 — SOURCE
# Clone storj/uplink-c, build libuplink with Go, compile addon with node-gyp.
# Needs: Go, Git, C compiler, Python.
# =============================================================================
.PHONY: install-source
install-source: check-go check-git check-compiler check-python $(PLATFORM_DIR) $(INCLUDE_DIR)
	@echo ""
	@echo "--------------------------------------------------------"
	@echo "  METHOD: source (build libuplink + addon from source)"
	@echo "--------------------------------------------------------"
	@echo "  uplink-c : $(UPLINK_C_SRC_DIR)"
	@echo "  Dest     : $(PLATFORM_DIR)"
	@echo ""
	$(Q)echo "[1/3] Cloning storj/uplink-c ..."
	$(Q)if [ -d "$(UPLINK_C_SRC_DIR)/.git" ]; then \
		echo "  Already cloned — pulling latest" ; \
		cd "$(UPLINK_C_SRC_DIR)" && git pull --ff-only origin main 2>/dev/null || true ; \
	else \
		git clone --depth 1 "$(UPLINK_C_REPO)" "$(UPLINK_C_SRC_DIR)" ; \
	fi
	$(Q)echo ""
	$(Q)echo "[2/3] Building libuplink (Go) ..."
	$(Q)cd "$(UPLINK_C_SRC_DIR)" && \
		CGO_ENABLED=1 GOOS=$(GO_OS) GOARCH=$(GO_ARCH) \
		go build -buildmode=c-shared -o "$(LIB_NAME)" .
	$(Q)cp -f "$(UPLINK_C_SRC_DIR)/$(LIB_NAME)"            "$(PLATFORM_DIR)/$(LIB_NAME)"
	$(Q)cp -f "$(UPLINK_C_SRC_DIR)/$(UPLINK_HEADER_SRC)"   "$(INCLUDE_DIR)/$(UPLINK_HEADER_DST)"
	$(Q)if [ -f "$(UPLINK_C_SRC_DIR)/uplink_definitions.h" ]; then \
		cp -f "$(UPLINK_C_SRC_DIR)/uplink_definitions.h" "$(INCLUDE_DIR)/uplink_definitions.h" ; fi
	$(Q)if [ -f "$(UPLINK_C_SRC_DIR)/uplink_compat.h" ]; then \
		cp -f "$(UPLINK_C_SRC_DIR)/uplink_compat.h"      "$(INCLUDE_DIR)/uplink_compat.h" ; fi
	$(Q)echo "  Library  -> $(PLATFORM_DIR)/$(LIB_NAME)"
	$(Q)echo "  Headers  -> $(INCLUDE_DIR)/"
	@$(MAKE) fix-header-compat
	@$(MAKE) generate-import-lib
	$(Q)echo ""
	$(Q)echo "[3/3] Compiling uplink_native.node ..."
	$(Q)$(NODE_GYP) rebuild
	$(Q)cp -f "$(BUILD_DIR)/Release/$(NODE_ADDON)" "$(PLATFORM_DIR)/$(NODE_ADDON)"
	$(Q)echo "  Addon    -> $(PLATFORM_DIR)/$(NODE_ADDON)"
	@$(MAKE) _verify
	@echo ""
	@echo "========================================================"
	@echo "  SUCCESS: source install complete"
	@echo "========================================================"
	@echo ""

# =============================================================================
# AUTO-DETECT: prebuilt → hybrid → source
# =============================================================================
.PHONY: install-auto
install-auto:
	@echo "[storj-uplink] Step 1/3: trying prebuilt ..."
	@$(MAKE) install-prebuilt 2>&1 \
	&& echo "[storj-uplink] prebuilt succeeded." \
	|| ( \
		echo "[storj-uplink] prebuilt failed — trying hybrid ..." ; \
		$(MAKE) install-hybrid 2>&1 \
		&& echo "[storj-uplink] hybrid succeeded." \
		|| ( \
			echo "[storj-uplink] hybrid failed — trying source ..." ; \
			$(MAKE) install-source \
		) \
	)

# =============================================================================
# MSVC compatibility patches for upstream headers
# (uplink_definitions.h: empty structs → C2016; uplink_compat.h: #warning → C1021)
# Patches are idempotent — safe to call multiple times.
# =============================================================================
DEFS_HEADER   := $(INCLUDE_DIR)/uplink_definitions.h
COMPAT_HEADER := $(INCLUDE_DIR)/uplink_compat.h

.PHONY: fix-header-compat
fix-header-compat:
	@if [ -f "$(DEFS_HEADER)" ]; then \
		if grep -q '_MSC_VER' "$(DEFS_HEADER)"; then \
			echo "  uplink_definitions.h: MSVC compat already applied"; \
		else \
			echo "  Patching uplink_definitions.h for MSVC empty-struct compat ..."; \
			node -e " \
				const fs = require('fs'); \
				const f = process.argv[1]; \
				let src = fs.readFileSync(f, 'utf8'); \
				const marker = '// we need to suppress'; \
				const idx = src.indexOf(marker); \
				if (idx === -1) { console.log('  No empty structs found — skipping'); process.exit(0); } \
				const before = src.slice(0, idx); \
				const msvc = [ \
					'#ifdef _MSC_VER', \
					'', \
					'typedef struct UplinkMoveObjectOptions { char _reserved; } UplinkMoveObjectOptions;', \
					'typedef struct UplinkUploadObjectMetadataOptions { char _reserved; } UplinkUploadObjectMetadataOptions;', \
					'typedef struct UplinkCopyObjectOptions { char _reserved; } UplinkCopyObjectOptions;', \
					'', \
					'#else /* GCC / Clang */', \
					'' \
				].join('\n'); \
				const after = src.slice(idx); \
				fs.writeFileSync(f, before + msvc + after + '\n#endif /* _MSC_VER */\n'); \
				console.log('  uplink_definitions.h patched'); \
			" "$(DEFS_HEADER)"; \
		fi; \
	fi
	@if [ -f "$(COMPAT_HEADER)" ]; then \
		if grep -q '_MSC_VER' "$(COMPAT_HEADER)"; then \
			echo "  uplink_compat.h: MSVC compat already applied"; \
		else \
			echo "  Patching uplink_compat.h for MSVC #warning compat ..."; \
			node -e " \
				const fs = require('fs'); \
				const f = process.argv[1]; \
				let src = fs.readFileSync(f, 'utf8'); \
				const warningRe = /#warning\s*([\s\S]*?)(?=\n\n|\n#)/; \
				const m = warningRe.exec(src); \
				if (!m) { console.log('  No #warning found — skipping'); process.exit(0); } \
				let msg = m[1].replace(/\\\n\s*/g, ' ').trim(); \
				if (msg.startsWith('\"') && msg.endsWith('\"')) msg = msg.slice(1, -1); \
				const replacement = '#ifdef _MSC_VER\n#pragma message(' + JSON.stringify(msg) + ')\n#else\n' + m[0] + '\n#endif /* _MSC_VER */'; \
				fs.writeFileSync(f, src.replace(m[0], replacement)); \
				console.log('  uplink_compat.h patched'); \
			" "$(COMPAT_HEADER)"; \
		fi; \
	fi

# Generate Windows import library (.lib / .def) from the DLL.
# node-gyp on Windows needs uplink.lib to link against libuplink.dll.
DEF_FILE := $(PLATFORM_DIR)/uplink.def
LIB_FILE := $(PLATFORM_DIR)/uplink.lib
.PHONY: generate-import-lib
generate-import-lib:
ifeq ($(DETECTED_OS),windows)
	@echo "  Generating Windows import library (uplink.lib) ..."
	$(Q)node "$(PROJECT_DIR)/scripts/gen-def.js" \
		"$(INCLUDE_DIR)/$(UPLINK_HEADER_DST)" "$(DEF_FILE)"
	$(Q)if command -v lib.exe > /dev/null 2>&1; then \
		MSYS_NO_PATHCONV=1 lib.exe /def:"$(DEF_FILE)" /out:"$(LIB_FILE)" \
			/machine:x64 /nologo ; \
	elif command -v dlltool > /dev/null 2>&1; then \
		dlltool -d "$(DEF_FILE)" -l "$(LIB_FILE)" -D libuplink.dll ; \
	else \
		echo "ERROR: Neither lib.exe nor dlltool found." ; exit 1 ; \
	fi
	$(Q)echo "  uplink.lib -> $(LIB_FILE)"
endif

# =============================================================================
# VERIFICATION
# =============================================================================
.PHONY: _verify
_verify:
	$(Q)echo ""
	$(Q)echo "Verifying installation ..."
	$(Q)if [ -f "$(PLATFORM_DIR)/$(LIB_NAME)" ]; then \
		echo "  ✓ $(LIB_NAME)" ; \
	else \
		echo "  NOT FOUND: $(LIB_NAME) not found in $(PLATFORM_DIR)/" ; exit 1 ; \
	fi
	$(Q)if [ -f "$(PLATFORM_DIR)/$(NODE_ADDON)" ]; then \
		echo "  ✓ $(NODE_ADDON)" ; \
	else \
		echo "  NOT FOUND: $(NODE_ADDON) not found in $(PLATFORM_DIR)/" ; exit 1 ; \
	fi
	$(Q)echo "Verification passed!"

.PHONY: verify
verify: _verify

.PHONY: verify-full
verify-full: _verify

# =============================================================================
# PREREQUISITE CHECKS
# =============================================================================
.PHONY: check-curl
check-curl:
	$(Q)which curl > /dev/null 2>&1 \
		|| (echo "ERROR: curl not found. Install curl and retry." && exit 1)

.PHONY: check-go
check-go:
	$(Q)which go > /dev/null 2>&1 \
		|| (echo "ERROR: Go not found. Install from https://golang.org/dl/" && exit 1)
	$(Q)echo "  go: $$(go version | awk '{print $$3}')"

.PHONY: check-git
check-git:
	$(Q)which git > /dev/null 2>&1 \
		|| (echo "ERROR: git not found." && exit 1)

.PHONY: check-compiler
check-compiler:
	$(Q)(which cc > /dev/null 2>&1 || which gcc > /dev/null 2>&1 || which clang > /dev/null 2>&1) \
		|| (echo "ERROR: No C compiler found. Install build-essential (Linux) or Xcode CLT (macOS)." && exit 1)

.PHONY: check-python
check-python:
	$(Q)(which python3 > /dev/null 2>&1 || which python > /dev/null 2>&1) \
		|| (echo "ERROR: Python not found (required by node-gyp)." && exit 1)

.PHONY: check-node
check-node:
	$(Q)which node > /dev/null 2>&1 \
		|| (echo "ERROR: Node.js not found. Install from https://nodejs.org/" && exit 1)
	@echo "  Node.js: $$(node --version)"

.PHONY: check-npm
check-npm:
	$(Q)which npm > /dev/null 2>&1 \
		|| (echo "ERROR: npm not found. Install Node.js from https://nodejs.org/" && exit 1)
	@echo "  npm: $$(npm --version)"

.PHONY: check-source-prereqs
check-source-prereqs: check-node check-go check-git check-compiler check-python
	@echo "All prerequisites for source build satisfied"

.PHONY: check-hybrid-prereqs
check-hybrid-prereqs: check-node check-curl check-compiler check-python
	@echo "All prerequisites for hybrid build satisfied"

.PHONY: check-prebuilt-prereqs
check-prebuilt-prereqs: check-node check-curl
	@echo "All prerequisites for prebuilt download satisfied"

# =============================================================================
# BUILD HELPERS (used by CI / local development)
# =============================================================================

# Build TypeScript
.PHONY: build-ts
build-ts:
	npm run build:ts

# Build native addon only (requires headers + lib already in place)
.PHONY: build-native
build-native:
	$(NODE_GYP) rebuild

# Build TypeScript + native addon
.PHONY: build
build: build-ts build-native

# =============================================================================
# CLEAN
# =============================================================================
.PHONY: clean
clean:
	$(call RMDIR,$(BUILD_DIR))
	$(call RMDIR,$(DIST_DIR))
	@echo "Cleaned build/ and dist/"

.PHONY: clean-prebuilds
clean-prebuilds:
	$(call RMDIR,$(PREBUILDS_DIR))
	@echo "Cleaned prebuilds/"

.PHONY: clean-downloads
clean-downloads:
	$(call RMDIR,$(DOWNLOAD_DIR))
	@echo "Cleaned .downloads/"

.PHONY: clean-all
clean-all: clean clean-prebuilds clean-downloads
	$(call RMDIR,$(INCLUDE_DIR))
	$(call RMDIR,$(UPLINK_C_SRC_DIR))
	@echo "Cleaned all generated directories."

# =============================================================================
# MISC
# =============================================================================
.PHONY: test
test:
	npm test

.PHONY: lint
lint:
	npm run lint

.PHONY: info
info:
	@echo "Platform  : $(PLATFORM)"
	@echo "Library   : $(LIB_NAME)"
	@echo "Version   : $(VERSION)"
	@echo "Release   : $(RELEASE_URL)/$(ARCHIVE_NAME)"
	@echo "Prebuilds : $(PLATFORM_DIR)"
	@echo "Headers   : $(INCLUDE_DIR)"

.PHONY: help
help:
	@echo ""
	@echo "storj-uplink-nodejs — Makefile"
	@echo ""
	@echo "INSTALLATION OPTIONS:"
	@echo "  make install                         auto-detect (prebuilt → hybrid → source)"
	@echo "  make install UPLINK_INSTALL=prebuilt download lib + addon from GitHub"
	@echo "  make install UPLINK_INSTALL=hybrid   download lib, compile addon locally"
	@echo "  make install UPLINK_INSTALL=source   build everything from source"
	@echo "  make install UPLINK_INSTALL=skip     skip native build entirely"
	@echo ""
	@echo "  Via npm:"
	@echo "    npm install storj-uplink-nodejs"
	@echo "    UPLINK_INSTALL=hybrid npm install storj-uplink-nodejs"
	@echo ""
	@echo "BUILD TARGETS:"
	@echo "  make build          Build TypeScript + native addon"
	@echo "  make build-ts       Build TypeScript only"
	@echo "  make build-native   Build native addon only"
	@echo ""
	@echo "DOWNLOAD TARGETS:"
	@echo "  make install-prebuilt  Download lib + addon from GitHub Releases"
	@echo "  make install-hybrid    Download lib, compile addon locally"
	@echo "  make install-source    Build everything from source"
	@echo ""
	@echo "TEST & VERIFY:"
	@echo "  make test           Run test suite"
	@echo "  make lint           Run linter"
	@echo "  make verify         Verify lib + addon are in place"
	@echo "  make verify-full    Same as verify (checks both files)"
	@echo ""
	@echo "CLEAN:"
	@echo "  make clean            Remove build/ and dist/"
	@echo "  make clean-prebuilds  Remove native/prebuilds/"
	@echo "  make clean-downloads  Remove .downloads/"
	@echo "  make clean-all        Remove all generated dirs"
	@echo ""
	@echo "Variables:"
	@echo "  UPLINK_INSTALL   prebuilt | hybrid | source | skip  (default: auto)"
	@echo "  VERBOSE=1        Show all commands"
	@echo "  PLATFORM         Override platform (e.g. darwin-x64)"
	@echo "  GITHUB_OWNER     $(GITHUB_OWNER)"
	@echo "  GITHUB_REPO      $(GITHUB_REPO)"
	@echo ""
