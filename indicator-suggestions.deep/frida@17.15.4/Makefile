# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

PYTHON ?= $(shell which python3 >/dev/null && echo python3 || echo python)

all $(MAKECMDGOALS):
	@$(PYTHON) \
		-c "import sys; sys.path.insert(0, sys.argv[1]); from releng.meson_make import main; main()" \
		"$(shell pwd)" \
		./build \
		$(MAKECMDGOALS)

git-submodules:
	@if [ ! -f releng/meson/meson.py ]; then \
		git submodule update --init --recursive --depth 1; \
	fi
-include git-submodules

.PHONY: all $(MAKECMDGOALS)
