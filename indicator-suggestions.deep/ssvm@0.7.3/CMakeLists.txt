# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.9.4)
project(SSVMJS)

find_program(GIT_CMD git)
execute_process(COMMAND
  ${GIT_CMD} describe --match "*[0-9].[0-9]*" --tag
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE CPACK_PACKAGE_VERSION
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

set(CMAKE_MODULE_PATH ${CMAKE_CURRENT_LIST_DIR}/cmake)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Boost REQUIRED)
find_package(Filesystem REQUIRED Final Experimental)
find_package(Threads REQUIRED)

if(CMAKE_BUILD_TYPE STREQUAL Release OR CMAKE_BUILD_TYPE STREQUAL RelWithDebInfo)
  set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)
endif()
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_ENABLE_EXPORTS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
set(CMAKE_SKIP_RPATH ON)

option(BUILD_TESTS "Generate build targets for the ssvm unit tests." OFF)
option(BUILD_COVERAGE "Generate coverage report. Require BUILD_TESTS." OFF)
option(BUILD_TOOLS "Generate ssvm and ssvmc tools." ON)
option(BUILD_TOOL_SSVM_STATIC "Generate ssvm-static tool" ON)

# Macro for copying directory.
macro(configure_files srcDir destDir)
  message(STATUS "Generating testing input directory ${destDir}")
  make_directory(${destDir})

  file(GLOB templateFiles RELATIVE ${srcDir} ${srcDir}/*)
  foreach(templateFile ${templateFiles})
    set(srcTemplatePath ${srcDir}/${templateFile})
    if(NOT IS_DIRECTORY ${srcTemplatePath})
      configure_file(
        ${srcTemplatePath}
        ${destDir}/${templateFile}
        COPYONLY)
    else()
      configure_files(
        ${srcTemplatePath}
        ${destDir}/${templateFile}
        COPYONLY)
    endif()
  endforeach(templateFile)
endmacro(configure_files)
# End of Macro

add_subdirectory(include)
add_subdirectory(lib)
add_subdirectory(thirdparty)
