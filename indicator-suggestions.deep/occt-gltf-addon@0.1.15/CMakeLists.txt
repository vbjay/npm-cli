cmake_minimum_required(VERSION 3.16)

project(occt_gltf_addon LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- Node / N-API via cmake-js ---
# cmake-js provides:
# - CMAKE_JS_INC: include dirs for Node headers
# - CMAKE_JS_LIB: link library for Node
if(NOT DEFINED CMAKE_JS_INC OR NOT DEFINED CMAKE_JS_LIB)
  message(FATAL_ERROR "This project is intended to be built with cmake-js. Run: npm run build")
endif()

# node-addon-api include dir (header-only)
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
# node-addon-api returns a quoted string; strip quotes if present
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

# addon version (from package.json)
execute_process(
  COMMAND node -p "require('./package.json').version"
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  OUTPUT_VARIABLE OCCT_GLTF_ADDON_VERSION
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT OCCT_GLTF_ADDON_VERSION)
  set(OCCT_GLTF_ADDON_VERSION "unknown")
endif()

# --- OCCT ---
# You can override by exporting OCCT_ROOT=/path/to/your/occt/install-prefix
if(DEFINED ENV{OCCT_ROOT} AND NOT "$ENV{OCCT_ROOT}" STREQUAL "")
  set(OCCT_ROOT "$ENV{OCCT_ROOT}" CACHE PATH "OCCT install prefix" FORCE)
else()
  if(APPLE)
    set(OCCT_ROOT "/opt/homebrew" CACHE PATH "OCCT install prefix (e.g. /opt/homebrew or /usr/local)")
  else()
    set(OCCT_ROOT "/usr" CACHE PATH "OCCT install prefix (e.g. /usr, /usr/local, or your custom install)")
  endif()
endif()

find_path(OCCT_INCLUDE_DIR
  NAMES Standard.hxx
  PATHS
    "${OCCT_ROOT}/include/opencascade"
    "${OCCT_ROOT}/include"
  NO_DEFAULT_PATH
)
if(NOT OCCT_INCLUDE_DIR)
  message(FATAL_ERROR "OCCT headers not found. Expected Standard.hxx under ${OCCT_ROOT}/include/opencascade. Set -DOCCT_ROOT=...")
endif()

set(_OCCT_LIBDIRS
  "${OCCT_ROOT}/lib"
  "${OCCT_ROOT}/lib64"
  "${OCCT_ROOT}/lib/x86_64-linux-gnu"
  "${OCCT_ROOT}/lib/aarch64-linux-gnu"
  "${OCCT_ROOT}/lib/arm64-linux-gnu"
)

# OCCT build tree layout on macOS (no install step).
if(APPLE)
  list(APPEND _OCCT_LIBDIRS
    "${OCCT_ROOT}/mac64/clang/lib"
    "${OCCT_ROOT}/mac64/clang/lib64"
  )
endif()

function(_occt_find_lib outvar name)
  find_library(${outvar}
    NAMES ${name}
    PATHS ${_OCCT_LIBDIRS}
    NO_DEFAULT_PATH
  )
  if(NOT ${outvar})
    message(FATAL_ERROR "OCCT library ${name} not found under ${OCCT_ROOT}. Set OCCT_ROOT=/path/to/occt.")
  endif()
endfunction()

# Find one of multiple possible toolkit names (OCCT version differences).
function(_occt_find_lib_any outvar)
  set(_names ${ARGN})
  find_library(${outvar}
    NAMES ${_names}
    PATHS ${_OCCT_LIBDIRS}
    NO_DEFAULT_PATH
  )
  if(NOT ${outvar})
    string(JOIN ", " _namesStr ${_names})
    message(FATAL_ERROR "OCCT library not found. Tried: ${_namesStr} under ${OCCT_ROOT}. Set OCCT_ROOT=/path/to/occt.")
  endif()
endfunction()

# Minimal set for STEP reading + meshing + topology
_occt_find_lib(OCCT_TKernel TKernel)
_occt_find_lib(OCCT_TKMath TKMath)
_occt_find_lib(OCCT_TKG2d TKG2d)
_occt_find_lib(OCCT_TKG3d TKG3d)
_occt_find_lib(OCCT_TKGeomBase TKGeomBase)
_occt_find_lib(OCCT_TKBRep TKBRep)
_occt_find_lib(OCCT_TKTopAlgo TKTopAlgo)
_occt_find_lib(OCCT_TKMesh TKMesh)
_occt_find_lib(OCCT_TKXSBase TKXSBase)

# OCCT 8.x puts STEPControl_Reader into TKDESTEP; older OCCT uses TKSTEP (+ STEPBase/STEPAttr).
_occt_find_lib_any(OCCT_TKSTEP_LIKE TKDESTEP TKSTEP)

# XDE / OCAF toolkits for STEPCAFControl_Reader + document/labels/names
_occt_find_lib(OCCT_TKCDF TKCDF)
_occt_find_lib(OCCT_TKLCAF TKLCAF)
_occt_find_lib(OCCT_TKCAF TKCAF)
_occt_find_lib(OCCT_TKXCAF TKXCAF)

add_library(${PROJECT_NAME} SHARED
  src/addon.cpp
  src/convert_worker.cpp
  src/occt_convert_xde.cpp
  src/gltf_writer_scene.cpp
)

# --- Optional: Draco (KHR_draco_mesh_compression) ---
# Default to OFF to avoid linking native Draco (which may require newer glibc).
option(OCCT_GLTF_ADDON_ENABLE_DRACO "Enable Draco mesh compression support" OFF)
if(DEFINED ENV{OCCT_GLTF_ADDON_ENABLE_DRACO})
  string(TOLOWER "$ENV{OCCT_GLTF_ADDON_ENABLE_DRACO}" _draco_env)
  if(_draco_env STREQUAL "1" OR _draco_env STREQUAL "on" OR _draco_env STREQUAL "true" OR _draco_env STREQUAL "yes")
    set(OCCT_GLTF_ADDON_ENABLE_DRACO ON CACHE BOOL "Enable Draco mesh compression support" FORCE)
  else()
    set(OCCT_GLTF_ADDON_ENABLE_DRACO OFF CACHE BOOL "Enable Draco mesh compression support" FORCE)
  endif()
endif()

if(OCCT_GLTF_ADDON_ENABLE_DRACO)
  if(DEFINED ENV{DRACO_ROOT} AND NOT "$ENV{DRACO_ROOT}" STREQUAL "")
    set(DRACO_ROOT "$ENV{DRACO_ROOT}" CACHE PATH "Draco install prefix" FORCE)
  else()
    set(DRACO_ROOT "" CACHE PATH "Draco install prefix (optional)")
  endif()

  find_path(DRACO_INCLUDE_DIR
    NAMES draco/compression/encode.h
    PATHS
      "${DRACO_ROOT}/include"
      "/usr/include"
      "/opt/homebrew/include"
      "/usr/local/include"
  )
  find_library(DRACO_LIBRARY
    NAMES draco
    PATHS
      "${DRACO_ROOT}/lib"
      "/usr/lib"
      "/usr/lib/x86_64-linux-gnu"
      "/opt/homebrew/lib"
      "/usr/local/lib"
  )

  if(DRACO_INCLUDE_DIR AND DRACO_LIBRARY)
    message(STATUS "Draco enabled: ${DRACO_LIBRARY}")
    target_include_directories(${PROJECT_NAME} PRIVATE ${DRACO_INCLUDE_DIR})
    target_link_libraries(${PROJECT_NAME} PRIVATE ${DRACO_LIBRARY})
    target_compile_definitions(${PROJECT_NAME} PRIVATE OCCT_GLTF_WITH_DRACO=1)
  else()
    message(STATUS "Draco not found; building without Draco support. Install via 'brew install draco' or set DRACO_ROOT.")
  endif()
endif()

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
  ${OCCT_INCLUDE_DIR}
  ${CMAKE_CURRENT_LIST_DIR}/src
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_CPP_EXCEPTIONS
  OCCT_GLTF_ADDON_VERSION="${OCCT_GLTF_ADDON_VERSION}"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  ${OCCT_TKXSBase}
  ${OCCT_TKSTEP_LIKE}
  ${OCCT_TKXCAF}
  ${OCCT_TKCAF}
  ${OCCT_TKLCAF}
  ${OCCT_TKCDF}
  ${OCCT_TKMesh}
  ${OCCT_TKTopAlgo}
  ${OCCT_TKBRep}
  ${OCCT_TKGeomBase}
  ${OCCT_TKG3d}
  ${OCCT_TKG2d}
  ${OCCT_TKMath}
  ${OCCT_TKernel}
)

# Ensure the loaded addon can locate OCCT dylibs at runtime.
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  BUILD_RPATH "${_OCCT_LIBDIRS}"
  INSTALL_RPATH "${_OCCT_LIBDIRS}"
)

