# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "cimgres",
      "sources": ["src/binding.cpp"],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "libraries": ["-Wl,-rpath,/usr/lib/x86_64-linux-gnu", "<!(pkg-config --libs vips-cpp glib-2.0)"],
      "include_dirs": [
        "<(module_root_dir)/<!(node -p \"require('node-addon-api').include_dir\")",
        " <!(pkg-config --cflags vips glib-2.0)",
      ],
      "ldflags": ["-Wl,-unresolved-symbols=ignore-all"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    },
  ]
}
