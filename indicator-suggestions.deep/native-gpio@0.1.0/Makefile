# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

MOCHA 	 = node_modules/.bin/mocha
NODE_GYP = node_modules/.bin/node-gyp

MOCHA_FLAGS = \
		--reporter spec

install: build

build:
	$(NODE_GYP) configure build

clean:
	@rm -rf ./build src/*.o

test: test-src

test-src:
	$(MOCHA) $(MOCHA_FLAGS) \
		test/src/gpio

.PHONY: build test
