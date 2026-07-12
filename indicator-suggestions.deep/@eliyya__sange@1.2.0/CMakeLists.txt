cmake_minimum_required(VERSION 3.10)

project(sange CXX)
set(CMAKE_CXX_STANDARD 17)

# Get Node-API includes from node-addon-api
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
)

# Remove any surrounding quotes from the path
string(REGEX REPLACE "^\"|\"$" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

# Include directories
include_directories(
    ${CMAKE_JS_INC}
    ${NODE_ADDON_API_DIR}
)

# Print include paths for debugging
message(STATUS "CMAKE_JS_INC: ${CMAKE_JS_INC}")
message(STATUS "NODE_ADDON_API_DIR: ${NODE_ADDON_API_DIR}")

# Set debug flags
if("${CMAKE_BUILD_TYPE}" STREQUAL "Debug")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DSANGE_DEBUG -g")
endif()

add_library(sange SHARED
	"src/message.cpp"
	"src/wrapper.cpp"
	"src/player.cpp"
	"src/addon.cpp"
)

target_link_libraries(sange avformat avcodec avutil avfilter uv opus pthread sodium ${CMAKE_JS_LIB})
set_target_properties(sange PROPERTIES PREFIX "" SUFFIX ".node")
