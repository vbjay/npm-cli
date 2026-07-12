cmake_minimum_required(VERSION 3.23)
project(node_binary_parser)

set(CMAKE_CXX_STANDARD 14)


include_directories(.)
include_directories(node_modules/node-addon-api)

execute_process(COMMAND node -v OUTPUT_VARIABLE NODE_VERSION)

string(REGEX REPLACE "^v([0-9]+\\.[0-9]+\\.[0-9]+).*$" "\\1" NODE_VERSION_PART ${NODE_VERSION})

IF (WIN32)
    include_directories($ENV{userprofile}/AppData/Local/node-gyp/Cache/${NODE_VERSION_PART}/include/node)
ELSE ()
    include_directories(~/.cache/node-gyp/${NODE_VERSION_PART}/include/node)
ENDIF (WIN32)

add_executable(node_binary_parser
        node_modules/node-addon-api/napi.h
        main.cpp
        main.h)
