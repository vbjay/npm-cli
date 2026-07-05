# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

test:
	@./node_modules/.bin/mocha --reporter spec

.PHONY: test