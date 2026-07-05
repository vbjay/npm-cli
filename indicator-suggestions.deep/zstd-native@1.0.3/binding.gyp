# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "zstd_native",
      "sources": [ "zstd_native.cpp" ],
      "include_dirs": [
        "node_modules/node-addon-api"
      ],
      "libraries": [
        "-lzstd"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}