# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'blsct',
      'include_dirs': [
         '<(module_root_dir)/navio-core/src/bls/include',
         '<(module_root_dir)/navio-core/src/bls/mcl/include',
         '<(module_root_dir)/navio-core/src',
      ],
      'sources': [
        './swig/blsct_wrap.cxx',
      ],
      'link_settings': {
        'library_dirs': [
          '<(module_root_dir)/libs'
        ],
        'libraries': [
          '-lblsct',
          '-lunivalue_blsct',
          '-lbls384_256',
          '-lmcl'
        ]
      },
      'cflags_cc': ['-std=c++20', '-fPIC', '-fexceptions'],
      'xcode_settings': {
        'CLANG_CXX_LANGUAGE_STANDARD': 'c++20 -fexceptions',
        'OTHER_CFLAGS': ['-std=c++20 -fexceptios'],
        'OTHER_CPLUSPLUSFLAGS': ['-std=c++20', '-fexceptions'],
			  'OTHER_LDFLAGS': [
        ],
			  'OTHER_LDFLAGS!': [
        ],
      }
    }
  ]
}
