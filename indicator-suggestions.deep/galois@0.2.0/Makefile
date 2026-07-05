# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

NODE_GYP := node-gyp

TEST_DIR := ./test

all: build

build:
	${NODE_GYP} rebuild

check:
	make -C ${TEST_DIR} check

clean:
	${NODE_GYP} clean

.PHONY: build check clean
