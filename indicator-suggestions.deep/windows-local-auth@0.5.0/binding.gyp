# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'windows_local_auth',
      'product_extension': 'node',
      'type': 'loadable_module',
      'include_dirs': [
        "<!(node -e \"require('nan')\")"
      ],
            'defines': [
              '_UNICODE',
              'UNICODE',
            ],
            'configurations': {
              'Release': {
                'msvs_settings': {
                  'VCCLCompilerTool': {
                    'ExceptionHandling': 1,
                  }
                }
              }
            },
      'sources': [
        'src/binding.cpp'
      ]
    }
  ]
}
