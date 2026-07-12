# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

.PHONY: clean check test

ALL:
	#git submodule update --init
	npm i

check:
	npm test

test:
	npm t

clean:
	rm -fr build node_modules
