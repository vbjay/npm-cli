# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "expand",
      "sources": ["src/expand.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-api-headers').include_dir\")",
        "/usr/local/include",
        "/usr/include"
      ],
      "libraries": ["-lpostal"],
      "cflags": ["-Wall", "-Wextra", "-std=c99"],
      "defines": ["NAPI_VERSION=8"]
    },
    {
      "target_name": "parser",
      "sources": ["src/parser.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-api-headers').include_dir\")",
        "/usr/local/include",
        "/usr/include"
      ],
      "libraries": ["-lpostal"],
      "cflags": ["-Wall", "-Wextra", "-std=c99"],
      "defines": ["NAPI_VERSION=8"]
    }
  ]
}
