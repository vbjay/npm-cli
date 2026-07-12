# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "gpu",
      "product_dir": "<(module_path)",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "sources": [
        "src/binding.cpp",
        "src/gpu_info.c",
        "src/vendor/nvidia.c",
        "src/vendor/amd.c",
        "src/vendor/intel.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src",
        "src/includes"
      ],
      "defines": [ 
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=<(napi_build_version)"
      ],
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/windows/nvidia_windows.c",
            "src/windows/amd_windows.c",
            "src/windows/intel_windows.c",
            "src/includes/adlx/ADLXHelper/ADLXHelper.c",
            "src/includes/adlx/ADLXHelper/WinAPIS.c"
          ],
          "libraries": [
            "dxgi.lib",
            "dxguid.lib",
            "setupapi.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            }
          }
        }],
        ["OS=='mac'", {
          "sources": [
            "src/macos/nvidia_mac.c",
            "src/macos/amd_mac.c",
            "src/macos/intel_mac.c"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.13"
          },
          "link_settings": {
            "libraries": [
              "-framework IOKit",
              "-framework CoreFoundation",
              "-framework Metal"
            ]
          }
        }],
        ["OS=='linux'", {
          "sources": [
            "src/linux/nvidia_linux.c",
            "src/linux/amd_linux.c",
            "src/linux/intel_linux.c"
          ]
        }]
      ]
    }
  ]
}
