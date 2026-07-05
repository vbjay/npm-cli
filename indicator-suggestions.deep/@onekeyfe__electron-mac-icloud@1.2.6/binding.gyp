# DEFANGED: static-analysis cache — do not execute
{
  "targets": [{
    "target_name": "nsUbiquitousKeyValueStore",
    "sources": [ ],
    "conditions": [
      ['OS=="mac"', {
        "sources": [
          "src/nsUbiquitousKeyValueStore.mm",
          "src/json_formatter.h",
          "src/json_formatter.cc"
        ],
      }]
    ],
    'include_dirs': [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    'libraries': [],
    'dependencies': [
      "<!(node -p \"require('node-addon-api').gyp\")"
    ],
    'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    "xcode_settings": {
      "OTHER_CFLAGS": [
        "-fobjc-arc",
        "-arch x86_64",
        "-arch arm64"
      ],
      "OTHER_CPLUSPLUSFLAGS": [
        "-fobjc-arc",
        "-std=c++17",
        "-stdlib=libc++",
        "-Wextra",
        "-arch x86_64",
        "-arch arm64"
      ],
      "OTHER_LDFLAGS": [
        "-Wl, -bind_at_load",
        "-framework CoreFoundation -framework Cocoa -framework Carbon -framework Security -framework CloudKit",
        "-arch x86_64",
        "-arch arm64"
        ],
      "MACOSX_DEPLOYMENT_TARGET": "10.15"
    }
  }]
}
