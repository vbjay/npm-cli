# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "sqlite3-pure",
      "sources": [
        "src/sqlite3-pure.cc",
        "deps/sqlite3/sqlite3.c" 
      ],
      "include_dirs": [
        # "<!@(node -p \"require('node-addon-api').include\")",
        "deps/sqlite3" 
      ],
      "dependencies": [
        # "<!(node -p \"require('node-addon-api').gyp\")"
      ],
    #   "cflags!": ["-fno-exceptions"],
    #   "cflags_cc!": ["-fno-exceptions"],
    #   "defines": [
    #     "NAPI_DISABLE_CPP_EXCEPTIONS",
    #     "SQLITE_THREADSAFE=0" 
    #   ],
      "conditions": [
        ['OS=="win"', {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/bigobj"] 
            }
          },
          'variables': {
            'msvs_version': '2022', # 指定Visual Studio版本
          }

        }]
      ]
    }
  ]
}