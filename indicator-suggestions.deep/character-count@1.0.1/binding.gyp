# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "CharacterCount",
      "sources": [ "/src/CharacterCount.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}
