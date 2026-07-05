# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "quilt",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "sources": [ "src/main.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      'msvs_settings': {
        'VCCLCompilerTool': {
          'ExceptionHandling': 1
        }
      }
    }
  ]
}
