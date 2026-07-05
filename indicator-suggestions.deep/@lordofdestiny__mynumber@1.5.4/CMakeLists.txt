cmake_minimum_required(VERSION 3.20)

get_filename_component(MYNUMBER_CMAKE_DIR "${CMAKE_CURRENT_LIST_DIR}" ABSOLUTE)
if(CMAKE_SOURCE_DIR STREQUAL MYNUMBER_CMAKE_DIR)
  set(MYNUMBER_ROOT "${MYNUMBER_CMAKE_DIR}")
else()
  set(MYNUMBER_ROOT "${CMAKE_SOURCE_DIR}")
endif()

file(READ "${MYNUMBER_ROOT}/packaging/project.json" MYNUMBER_PROJECT_JSON)
string(JSON MYNUMBER_PROJECT_VERSION GET ${MYNUMBER_PROJECT_JSON} version)

if(CMAKE_SOURCE_DIR STREQUAL MYNUMBER_CMAKE_DIR)
  project(mynumber VERSION ${MYNUMBER_PROJECT_VERSION} LANGUAGES CXX)
endif()

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
include(GenerateExportHeader)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

if(MSVC)
  if(NOT DEFINED CMAKE_MSVC_RUNTIME_LIBRARY)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "MSVC runtime library" FORCE)
  endif()
endif()

if(APPLE)
  set(CMAKE_MACOSX_RPATH ON)
endif()

set(CMAKE_INSTALL_RPATH "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}")
set(CMAKE_INSTALL_RPATH_USE_LINK_PATH TRUE)

set(MYNUMBER_SOURCES
  ${MYNUMBER_ROOT}/src/impl/Combination.cpp
  ${MYNUMBER_ROOT}/src/impl/Operator.cpp
  ${MYNUMBER_ROOT}/src/impl/StateValue.cpp
  ${MYNUMBER_ROOT}/src/api/Combination.cpp
  ${MYNUMBER_ROOT}/src/api/Solution.cpp
)

add_library(mynumber_static STATIC ${MYNUMBER_SOURCES})
add_library(mynumber_shared SHARED ${MYNUMBER_SOURCES})

if(MSVC)
  set(MYNUMBER_COMPILE_OPTIONS /W4 /WX)
  set(MYNUMBER_RELEASE_COMPILE_OPTIONS /O2)
else()
  set(MYNUMBER_COMPILE_OPTIONS -Wall -Wextra -Werror)
  set(MYNUMBER_RELEASE_COMPILE_OPTIONS -O3)
endif()

target_compile_options(mynumber_static PRIVATE ${MYNUMBER_COMPILE_OPTIONS} $<$<CONFIG:Release>:${MYNUMBER_RELEASE_COMPILE_OPTIONS}>)
target_compile_options(mynumber_shared PRIVATE ${MYNUMBER_COMPILE_OPTIONS} $<$<CONFIG:Release>:${MYNUMBER_RELEASE_COMPILE_OPTIONS}>)

set(MYNUMBER_EXPORT_HEADER "${CMAKE_CURRENT_BINARY_DIR}/include/mynumber/Export.hpp")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/include/mynumber")

generate_export_header(mynumber_shared
  EXPORT_MACRO_NAME EXPORT_API
  STATIC_DEFINE MYNUMBER_BUILT_AS_STATIC
  EXPORT_FILE_NAME include/mynumber/Export.hpp
)

set(MYNUMBER_PUBLIC_INCLUDES
  $<BUILD_INTERFACE:${CMAKE_CURRENT_BINARY_DIR}/include>
  $<BUILD_INTERFACE:${MYNUMBER_ROOT}/include>
  $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)

target_include_directories(mynumber_static PUBLIC ${MYNUMBER_PUBLIC_INCLUDES})
target_include_directories(mynumber_shared PUBLIC ${MYNUMBER_PUBLIC_INCLUDES})
set(MYNUMBER_PRIVATE_INCLUDES
  $<BUILD_INTERFACE:${MYNUMBER_ROOT}/src>
)
target_include_directories(mynumber_static PRIVATE ${MYNUMBER_PRIVATE_INCLUDES})
target_include_directories(mynumber_shared PRIVATE ${MYNUMBER_PRIVATE_INCLUDES})
target_compile_definitions(mynumber_static PUBLIC MYNUMBER_BUILT_AS_STATIC)

set_target_properties(mynumber_static mynumber_shared PROPERTIES
  OUTPUT_NAME mynumber
)

set_target_properties(mynumber_shared PROPERTIES
  BUILD_WITH_INSTALL_RPATH FALSE
)

if(WIN32)
  set_target_properties(mynumber_shared PROPERTIES
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
  )
endif()

if(APPLE)
  set_target_properties(mynumber_shared PROPERTIES
    INSTALL_NAME_DIR "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}"
    INSTALL_RPATH "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}"
  )
elseif(UNIX)
  set_target_properties(mynumber_shared PROPERTIES
    INSTALL_RPATH "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}"
  )
endif()

add_custom_target(verify_native_artifacts DEPENDS mynumber_shared mynumber_static)
if(WIN32)
  add_custom_command(TARGET verify_native_artifacts POST_BUILD
    COMMAND ${CMAKE_COMMAND}
      -DVERIFY_FILE=$<TARGET_FILE:mynumber_shared>
      -DVERIFY_EXT_EXPECTED=.dll
      -P "${MYNUMBER_CMAKE_DIR}/cmake/verify-native-artifact.cmake"
    COMMAND ${CMAKE_COMMAND}
      -DVERIFY_FILE=$<TARGET_LINKER_FILE:mynumber_static>
      -DVERIFY_EXT_EXPECTED=.lib
      -P "${MYNUMBER_CMAKE_DIR}/cmake/verify-native-artifact.cmake"
    VERBATIM
  )
elseif(APPLE)
  add_custom_command(TARGET verify_native_artifacts POST_BUILD
    COMMAND ${CMAKE_COMMAND}
      -DVERIFY_FILE=$<TARGET_FILE:mynumber_shared>
      -DVERIFY_EXT_EXPECTED=.dylib
      -P "${MYNUMBER_CMAKE_DIR}/cmake/verify-native-artifact.cmake"
    VERBATIM
  )
else()
  add_custom_command(TARGET verify_native_artifacts POST_BUILD
    COMMAND ${CMAKE_COMMAND}
      -DVERIFY_FILE=$<TARGET_FILE:mynumber_shared>
      -DVERIFY_EXT_EXPECTED=.so
      -P "${MYNUMBER_CMAKE_DIR}/cmake/verify-native-artifact.cmake"
    VERBATIM
  )
endif()

add_library(mynumber::mynumber_static ALIAS mynumber_static)
add_library(mynumber::mynumber_shared ALIAS mynumber_shared)

if(WIN32)
set(NATIVE_LIB_PATH "native-lib/")
file(REAL_PATH ${NATIVE_LIB_PATH} ABSOLUTE_NATIVE_LIB_PATH)

add_custom_command(
    TARGET mynumber_static 
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${ABSOLUTE_NATIVE_LIB_PATH}"
    COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:mynumber_static> "${ABSOLUTE_NATIVE_LIB_PATH}"
    COMMENT "Copying build artifact to destination..."
    VERBATIM
)
endif()

option(MYNUMBER_BUILD_CLI "Build CLI executable" ON)

set(MYNUMBER_INSTALL_TARGETS mynumber_static mynumber_shared)

if(MYNUMBER_BUILD_CLI)
  add_executable(mynumber_cli ${MYNUMBER_ROOT}/src/main.cpp)
  target_link_libraries(mynumber_cli PRIVATE mynumber_static)
  target_include_directories(mynumber_cli PRIVATE ${MYNUMBER_PUBLIC_INCLUDES})
  target_compile_options(mynumber_cli PRIVATE ${MYNUMBER_COMPILE_OPTIONS})
  set_target_properties(mynumber_cli PROPERTIES OUTPUT_NAME mynumber)
  list(APPEND MYNUMBER_INSTALL_TARGETS mynumber_cli)
endif()

install(TARGETS ${MYNUMBER_INSTALL_TARGETS}
  EXPORT mynumberTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install(FILES ${MYNUMBER_ROOT}/include/mynumber.hpp DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(DIRECTORY ${MYNUMBER_ROOT}/include/mynumber DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
  FILES_MATCHING PATTERN "*.hpp"
)
install(FILES ${MYNUMBER_EXPORT_HEADER} DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/mynumber)

install(EXPORT mynumberTargets
  FILE mynumberTargets.cmake
  NAMESPACE mynumber::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mynumber
)

configure_package_config_file(
  "${MYNUMBER_CMAKE_DIR}/cmake/mynumberConfig.cmake.in"
  "${CMAKE_CURRENT_BINARY_DIR}/mynumberConfig.cmake"
  INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mynumber
)

write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/mynumberConfigVersion.cmake"
  VERSION ${PROJECT_VERSION}
  COMPATIBILITY SameMajorVersion
)

install(FILES
  "${CMAKE_CURRENT_BINARY_DIR}/mynumberConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/mynumberConfigVersion.cmake"
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/mynumber
)

configure_file(
  "${MYNUMBER_CMAKE_DIR}/cmake/mynumber.pc.in"
  "${CMAKE_CURRENT_BINARY_DIR}/mynumber.pc"
  @ONLY
)

install(FILES "${CMAKE_CURRENT_BINARY_DIR}/mynumber.pc"
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/pkgconfig
)

set(CPACK_PACKAGE_NAME mynumber)
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Number combination puzzle solver C++ library")
set(CPACK_PACKAGE_VENDOR "lordofdestiny")
set(CPACK_GENERATOR "TGZ;ZIP")
set(CPACK_INCLUDE_TOPLEVEL_DIRECTORY ON)

include(CPack)
