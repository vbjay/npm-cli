# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

TESTS = test/*.js

all: test

build: clean compile

compile:
	npm install .
	npm run install

test: build
	@./node_modules/.bin/jest \
		$(TESTS)

clean:
	rm -Rf lib/bindings/


.PHONY: clean test build
