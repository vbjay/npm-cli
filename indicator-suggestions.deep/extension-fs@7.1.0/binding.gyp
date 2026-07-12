# DEFANGED: static-analysis cache — do not execute
{
    "targets": [{
        "target_name": "extension-fs",
        "sources": [ 
            'addon.cpp',
            'nullfunction.cpp',
            'exif_reader.cpp',
            'get_line_count_worker.cpp',
            'get_lines_worker.cpp',
            'text_reader.cpp'
        ],
        'include_dirs': [
            "<!@(node -p \"require('node-addon-api').include\")",
            "<!@(node -p \"var a = require('node-addon-api').include; var b = a.substr(0, a.length - 15); b + 'event-source-base' + a[a.length-1]\")"
        ],
        'dependencies': ["<!(node -p \"require('node-addon-api').gyp\")"],
        "cflags": ["-Wall", "-std=c++17"],
        'cflags_cc': ["-Wall", "-std=c++17"],
        'cflags!': [ '-fno-exceptions' ],
        'cflags_cc!': [ '-fno-exceptions' ],
        'link_settings': {
            "libraries": [ 
                "gdiplus.lib",
                "Mincore.lib"
            ]
        },            
        'conditions': [
            ['OS=="win"', {
                'defines': [
                    'WINDOWS', 
                    '_SILENCE_CXX17_CODECVT_HEADER_DEPRECATION_WARNING' 
                ],
                "msvs_settings": {
                    "VCCLCompilerTool": {
                        "ExceptionHandling": 1,
    					'AdditionalOptions': [
						    '-std:c++17',
						]
                    }
                },
                'sources': [
                    'get_drives_worker.cpp',
                    'get_icon_worker.cpp',
                    'get_file_version_worker.cpp',
                    'create_directory_worker.cpp',
                    'get_conflicts_worker.cpp',
                    'get_net_shares_worker.cpp',
                    'rename_worker.cpp',
                    'delete_files_worker.cpp',
                    'copy_worker.cpp',
                    'std_utils.cpp',
                    'windows/utils.cpp',
                    'windows/get_icon.cpp',
                    'windows/shell.cpp',
                    'windows/get_conflicts.cpp',
                    'windows/services.cpp',
                    'windows/get_files_worker.cpp',
                    'windows/get_exif_date_worker.cpp',
                ]                
            }],
            ['OS=="linux"', {
                'defines': ['LINUX'],
                'libraries!': [ 
                    "gdiplus.lib",
                    "Mincore.lib"
                ],
                'sources': [ 
                    'linux/get_files_worker.cpp',
                    'linux/get_exif_date_worker.cpp',
                ]
            }],
        ]          
    }]
}

