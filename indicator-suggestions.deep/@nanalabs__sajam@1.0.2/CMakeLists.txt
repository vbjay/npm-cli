cmake_minimum_required(VERSION 3.10)
project(node-sajam)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Find Node Addon API
execute_process(COMMAND node -p "require('node-addon-api').include.replace(/\\\"/g, '')"
                OUTPUT_VARIABLE NODE_ADDON_API_DIR
                OUTPUT_STRIP_TRAILING_WHITESPACE)

# Include the sajam library source
set(SAJAM_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/deps/sajam)

add_subdirectory(${SAJAM_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/sajam_build EXCLUDE_FROM_ALL)

add_library(${PROJECT_NAME} SHARED src/binding.cpp)

target_include_directories(${PROJECT_NAME} PRIVATE 
    ${NODE_ADDON_API_DIR}
    ${CMAKE_JS_INC}
    ${SAJAM_ROOT}/include
)

target_link_libraries(${PROJECT_NAME} PRIVATE 
    sajam
    ${CMAKE_JS_LIB}
)

set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
