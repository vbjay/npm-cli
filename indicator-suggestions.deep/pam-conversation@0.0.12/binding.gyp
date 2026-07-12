# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "PAMConversation",
      "sources": [ "src/PamConversation.cc" ],
      "link_settings": {
        "libraries": ["-lpam"]
      }
    }
  ]
}