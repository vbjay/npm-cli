# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "annoy",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "deps/annoy/src"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "ANNOYLIB_MULTITHREADED_BUILD"
      ],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"]
        }
      },
      "conditions": [
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-fexceptions"]
        }]
      ]
    }
  ]
}
