# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "winstore_startup",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": ["startup_task.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++20"],
                "ExceptionHandling": 1
              }
            },
            "msvs_version": "auto",
            "libraries": ["windowsapp.lib"]
          }
        ]
      ]
    }
  ]
}
