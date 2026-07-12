# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "FillNumber",
      "sources": [ "/src/FillNumber.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}
