# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "clipboard",
      "sources": [
        "src/clipboard.cpp",
        "src/clipboard_mac.mm",
        "src/clipboard_win.cpp",
        "src/clipboard_linux.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources!": [
              "src/clipboard_win.cpp",
              "src/clipboard_linux.cpp"
            ],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.9"
            },
            "link_settings": {
              "libraries": [
                "-framework Cocoa",
                "-framework AppKit"
              ]
            }
          }
        ],
        [
          "OS=='win'",
          {
            "sources!": [
              "src/clipboard_mac.mm",
              "src/clipboard_linux.cpp"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            },
            "libraries": [
              "-luser32.lib",
              "-lgdi32.lib",
              "-lole32.lib",
              "-lgdiplus.lib"
            ]
          }
        ],
        [
          "OS=='linux'",
          {
            "sources!": [
              "src/clipboard_mac.mm",
              "src/clipboard_win.cpp"
            ],
            "libraries": [
              "-lX11"
            ]
          }
        ]
      ]
    }
  ]
}