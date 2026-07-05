# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "minimizer",
      "sources": [ "src/minimizer.cc" ],
      "include_dirs": [ "<!(node -e \"require('nan')\")" ]
    }
  ]
}
