cmake_minimum_required(VERSION 3.1)

set(CMAKE_POSITION_INDEPENDENT_CODE ON)

project(lightgbm_bindings)

# lightgbm library
set(BUILD_STATIC_LIB ON CACHE BOOL "" FORCE)
set(BUILD_CLI OFF CACHE BOOL "" FORCE)
add_subdirectory(dependencies/LightGBM)
include_directories(dependencies/LightGBM/include)

set (CMAKE_CXX_STANDARD 20)

# lightgbm_bindings library
file(GLOB_RECURSE SOURCES "src/*.cc" "src/*.h")
add_library(${PROJECT_NAME} SHARED ${SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC})

# node-addon-api
execute_process(COMMAND node -p "require('node-addon-api').include"
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE NODE_ADDON_API_DIR
        )
string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})

# link lightgbm to lightgbm_bindings
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} _lightgbm)

# set napi version
add_definitions(-DNAPI_VERSION=6)
