# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "RepeatText",
      "sources": [ "/src/RepeatText.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}
