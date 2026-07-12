# DEFANGED: static-analysis cache — do not execute
{
  "targets": [{
    "target_name": "pty",
    "cflags!": [ "-fno-exceptions" ],
    "cflags_cc!": [ "-fno-exceptions" ],
    "cxxflags!": ["-fno-exceptions"],
    "cflags": ["-std=c++17"],
    "sources": [ "pty.cpp" ],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    
  }]
} 
