# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "wson_addon",
      "sources": [
        "src/stringifier_target.cc",
        "src/stringifier.cc",
        "src/parser_source.cc",
        "src/parser.cc",
        "src/wson.cc"
      ],
      "include_dirs": [ "<!(node -e \"require('nan')\")" ],
      "cflags": []
    }
  ]
}
