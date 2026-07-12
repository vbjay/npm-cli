# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

makelibs: bloom clean

bloom:
	$(MAKE) -C ./src
	cp ./src/build/default/bloomfilter.node .
	
clean:
	rm -rf ./src/build ./src/.lock-wscript
	
