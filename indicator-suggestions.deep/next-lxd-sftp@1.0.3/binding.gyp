# DEFANGED: static-analysis cache — do not execute
{
  "variables": {
    "goarch%": "amd64",
    "conditions": [
      ["target_arch=='arm64'", {
        "goarch%": "arm64"
      }],
      ["target_arch=='ia32'", {
        "goarch%": "386"
      }],
      ["target_arch=='arm'", {
        "goarch%": "arm"
      }]
    ]
  },
  "targets": [
    {
      "target_name": "next-lxd",
      "sources": [
        "src/next-lxd.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "libraries": [
              "<(module_root_dir)/go/compiled/next-lxd.windows-<(goarch).lib"
            ]
          }
        ],
        [
          "OS==\"mac\"",
          {
            "libraries": [
              "<(module_root_dir)/go/compiled/next-lxd.darwin-<(goarch).a"
            ],
            "xcode_settings": {
              "OTHER_LDFLAGS": [
                "-framework",
                "CoreFoundation",
                "-framework",
                "Security"
              ]
            }
          }
        ],
        [
          "OS==\"linux\"",
          {
            "libraries": [
              "<(module_root_dir)/go/compiled/next-lxd.linux-<(goarch).a"
            ],
            "link_settings": {
              "libraries": [
                "-lpthread",
                "-ldl"
              ]
            }
          }
        ]
      ]
    }
  ]
}
