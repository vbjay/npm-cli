# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "unit_converter",
      "sources": [ "unit_converter.cpp" ],
      "cflags": ["-std=c++17", "-DBUILD_NODEJS", "-fexceptions"],
      "cflags_cc": ["-std=c++17", "-DBUILD_NODEJS", "-fexceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include\")",
        "node_modules/node-addon-api",
        "<!(python3-config --includes | sed 's/-I//g')"
      ],
      "libraries": [
        "<!(python3-config --ldflags)"
      ],
      "defines": []
    }
  ]
}
