# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "brio_zoom_control",
      "sources": [
        "src/binding.cpp",
        "src/camera_control.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src/"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "src/windows/directshow_control.cpp"
            ],
            "libraries": [
              "-lole32",
              "-loleaut32",
              "-lstrmiids",
              "-luuid"
            ],
            "include_dirs": [
              "src/windows/"
            ],
            "defines": [
              "WIN32_LEAN_AND_MEAN",
              "_WIN32_WINNT=0x0601"
            ]
          }
        ],
        [
          "OS=='linux'",
          {
            "sources": [
              "src/linux/v4l2_control.cpp"
            ],
            "libraries": [
              "-lv4l2"
            ],
            "include_dirs": [
              "src/linux/"
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "sources": [
              "src/macos/avfoundation_control.mm"
            ],
            "libraries": [
              "-framework Foundation",
              "-framework AVFoundation",
              "-framework CoreMedia"
            ],
            "include_dirs": [
              "src/macos/"
            ],
            "xcode_settings": {
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.13"
            }
          }
        ]
      ]
    }
  ]
}