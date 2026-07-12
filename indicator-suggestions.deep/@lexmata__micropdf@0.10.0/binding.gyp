# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "micropdf",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "native/micropdf.cc",
        "native/context.cc",
        "native/document.cc",
        "native/page.cc",
        "native/stext.cc",
        "native/annot.cc",
        "native/form.cc",
        "native/display_list.cc",
        "native/link.cc",
        "native/cookie.cc",
        "native/device.cc",
        "native/path.cc",
        "native/pixmap.cc",
        "native/image.cc",
        "native/colorspace.cc",
        "native/font.cc",
        "native/stream.cc",
        "native/output.cc",
        "native/enhanced.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "native/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='linux'", {
          "libraries": [
            "<(module_root_dir)/native/lib/linux-<(target_arch)/libmicropdf.a",
            "-lpthread",
            "-ldl",
            "-lm"
          ],
          "cflags": ["-fPIC"]
        }],
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/native/lib/darwin-<(target_arch)/libmicropdf.a",
            "-framework CoreFoundation",
            "-framework Security"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }],
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/native/lib/win32-<(target_arch)/micropdf.lib",
            "ws2_32.lib",
            "userenv.lib",
            "bcrypt.lib",
            "ntdll.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            }
          }
        }]
      ]
    }
  ]
}

