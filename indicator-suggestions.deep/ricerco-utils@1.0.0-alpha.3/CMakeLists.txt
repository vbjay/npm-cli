cmake_minimum_required(VERSION 3.10)

project ("ricerco-utils")

## Downloads the neccessary boost libs before building
#set(BOOST_URL "https://drive.google.com/uc?export=download&id=1aDLqk2E9p73HpM7v0NKJiuzUaRmfddqn")
#set(BOOST_DOWNLOAD_PATH "${CMAKE_SOURCE_DIR}/vendor/boost_lib.zip")
#if (NOT EXISTS "${BOOST_DOWNLOAD_PATH}")
#    file(DOWNLOAD "${BOOST_URL}" "${BOOST_DOWNLOAD_PATH}")
#endif()

add_definitions(-DNAPI_VERSION=3)

execute_process(COMMAND node -p "require('node-addon-api').include"
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE NODE_ADDON_API_DIR)
string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

set(PROJ_INCL "${CMAKE_SOURCE_DIR}/include/")
#set(BOOST_INCL "${CMAKE_SOURCE_DIR}/vendor/boost/")
set(CEREAL_INCL "${CMAKE_SOURCE_DIR}/vendor/cereal/")
set(NLOHMANN_INCL "${CMAKE_SOURCE_DIR}/vendor/nlohmann/")

include_directories(
    ${CMAKE_JS_INC} 
    ${NODE_ADDON_API_DIR} 
    ${PROJ_INCL}
    #${BOOST_INCL} 
    ${CEREAL_INCL} 
    ${NLOHMANN_INCL})

file(GLOB_RECURSE SOURCE_FILES "src/*.cc")

add_library("ricerco-utils" SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties("ricerco-utils" PROPERTIES PREFIX "" SUFFIX ".node")

message(STATUS "*************************************************************")
message(STATUS "*   THE SELECTED RUNTIME TO BUILD IS: ${NODE_RUNTIME}")
message(STATUS "*   THE SELECTED RUNTIME VERSION IS: ${NODE_RUNTIMEVERSION}")
message(STATUS "*   THE SELECTED ARCHITECTURE IS: ${NODE_ARCH}")
message(STATUS "*************************************************************")
message(STATUS "*************************************************************")

add_subdirectory(${CMAKE_SOURCE_DIR}/vendor/nativefiledialog-extended)
target_link_libraries("ricerco-utils" PRIVATE ${CMAKE_JS_LIB} nfd ole32.lib uuid.lib)

## Copies the default directory to the lib folder
add_custom_command(
    TARGET "ricerco-utils"
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_SOURCE_DIR}/default/"
    "${CMAKE_BINARY_DIR}/Release/default/")

# Extract Boost libraries before building
#if (WIN32)
#    add_custom_command(
#        TARGET "ricerco-utils"
#        PRE_BUILD
#        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}/vendor/"
#        COMMAND powershell -ExecutionPolicy Bypass -File "../tools/boost/download.ps1"
#        DEPENDS "${BOOST_DOWNLOAD_PATH}")
#endif (WIN32)