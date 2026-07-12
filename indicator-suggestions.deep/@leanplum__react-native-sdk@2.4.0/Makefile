# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

####################################################################
#
# Rules used to build and release the SDK.
#
####################################################################

updateVersion:
	sed -i '' -e "s/\"version\": \".*\"/\"version\": \"`cat sdk-version.txt`\"/g" "package.json"

tagCommit:
	git add package.json; git commit -am 'update version'; git tag `cat sdk-version.txt`; git push; git push origin `cat sdk-version.txt`

deploy: updateVersion tagCommit
