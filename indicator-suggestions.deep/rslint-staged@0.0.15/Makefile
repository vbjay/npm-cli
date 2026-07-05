# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

test:
	pnpm run test

build:
	pnpm run build && pnpm run rename-binary

#  todo change version

publish:
	pnpm publish
