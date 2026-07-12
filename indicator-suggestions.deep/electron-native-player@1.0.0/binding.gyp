# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "native_player",
      "sources": [
        "src/native_player.cc",
        "src/yuv_player.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NODE_ADDON_API_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "conditions": [
        ['OS=="win"', {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/std:c++17"
              ]
            }
          },
          "defines": [
            "_CRT_SECURE_NO_WARNINGS"
          ]
        }],
        ['OS=="linux"', {
          "cflags_cc": [
            "-std=c++17",
            "-fexceptions",
            "-pthread"
          ],
          "libraries": [
            "-lpthread"
          ]
        }],
        ['OS=="mac"', {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.13"
          }
        }]
      ]
    }
  ]
}