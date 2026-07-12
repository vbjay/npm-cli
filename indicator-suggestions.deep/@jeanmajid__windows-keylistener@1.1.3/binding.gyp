# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "keylistener",
      "sources": [ "keylistener.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}