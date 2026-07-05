# DEFANGED: static-analysis cache — do not execute
{
  "variables": {
    "module_name": "node_darts",
    "module_path": "lib/binding/{node_abi}-{platform}-{arch}"
  },
  "targets": [
    {
      "target_name": "<(module_name)",
      "product_dir": "<(module_path)",
      # Both Darts backends are compiled and linked into a single .node so
      # callers can pick between them at runtime via the `backend` option.
      # backend_clone.cpp uses `#define Darts DartsClone` to side-step the
      # ODR collision on Darts::DoubleArray (see backend_clone.cpp comment).
      "sources": [
        "src/native/bindings.cpp",
        "src/native/dictionary.cpp",
        "src/native/builder.cpp",
        "src/native/backend_factory.cpp",
        "src/native/backend_darts.cpp",
        "src/native/backend_clone.cpp",
        "src/native/third_party/darts/darts.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include",
        "src/native"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "OTHER_CPLUSPLUSFLAGS+": [
          "-Wno-unused-command-line-argument",
          "-Qunused-arguments"
        ]
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": [ "/std:c++17" ]
              },
              "VCLinkerTool": {
                "OutputFile": "<(module_root_dir)\\build\\Release\\<(module_name).node"
              }
            },
            "copies": [
              {
                "destination": "<(module_root_dir)/<(module_path)",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/build/Release",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/build/Debug",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/build",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/build/default",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/out/Release",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/out/Debug",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/Release",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/Debug",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/addon-build/release/install-root",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/addon-build/debug/install-root",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/addon-build/default/install-root",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/lib/binding/node-v115-win32-x64",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              },
              {
                "destination": "<(module_root_dir)/lib/binding/node-v<!(node -p \"process.versions.modules\")-<!(node -p \"process.platform\")-<!(node -p \"process.arch\")",
                "files": [ "<(PRODUCT_DIR)/<(module_name).node" ]
              }
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "include_dirs+": [
              "<!(xcrun --show-sdk-path)/usr/include/c++/v1"
            ]
          }
        ],
        [
          "OS=='linux'",
          {
            "cflags": [ "-std=c++17" ],
            "cflags_cc": [
              "-std=c++17",
              "-Wno-unused-command-line-argument"
            ]
          }
        ]
      ]
    }
  ]
}
