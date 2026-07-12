# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "accelerate",
      "sources": ["accelerate.cc"],
      "conditions": [
        ["OS=='mac'", {
          "link_settings": {
            "libraries": [
              "-framework Accelerate"
            ]
          },
          "xcode_settings": {
            "OTHER_CFLAGS": [
              "-mcpu=apple-m4",
              "-mtune=apple-m4",
              "-O3"
            ]
          }
        }]
      ]
    }
  ]
}
