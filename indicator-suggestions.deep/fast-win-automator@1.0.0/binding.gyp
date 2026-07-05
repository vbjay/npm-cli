# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "win_automation_native",
      "sources": [ "src_native/automation.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "libraries": [
        "-lole32.lib",
        "-loleaut32.lib"
      ]
    }
  ]
}