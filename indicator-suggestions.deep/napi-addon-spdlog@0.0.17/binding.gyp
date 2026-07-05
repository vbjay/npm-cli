# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'napi_addon_spdlog',
      'sources': [ 'src/logger.cc', 'src/main.cc' ],
      'include_dirs': ["<!@(node -p \"require('node-addon-api').include\")", "deps"],
      'dependencies': ["<!(node -p \"require('node-addon-api').gyp\")"],
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'xcode_settings': {
        'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7'
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      }
    }
  ]
}