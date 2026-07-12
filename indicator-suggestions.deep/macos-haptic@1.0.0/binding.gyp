# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "macos_haptic",
      "sources": ["haptic.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "AppKit",
              "-F<!(xcrun --show-sdk-path)/System/Library/PrivateFrameworks",
              "-framework", "MultitouchSupport"
            ]
          }
        }]
      ]
    }
  ]
}
