# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "dnszone",
      "sources": [
        "src/zone_parser.cc",
        "src/node_binding.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-O3",
        "-fno-rtti"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_RTTI": "NO",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_OPTIMIZATION_LEVEL": "3"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "RuntimeTypeInfo": "false",
          "AdditionalOptions": ["/std:c++17", "/O2"]
        }
      }
    }
  ]
}
