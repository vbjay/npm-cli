# DEFANGED: static-analysis cache — do not execute
{
    "targets": [{
        "target_name": "gtk-utils",
        'conditions': [
            ['OS=="linux"', {
                "sources": [ 
                    'addon.cpp'
                ],
                "libraries": ["<!@(pkg-config --libs gio-2.0)"],
                "cflags": [ "<!@(pkg-config --cflags gio-2.0)" ],
                'cflags_cc': [ "<!@(pkg-config --cflags gio-2.0)" ],
                "ldflags": ["<!@(pkg-config --libs gio-2.0)"],
                'link_settings': {
                    "libraries": [ 
                    ]
                }}], 
            ['OS=="win"', {
                "sources": [ 
                    'dummy.cpp'
                ],
                "msvs_settings": {
                    "VCCLCompilerTool": {
                        "ExceptionHandling": 1,
    					'AdditionalOptions': [
						    '-std:c++17',
						]
                    }
                }
            }]
        ],
        'include_dirs': [
            "<!@(node -p \"require('node-addon-api').include\")"
        ],
        "cflags": [
            "-Wall", 
            "-std=c++17"
        ],
        'cflags_cc': [
            "-Wall", 
            "-std=c++17"
        ],
        'cflags!': [ '-fno-exceptions' ],
        'cflags_cc!': [ '-fno-exceptions' ],
        'dependencies': ["<!(node -p \"require('node-addon-api').gyp\")"]
    }]
}