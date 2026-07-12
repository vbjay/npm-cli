# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "wildmatch",
      "sources": [ "src/wildmatch.cc" ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS==\"mac\"", {
          "cflags_cc": [ "-fexceptions" ],
          "cflags": [ "-fexceptions" ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "OTHER_CFLAGS": [ "-fexceptions" ],
            "OTHER_CPLUSPLUSFLAGS": [ "-fexceptions" ]
          }
        }],
        ["OS==\"linux\"", {
          "cflags_cc": [ "-std=c++17", "-fexceptions" ],
          "cflags": [ "-fexceptions" ],
          "ldflags": [
            "-Wl,-Bsymbolic",
            "-Wl,--exclude-libs,ALL"
          ]
        }],
        ["OS==\"win\"", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }]
      ]
    }
  ]
}
