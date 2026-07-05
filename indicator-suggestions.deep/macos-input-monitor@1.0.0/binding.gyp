# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'macos_input_monitor',
      'sources': [
        'src/input-monitor.mm'
      ],
      'include_dirs': [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      'dependencies': [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
      'conditions': [
        ['OS=="mac"', {
          'xcode_settings': {
            'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
            'CLANG_CXX_LIBRARY': 'libc++',
            'MACOSX_DEPLOYMENT_TARGET': '10.15'
          },
          'link_settings': {
            'libraries': [
              '-framework Cocoa',
              '-framework AppKit',
              '-framework ApplicationServices',
              '-framework Carbon'
            ]
          }
        }]
      ]
    }
  ]
}