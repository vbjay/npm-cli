# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "LeftTrim",
      "sources": [ "/src/LeftTrim.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}
