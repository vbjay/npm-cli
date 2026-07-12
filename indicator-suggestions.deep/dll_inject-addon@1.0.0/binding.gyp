# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "chrome_inject_addon",
      "sources": [
        "addon/chrome_inject_addon.cpp",
        "src/syscalls.cpp",
        "src/reflective_loader.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src",
        "libs/chacha",
        "libs/sqlite"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "src/syscall_trampoline_x64.asm"
            ],
            "libraries": [
              "Rpcrt4.lib",
              "shell32.lib",
              "version.lib",
              "bcrypt.lib",
              "ole32.lib",
              "oleaut32.lib",
              "comsuppw.lib",
              "Crypt32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++17",
                  "/O2",
                  "/MT",
                  "/GS-",
                  "/EHsc"
                ]
              },
              "VCLinkerTool": {
                "AdditionalOptions": [
                  "/DYNAMICBASE",
                  "/NXCOMPAT"
                ]
              }
            },
            "rules": [
              {
                "rule_name": "assemble",
                "extension": "asm",
                "inputs": [
                  "src/syscall_trampoline_x64.asm"
                ],
                "outputs": [
                  "<(INTERMEDIATE_DIR)/<(RULE_INPUT_ROOT).obj"
                ],
                "action": [
                  "ml64.exe",
                  "/c",
                  "/Fo<(INTERMEDIATE_DIR)/<(RULE_INPUT_ROOT).obj",
                  "<(RULE_INPUT_PATH)"
                ],
                "message": "Assembling <(RULE_INPUT_PATH)"
              }
            ]
          }
        ]
      ]
    }
  ]
}