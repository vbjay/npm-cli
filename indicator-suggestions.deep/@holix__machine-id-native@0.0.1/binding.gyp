# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "machine_id_native",
      "sources": [
        "src/addon.cpp",
        "src/machine_id.h"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        [ "OS=='mac'", { "sources": [ "src/machine_id_mac.cpp" ] } ],
        [ "OS=='win'", { "sources": [ "src/machine_id_win.cpp" ] } ],
        [ "OS=='linux'", { "sources": [ "src/machine_id_linux.cpp" ] } ]
      ]
    }
  ]
}
