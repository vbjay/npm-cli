# DEFANGED: static-analysis cache — do not execute
{
  "targets": [{
    "target_name": "electron_drag_click",
    "sources": [ ],
    "conditions": [
      ['OS=="mac"', {
        "sources": [
          "electron_drag_click.mm"
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
      "OTHER_CPLUSPLUSFLAGS": ["-std=c++20", "-stdlib=libc++", "-mmacosx-version-min=10.12"],
    }
  }]
}
