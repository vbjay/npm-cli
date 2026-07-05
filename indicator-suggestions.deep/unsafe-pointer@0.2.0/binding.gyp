# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "node_unsafe_pointer",
      "sources": [
        "src/binding.c"
      ],
      "defines": [
        "NAPI_VERSION=6"
      ]
    }
  ]
}
