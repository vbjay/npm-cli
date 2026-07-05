# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

.DEFAULT_GOAL := build

.PHONY: audit
audit:
	@pnpm audit

.PHONY: build
build:
	@pnpm run build

.PHONY: clean
clean:
	@pnpm run clean

.PHONY: install
install:
	@pnpm install

.PHONY: reinstall
reinstall:
	@make clean
	@pnpm run clean:unsafe
	@make install

.PHONY: lint
lint:
	@pnpm run lint

.PHONY: test/integration
test/integration:
	@pnpm run test:integration

.PHONY: test/unit
test/unit:
	@pnpm run test

.PHONY: test
test: test/unit

.PHONY: pnpm/update
pnpm/update:
	@pnpm update

.PHONY: pre-commit/update
pre-commit/update:
	@command -v prek >/dev/null 2>&1 && prek auto-update || pre-commit autoupdate

.PHONY: update
update: pnpm/update pre-commit/update

.PHONY: outdated
outdated:
	@pnpm outdated
