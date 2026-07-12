# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'kms',
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [
        '-lssl -lcrypto',
        "<(module_root_dir)/src/whitebox/lib/libydwbcrypto.a" # 静态链接依赖库
      ],
      # "link_settings": {
      #   "libraries": [
      #     '-L/data/work/incubator-group/incubator/packages/kms-node/src/whitebox/lib -lydwbcrypto'
      #   ]
      # },
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      'sources': [
        'src/init.cc'
      ]
    }
  ]
}