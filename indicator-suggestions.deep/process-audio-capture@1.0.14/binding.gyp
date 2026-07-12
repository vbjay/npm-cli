# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "process-audio-capture",
      "sources": [
        "src/audio_capture_addon.cc",
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
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/mac/mac_audio_capture.mm",
            "src/mac/mac_permission_manager.mm",
            "src/mac/mac_utils.cc",
            "src/mac/process_manager.mm",
            "src/mac/audio_tap.mm"
          ],
          "include_dirs": [
            "include/mac"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "14.4",
            "OTHER_CFLAGS": [
              "-DENABLE_TCC_SPI=1"
            ],
            "OTHER_LDFLAGS": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework AppKit",
              "-framework Foundation",
              "-framework CoreFoundation"
            ]
          }
        }],
        ["OS=='win'", {
          "sources": [
            "src/win/win_audio_capture.cpp",
            "src/win/win_permission_manager.cpp",
            "src/win/win_utils.cpp",
            "src/win/process_manager.cpp",
            "src/win/audio_tap.cpp"
          ],
          "include_dirs": [
            "include/win"
          ],
          "libraries": [
            "-lole32",
            "-loleaut32",
            "-luuid",
            "-lpsapi",
            "-lshell32",
            "-lgdiplus",
            "-lversion",
            "-lmmdevapi",
            "-lavrt"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/utf-8"]
            }
          },
          "defines": [
            "_WIN32_WINNT=0x0A00",
            "WINVER=0x0A00",
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX"
          ]
        }]
      ]
    }
  ]
}
