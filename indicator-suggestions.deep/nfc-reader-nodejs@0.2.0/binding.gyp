# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "pcsc",      
      "sources": [ "pcsc.cc" ], 
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "conditions": [
        ['OS=="win"', {
          "libraries": [
            "-lWinscard" 
          ],
           # Windows için MSVC derleyici ayarları
          'msvs_settings': {
            'VCCLCompilerTool': {
               # /EHsc bayrağına karşılık gelir (C++ istisnalarını etkinleştirir)
              'ExceptionHandling': 1
            }
          }
        }],

        
        ['OS=="linux"', {
          "libraries": [
            "-lpcsclite" 
          ],
           # Linux için GCC/Clang derleyici ayarları (genellikle varsayılanlar yeterlidir)
           # C++ istisnaları genellikle varsayılan olarak etkindir.
        }],

        
        ['OS=="mac" or OS=="darwin"', { 
          "libraries": [
             "-lpcsclite" 
             
             
          ],
           # macOS için Xcode/Clang ayarları
          'xcode_settings': {
             # Clang'de C++ istisnalarını etkinleştir
            'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
             # C++ standart kütüphanesini belirt (genellikle libc++)
            'CLANG_CXX_LIBRARY': 'libc++',
             # Minimum macOS sürümünü belirt (isteğe bağlı ama iyi pratik)
            'MACOSX_DEPLOYMENT_TARGET': '10.9', 
          },
          # gyp'nin macOS'ta varsayılan olarak eklediği -fno-exceptions bayrağını kaldır
          'cflags!': [ '-fno-exceptions' ],
          'cflags_cc!': [ '-fno-exceptions' ],
        }]
      ], 
      

      
      
      
      
      

      
      # 'cflags': [],
      # 'cflags_cc': [],

    }
  ]
} 