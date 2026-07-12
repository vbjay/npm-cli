# DEFANGED: static-analysis cache — do not execute
{
    "targets": [
        {
            "target_name": "binding",
            "sources": ["<!@(ls -1 src/discord/*.cpp)", "<!@(ls -1 src/*.cc)"],
            'include_dirs': ["<!(node -p \"require('node-addon-api').include_dir\")"],
            'cflags!': ['-fno-exceptions'],
            'cflags_cc!': ['-fno-exceptions'],
            'xcode_settings': {
                'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
                'CLANG_CXX_LIBRARY': 'libc++',
                'MACOSX_DEPLOYMENT_TARGET': '10.7',
            },
            'msvs_settings': {
                'VCCLCompilerTool': {'ExceptionHandling': 1},
            },
            "conditions": [
                ["OS == 'win'", {
                    "link_settings": {
                        "libraries": [
                            "-l<(module_root_dir)/lib/discord_game_sdk.dll.lib"
                        ],
                        "copies":[{
                            "destination": "<(module_root_dir)/build/Release",
                            "files": ["<(module_root_dir)/lib/discord_game_sdk.dll"]
                        }]
                    }
                }],
                ["OS == 'mac'", {
                    "link_settings": {
                        "libraries": [
                            "-Wl,-rpath,<(module_root_dir)/lib",
                            "-Wl,-rpath,@executable_path/../Resources",
                            "-Wl,-rpath,@executable_path/../Frameworks",
                            "<(module_root_dir)/lib/discord_game_sdk.dylib"
                        ]
                    }
                }],
                ["OS == 'linux'", {
                    "link_settings": {
                        "libraries": [
                            "<(module_root_dir)/lib/discord_game_sdk.so"
                        ]
                    }
                }]
            ]
        }
    ]
}
