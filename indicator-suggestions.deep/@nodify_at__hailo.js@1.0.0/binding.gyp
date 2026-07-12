# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "hailo.js",
      "sources": [
        "src/addon.cpp",
        "src/hailo_device.cpp",
        "src/detection_utils.cpp"
      ],
      "include_dirs": [
        "/usr/include/hailort",
        "/opt/hailo/include",
        "./src/include",
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags_cc": [
        "-std=c++20",
        "-O3",
        "-march=armv8.2-a+fp16+rcpc+dotprod+crypto",
        "-mtune=cortex-a76",
        "-ffast-math",
        "-funroll-loops",
        "-finline-functions",
        "-ftree-vectorize",
        "-fprefetch-loop-arrays",
        "-fomit-frame-pointer",
        "-flto",
        "-fno-rtti",
        "-pipe",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fexceptions"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NODE_ADDON_API_ENABLE_MAYBE",
        "ARM_NEON",
        "NDEBUG",
        "NAPI_VERSION=9"
      ],
      "link_settings": {
        "libraries": ["-lhailort"],
        "ldflags": [
          "-O3",
          "-flto",
          "-Wl,--as-needed",
          "-Wl,--gc-sections"
        ]
      },
      "conditions": [
        ["OS=='linux' and target_arch=='arm64'", {
          "cflags_cc": [
            "-mcpu=cortex-a76"
          ]
        }]
      ]
    }
  ]
}