# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

release:
	rm -rf release
	rm -rf bin
	mkdir -p release
	cp -r ../release ./
	cp ../README.md README.md
	npm publish
.PHONY: release