# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "ollama_bridge_native",
      "sources": [
        "native/addon.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7"
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "conditions": [
        ["OS=='linux'", {
          "libraries": [
            "<(module_root_dir)/native/lib/libollama_bridge.a"
          ]
        }],
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/native/lib/libollama_bridge.a"
          ]
        }],
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/native/lib/ollama_bridge.lib"
          ]
        }]
      ]
    }
  ]
}