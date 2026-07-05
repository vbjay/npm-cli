# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "realsense",
      "sources": ["src/realsense.cpp"],
      "include_dirs": [
        "<!(node -e \"require('nan')\")", 
        "/usr/local/include", 
        "/opt/homebrew/include"
      ],
      "libraries": [
        "-L/usr/local/lib", 
        "-L/opt/homebrew/lib", 
        "-lrealsense2"
      ],
      "cflags": [
        "-std=c++17", 
        "-fexceptions", 
        "-frtti"
      ],
      "cflags_cc": [
        "-std=c++17", 
        "-fexceptions", 
        "-frtti"
      ],
      "conditions": [
        ['OS=="mac"', {
          "cflags": [
            "-fno-exceptions=false"
          ],
          "cflags_cc": [
            "-fno-exceptions=false"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "OTHER_CFLAGS": [
              "-fexceptions",
              "-frtti"
            ]
          }
        }],
      ]
    }
  ]
}