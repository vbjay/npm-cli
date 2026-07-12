cmake_minimum_required(VERSION 2.8)
project(nwjs_addons)

# XP-compatible settings for VS2015
if(MSVC)
  # Use static runtime for single-binary distribution
  set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} /MT")
  set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG} /MTd")

  # Disable incremental linking (XP compat)
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /INCREMENTAL:NO")
  set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} /INCREMENTAL:NO")

  # Target XP subsystem (5.01 = XP)
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /SUBSYSTEM:CONSOLE,5.01")
  set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} /SUBSYSTEM:CONSOLE,5.01")
endif()

# Include cmake-js paths (includes node headers, v8, uv, and nan)
include_directories(${CMAKE_JS_INC})

# addon_api.h abstraction layer — include src/ so all addons can find it
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/src")

# Detect vendor platform directory name
# Windows: x86/x64 (existing), Linux/macOS: platform-arch
if(WIN32)
  if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(VENDOR_PLATFORM "x64")
  else()
    set(VENDOR_PLATFORM "x86")
  endif()
elseif(APPLE)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
    set(VENDOR_PLATFORM "macos-arm64")
  else()
    set(VENDOR_PLATFORM "macos-x64")
  endif()
elseif(UNIX)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    set(VENDOR_PLATFORM "linux-arm64")
  else()
    set(VENDOR_PLATFORM "linux-x64")
  endif()
endif()

# Backend selection: USE_NAPI for node-addon-api, USE_NAN (default) for NAN
if(USE_NAPI)
  add_definitions(-DUSE_NAPI=1)
  add_definitions(-DNAPI_DISABLE_CPP_EXCEPTIONS)

  # node-addon-api C++ wrapper headers
  execute_process(COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
  include_directories(${NODE_ADDON_API_DIR})
else()
  add_definitions(-DUSE_NAN=1)
endif()

# Source files — all addons always compiled on all platforms.
# Windows-only addons use #ifdef _WIN32 stubs internally.
set(SOURCES src/module.cpp)

# Clipboard addon
file(GLOB CLIPBOARD_SRC "clipboard/src/*.cpp")
list(APPEND SOURCES ${CLIPBOARD_SRC})

# Folder-dialog addon
file(GLOB FOLDER_DIALOG_SRC "folder-dialog/src/*.cpp")
list(APPEND SOURCES ${FOLDER_DIALOG_SRC})

# macOS: Objective-C++ sources for clipboard and folder-dialog (AppKit APIs)
if(APPLE)
  file(GLOB CLIPBOARD_MM "clipboard/src/*.mm")
  file(GLOB FOLDER_DIALOG_MM "folder-dialog/src/*.mm")
  list(APPEND SOURCES ${CLIPBOARD_MM} ${FOLDER_DIALOG_MM})
endif()

# IPC addon
file(GLOB IPC_SRC "ipc/src/*.cpp")
list(APPEND SOURCES ${IPC_SRC})

# Call-DLL addon
file(GLOB CALLDLL_SRC "call-dll/src/*.cpp")
list(APPEND SOURCES ${CALLDLL_SRC})

# TinyCC addon — jsbridge abstracted for both NAN and N-API
file(GLOB TINYCC_SRC "tinycc/src/*.cpp")
list(APPEND SOURCES ${TINYCC_SRC})
include_directories("tinycc/src")
include_directories("tinycc/include")
set(TCC_VENDOR_LIB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/tinycc/lib/${VENDOR_PLATFORM}")
if(WIN32)
  # Windows always uses bundled libtcc
  add_definitions(-DHAS_LIBTCC=1)
  link_directories(${TCC_VENDOR_LIB_DIR})
elseif(UNIX)
  # Cascade: bundled vendor → system-installed → stubs
  find_library(TCC_VENDOR_LIB NAMES tcc libtcc PATHS ${TCC_VENDOR_LIB_DIR} NO_DEFAULT_PATH)
  if(TCC_VENDOR_LIB)
    add_definitions(-DHAS_LIBTCC=1)
    set(TCC_LIBRARY ${TCC_VENDOR_LIB})
    message(STATUS "Using bundled libtcc: ${TCC_VENDOR_LIB}")
  else()
    find_library(TCC_LIBRARY tcc)
    find_path(TCC_INCLUDE_DIR libtcc.h)
    if(TCC_LIBRARY AND TCC_INCLUDE_DIR)
      add_definitions(-DHAS_LIBTCC=1)
      include_directories(${TCC_INCLUDE_DIR})
      message(STATUS "Using system libtcc: ${TCC_LIBRARY}")
    else()
      message(STATUS "libtcc not found — tinycc addon will use stubs")
    endif()
  endif()
endif()

# nw-sqlite3 addon
add_definitions(
  -DSQLITE_THREADSAFE=1
  -DSQLITE_ENABLE_JSON1=1
  -DSQLITE_OMIT_DEPRECATED=1
  -DSQLITE_DQS=0
  -DSQLITE_DEFAULT_MEMSTATUS=0
  -DSQLITE_OMIT_PROGRESS_CALLBACK=1
)
set(SQLITE_SRC "nw-sqlite3/src/sqlite3.c")
file(GLOB SQLITE3_CPP_SRC "nw-sqlite3/src/*.cpp")
list(APPEND SOURCES ${SQLITE_SRC} ${SQLITE3_CPP_SRC})
include_directories("nw-sqlite3/src")

# CSV Parser addon
file(GLOB CSVPARSER_SRC "csv-parser/src/*.cpp")
list(APPEND SOURCES ${CSVPARSER_SRC})

# RSS Parser addon
file(GLOB RSSPARSER_SRC "rss-parser/src/*.cpp")
list(APPEND SOURCES ${RSSPARSER_SRC})

# SDL2 Input addon
file(GLOB SDL2INPUT_SRC "sdl2-input/src/*.cpp")
list(APPEND SOURCES ${SDL2INPUT_SRC})
include_directories("sdl2-input/src")
set(SDL2_VENDOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/sdl2-input/vendor/SDL2")
set(SDL2_VENDOR_LIB_DIR "${SDL2_VENDOR_DIR}/lib/${VENDOR_PLATFORM}")
if(WIN32)
  # Windows always uses bundled SDL2
  add_definitions(-DHAS_SDL2=1)
  include_directories("${SDL2_VENDOR_DIR}/include")
  link_directories(${SDL2_VENDOR_LIB_DIR})
elseif(UNIX)
  # Cascade: bundled vendor → system-installed → stubs
  find_library(SDL2_VENDOR_LIB NAMES SDL2 SDL2-static PATHS ${SDL2_VENDOR_LIB_DIR} NO_DEFAULT_PATH)
  if(SDL2_VENDOR_LIB)
    add_definitions(-DHAS_SDL2=1)
    include_directories("${SDL2_VENDOR_DIR}/include")
    set(SDL2_LIBRARIES ${SDL2_VENDOR_LIB})
    set(SDL2_FOUND TRUE)
    message(STATUS "Using bundled SDL2: ${SDL2_VENDOR_LIB}")
  else()
    find_package(SDL2 QUIET)
    if(SDL2_FOUND)
      add_definitions(-DHAS_SDL2=1)
      include_directories(${SDL2_INCLUDE_DIRS})
      message(STATUS "Using system SDL2: ${SDL2_INCLUDE_DIRS}")
    else()
      message(STATUS "SDL2 not found — sdl2-input addon will use stubs")
    endif()
  endif()
endif()

# Single combined addon
add_library(${PROJECT_NAME} SHARED ${SOURCES})

# .node extension
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# Link cmake-js lib
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# Platform-specific link libraries
if(WIN32)
  target_link_libraries(${PROJECT_NAME}
    Shlwapi.lib
    Shell32.lib
    Ole32.lib
    Gdiplus.lib
    User32.lib
    winmm.lib
    imm32.lib
    version.lib
    setupapi.lib
  )
  target_link_libraries(${PROJECT_NAME} libtcc.lib SDL2-static.lib)
elseif(UNIX)
  target_link_libraries(${PROJECT_NAME} pthread dl)
  # macOS: AppKit for clipboard and folder-dialog (NSPasteboard, NSOpenPanel)
  if(APPLE)
    target_link_libraries(${PROJECT_NAME} "-framework AppKit")
  endif()
  if(SDL2_FOUND)
    target_link_libraries(${PROJECT_NAME} ${SDL2_LIBRARIES})
    # Static SDL2 needs transitive deps for joystick/haptic subsystems
    if(SDL2_VENDOR_LIB)
      target_link_libraries(${PROJECT_NAME} m)
      if(APPLE)
        target_link_libraries(${PROJECT_NAME}
          "-framework CoreFoundation"
          "-framework IOKit"
          "-framework ForceFeedback"
          "-framework Carbon"
          "-framework GameController"
          "-framework CoreHaptics"
        )
      endif()
    endif()
  endif()
  if(TCC_LIBRARY)
    target_link_libraries(${PROJECT_NAME} ${TCC_LIBRARY})
  endif()
endif()
