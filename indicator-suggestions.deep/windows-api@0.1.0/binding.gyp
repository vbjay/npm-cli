# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "addon",
      "include_dirs" : [
        "<!@(node -p \"require('node-addon-api').include\")",
        "imports/rapidxml-1.13"
      ],
      "libraries": [],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "sources": [ "cppsrc/main.cpp" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ]
    }
  ]
}
