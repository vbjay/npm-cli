# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "memoryjs",
      "include_dirs" : [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "sources": [
        "lib/memoryjs.cc",
        "lib/memory.cc",
        "lib/process.cc",
        "lib/module.cc",
        "lib/pattern.cc",
        "lib/functions.cc",
        "lib/debugger.cc"
      ],
      'defines': [ 'NAPI_VERSION=8', 'NAPI_DISABLE_CPP_EXCEPTIONS' ]
    }
  ]
}
