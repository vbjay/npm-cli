# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "napi_clipboard_addon",
      "sources": [
        "src/main.cpp",
        "src/clipboard_api.cpp",
        "src/win32_clipboard.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-luser32",
            "-lkernel32",
            "-ladvapi32"
          ]
        }]
      ]
    }
  ]
}