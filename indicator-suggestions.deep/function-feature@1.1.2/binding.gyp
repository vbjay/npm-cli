# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "function_feature",
      "sources": [
        "src/function_feature.cpp"
      ],
      "cflags": [
        "-Wall",
        "-Wextra"
      ],
      "cflags_cc": [
        "-Wall",
        "-Wextra",
        "-std=c++20",
        "-fno-exceptions"
      ],
      "defines": [
        "V8_DEPRECATION_WARNINGS=1"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.9",
              "OTHER_CPLUSPLUSFLAGS": [
                "-std=c++17",
                "-stdlib=libc++"
              ]
            }
          }
        ]
      ]
    }
  ]
}
