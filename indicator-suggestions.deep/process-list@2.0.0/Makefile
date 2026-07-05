# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

TOPLEVEL ?= $(dir $(lastword $(MAKEFILE_LIST)))
CPPLINT ?= $(TOPLEVEL)/cpplint.py
PYTHON ?= python

LINT_SOURCES = \
	src/main.cpp \
	src/snapshot.cpp \
	src/snapshot.h \
	src/tasklist.h \
	src/win/tasklist.cpp \
	src/unix/tasklist.cpp

.PHONY: lint

lint:
	cd $(TOPLEVEL) && $(PYTHON) $(CPPLINT) $(LINT_SOURCES)
