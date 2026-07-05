# DEFANGED: static-analysis cache — do not execute
{
  'variables': {
    'openssl_fips': ''
  },
  'targets': [{
    'target_name': 'bindings',
    'sources': [
      'src/serial.cpp'
    ],
    'include_dirs': ["<!(node -p \"require('node-addon-api').include_dir\")"],
    'cflags!': [ '-fno-exceptions' ],
    'cflags_cc!': [ '-fno-exceptions' ],
    "defines": ["NAPI_CPP_EXCEPTIONS"],
    'conditions': [
      ['OS=="win"',
        {
          'defines': ['CHECK_NODE_MODULE_VERSION'],
          'sources': [
            'src/serial_win.cpp'
          ],
          'msvs_settings': {
            'VCCLCompilerTool': {
              'ExceptionHandling': '1',
              'DisableSpecificWarnings': [ '4530', '4506' ],
            }
          }
        }
      ],
      ['OS=="mac"',
        {
          'sources': [
            'src/serial_unix.cpp',
            'src/poller.cpp',
            'src/darwin_list.cpp'
          ],
          'xcode_settings': {
            'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
            'MACOSX_DEPLOYMENT_TARGET': '10.9',
            'OTHER_CFLAGS': [
              '-arch x86_64',
              '-arch arm64'
            ],
            'OTHER_LDFLAGS': [
              '-framework CoreFoundation',
              '-framework IOKit',
              '-arch x86_64',
              '-arch arm64'
            ]
          }
        }
      ],
      ['OS=="linux"',
        {
          'sources': [
            'src/serial_unix.cpp',
            'src/poller.cpp',
            'src/serial_linux.cpp'
          ]
        }
      ],
      ['OS=="android"',
        {
          'sources': [
            'src/serial_unix.cpp',
            'src/poller.cpp',
            'src/serial_linux.cpp'
          ]
        }
      ],
      ['OS!="win"',
        {
          'sources': [
            'src/serial_unix.cpp',
            'src/poller.cpp'
          ]
        }
      ]
    ]
  }],
}
