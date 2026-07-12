# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "tree_sitter_plantuml_binding",
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      "sources": [
        "bindings/node/binding.cc",
        "src/parser.c",
      ],
      "cflags_c": [
        "-std=c99",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-Wno-unused-but-set-variable",
        "-fstack-protector-strong",
        "-D_FORTIFY_SOURCE=2"
      ],
      "cflags_cc": [
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fstack-protector-strong",
        "-D_FORTIFY_SOURCE=2"
      ],
      "defines": [
        "NAPI_VERSION=6",
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        [
          "OS=='linux' or OS=='mac'",
          {
            "cflags_c": [
              "-fsanitize=address",
              "-fsanitize=undefined",
              "-fno-omit-frame-pointer"
            ],
            "cflags_cc": [
              "-fsanitize=address",
              "-fsanitize=undefined",
              "-fno-omit-frame-pointer"
            ],
            "ldflags": [
              "-fsanitize=address",
              "-fsanitize=undefined"
            ]
          }
        ]
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "BufferSecurityCheck": "true",
          "AdditionalOptions": [
            "/sdl",
            "/guard:cf",
            "/W4"
          ]
        }
      },
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "WARNING_CFLAGS": [
          "-Wall",
          "-Wextra",
          "-Wno-unused-parameter",
          "-Wno-unused-but-set-variable"
        ],
        "OTHER_CFLAGS": [
          "-fstack-protector-strong",
          "-fsanitize=address",
          "-fsanitize=undefined",
          "-fno-omit-frame-pointer"
        ],
        "OTHER_LDFLAGS": [
          "-fsanitize=address",
          "-fsanitize=undefined"
        ]
      }
    }
  ]
}
