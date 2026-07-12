# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "access_check",
      "sources": ["src/access_check.mm"],
      "include_dirs": [
        "<!(node -p \"require.resolve('node-addon-api').replace(/\\/[^\\/]+$/, '')\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
