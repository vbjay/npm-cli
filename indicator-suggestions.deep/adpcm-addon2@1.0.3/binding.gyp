# DEFANGED: static-analysis cache — do not execute
{
  # node-api
  "targets": [
    {
      "target_name": "adpcm",
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "sources": [ "adpcm.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": [
        # "<!(node -p \"require('node-addon-api').targets\")"
      ],
      "link_settings": {
        "library_dirs": [],
        "libraries": []
      }
    }
  ]

  # Nan
  # "targets": [
  #   {
  #     "target_name": "adpcm",
  #     "sources": [ "adpcm.cpp" ],
  #     "include_dirs": [
  #       "<!(node -e \"require('nan')\")"
  #     ]
  #   }
  # ]
}