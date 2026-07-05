# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "rcheevos",
      "sources": [
        "src/addon.cpp",
        "src/rcheevos/src/rhash/aes.c",
        "src/rcheevos/src/rhash/cdreader.c",
        "src/rcheevos/src/rhash/hash.c",
        "src/rcheevos/src/rhash/hash_disc.c",
        "src/rcheevos/src/rhash/hash_encrypted.c",
        "src/rcheevos/src/rhash/hash_rom.c",
        "src/rcheevos/src/rhash/hash_zip.c",
        "src/rcheevos/src/rhash/md5.c",
        "src/rcheevos/src/rc_util.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src/rcheevos/include",
        "src/rcheevos/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
