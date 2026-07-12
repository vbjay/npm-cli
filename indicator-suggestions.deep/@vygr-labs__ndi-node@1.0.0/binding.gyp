# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "ndi_addon",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "src/ndi_addon.cpp",
        "src/ndi_finder.cpp",
        "src/ndi_sender.cpp",
        "src/ndi_receiver.cpp",
        "src/ndi_utils.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "deps/ndi/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "<(module_root_dir)/deps/ndi/lib/x64/Processing.NDI.Lib.x64.lib"
            ],
            "copies": [
              {
                "destination": "<(module_root_dir)/build/Release/",
                "files": [
                  "<(module_root_dir)/deps/ndi/lib/x64/Processing.NDI.Lib.x64.dll"
                ]
              }
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "libraries": [
              "-L<(module_root_dir)/deps/ndi/lib",
              "-lndi"
            ],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15"
            }
          }
        ],
        [
          "OS=='linux'",
          {
            "libraries": [
              "-L<(module_root_dir)/deps/ndi/lib",
              "-lndi"
            ],
            "cflags_cc": ["-std=c++17", "-fexceptions"]
          }
        ]
      ]
    }
  ]
}
