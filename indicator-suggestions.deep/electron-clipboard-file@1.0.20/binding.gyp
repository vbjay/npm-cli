# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "clipboard",
      "sources": [ "clipboard.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "conditions": [
        ["OS=='win'", {
          "defines": [ "_WIN32_WINNT=0x0601" ],
          "libraries": ["user32.lib"]
        }],
        ["OS=='mac'", {
          "libraries": [
            "-framework CoreFoundation",
            "-framework ApplicationServices",
            "-framework Carbon"
          ],
        }]
      ],
      "cflags_cc!": [ "-fno-rtti", "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    }
  ]
}