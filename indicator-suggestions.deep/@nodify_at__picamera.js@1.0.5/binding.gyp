# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "picamera.js",
      "product_name": "picamera.js",
      "cflags!": [ "-fno-exceptions", "-fno-rtti" ],
      "cflags_cc!": [ "-fno-exceptions", "-fno-rtti" ],
      "cflags_cc": [
        "-std=c++20",
        "-O2",
        "-march=armv8.2-a+crc+simd+fp16+rcpc+dotprod",
        "-mtune=cortex-a76",
        "-mcpu=cortex-a76",
        "-pthread",
        "-fPIC",
        "-ffast-math",
        "-funroll-loops",
        "-fomit-frame-pointer",
        "-DNAPI_DISABLE_CPP_EXCEPTIONS",
        "-DNDEBUG",
        "-DARM64_BUILD",
        "-DPI5_OPTIMIZED",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fvisibility=hidden",
        "-fvisibility-inlines-hidden"
      ],
      "ldflags": [
        "-pthread",
        "-Wl,--gc-sections",
        "-Wl,--strip-all",
        "-Wl,-O2",
        "-Wl,--as-needed"
      ],
      "sources": [
        "src/node_binding.cpp",
        "src/core/camera_manager.cpp",
        "src/core/control_manager.cpp",
        "src/core/stream_manager.cpp",
        "src/encoders/jpeg_encoder.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src/include",
        "/usr/include/libcamera"
      ],
      "libraries": [
        "<!@(pkg-config --libs libcamera)",
        "-lturbojpeg"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=9",
        "_GNU_SOURCE",
        "ARM64_BUILD",
        "PI5_OPTIMIZED",
        "NODE_ADDON_API_DISABLE_MAYBE"
      ],
      "conditions": [
        ["OS=='linux' and target_arch=='arm64'", {
          "cflags_cc": [
            "-DLINUX_ARM64"
          ]
        }],
        ["OS!='linux' or target_arch!='arm64'", {
          "sources": []
        }]
      ]
    }
  ]
}