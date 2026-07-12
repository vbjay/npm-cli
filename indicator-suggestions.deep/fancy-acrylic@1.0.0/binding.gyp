# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "fancy-acrylic",
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "include_dirs": [
        "src"
      ],
      "sources": [
        "src/main.cc"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "dwmapi.lib"
          ],
          "cflags_cc": [
            "/std:c++17",
            "/utf-8"
          ]
        }],
        ["OS!='win'", {
          "cflags_cc": [
            "-std=c++17"
          ]
        }]
      ]
    }
  ]
}