# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ],
      "target_name": "addon",
      "sources": [ "main.cpp" ]
    }
  ]
}