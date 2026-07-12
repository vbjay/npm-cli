# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "hardware_id_addon",
      "sources": [
        "src/hardware_id_addon.cpp",
        "src/hardware_identifier.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lwbemuuid",
              "-lole32",
              "-loleaut32"
            ]
          }
        ]
      ]
    }
  ]
}
