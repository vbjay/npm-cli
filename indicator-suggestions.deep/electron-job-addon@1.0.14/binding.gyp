# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "job_addon",
      "conditions": [
        ['OS=="win"', {
          "sources": [
            "src/addon.cc",
            "src/JobAddon.cc"
          ],
          "include_dirs": [
            "<!(node -p \"require('node-addon-api').include_dir\")",
            "include"
          ],
          "libraries": [
            "kernel32.lib"
          ],
          "dependencies": [
            "<!(node -p \"require('node-addon-api').gyp\")"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/FS"]
            },
            "VCLinkerTool": {
              "GenerateDebugInformation": "true"
            }
          },
          "defines": [
            "NODE_ADDON_API_CPP_EXCEPTIONS",
            "NAPI_VERSION=8",
            "WINVER=0x0A00",
            "_WIN32_WINNT=0x0A00"
          ]
        }]
      ]
    }
  ]
}
