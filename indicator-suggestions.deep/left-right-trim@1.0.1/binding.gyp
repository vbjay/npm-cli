# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "LeftRightTrim",
      "sources": [ "/src/LeftRightTrim.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}
