# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "BinaryParser",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "sources": [ "main.cpp" ]
    }
  ]
}
