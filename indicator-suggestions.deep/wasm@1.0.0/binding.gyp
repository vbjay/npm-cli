# DEFANGED: static-analysis cache — do not execute
{
    "targets": [{
        "target_name"  : "wasm"
      , "include_dirs" : [
            "<!(node -p -e \"require('path').dirname(require.resolve('nan'))\")"
        ]
      , "cflags_cc!"   : [
            "-std=gnu++0x"
        ]
      , "cflags_cc"   : [
            "-std=c++11"
        ]
      , "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD" : "c++11"
          , "MACOSX_DEPLOYMENT_TARGET"    : "10.9"
        }
      , "defines"      : [ ]
      , "sources"      : [
            "src/polyfill/unpack.cpp"
          , "src/wasm.cpp"
        ]
    }]
}
