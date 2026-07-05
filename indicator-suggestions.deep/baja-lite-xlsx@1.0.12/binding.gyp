# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "baja_xlsx",
      "sources": [
        "src/addon.cpp",
        "src/xlsx_reader.cpp",
        "src/image_extractor.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(module_root_dir)/src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        [
          "OS=='win'",
          {
            "defines": [
              "_HAS_EXCEPTIONS=1"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            },
            "include_dirs": [
              "<!(echo %VCPKG_ROOT%)/installed/x64-windows/include"
            ],
            "libraries": [
              "<!(echo %VCPKG_ROOT%)/installed/x64-windows/lib/xlnt.lib",
              "<!(echo %VCPKG_ROOT%)/installed/x64-windows/lib/zip.lib"
            ]
          }
        ],
        [
          "OS=='linux'",
          {
            "cflags_cc": [
              "-std=c++17",
              "-fexceptions"
            ],
            "include_dirs": [
              "/usr/local/include"
            ],
            "libraries": [
              "-lxlnt",
              "-lzip"
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15",
              "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
            },
            "include_dirs": [
              "/usr/local/include"
            ],
            "libraries": [
              "-lxlnt",
              "-lzip"
            ]
          }
        ]
      ]
    }
  ]
}

