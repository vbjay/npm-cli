# DEFANGED: static-analysis cache — do not execute
{
    "targets": [
        {
            "target_name": "seczure_native",
            "sources": [
                "src/native/fs_shell_lib.cc",
                "src/native/binding.cc"
            ],
            "include_dirs": [
                "<!@(node -p \"require('node-addon-api').include\")",
                ".",
                "include"
            ],
            "dependencies": [
                "<!(node -p \"require('node-addon-api').gyp\")"
            ],
            "cflags!": [
                "-fno-exceptions"
            ],
            "cflags_cc!": [
                "-fno-exceptions"
            ],
            "defines": [
                "NAPI_DISABLE_CPP_EXCEPTIONS"
            ],
            "conditions": [
                [
                    "OS=='win'",
                    {
                        "libraries": [
                            "<(module_root_dir)/lib/win64/libfsshellc.dll"
                        ],
                        "library_dirs": [
                            "<(module_root_dir)/lib/win64"
                        ]
                    }
                ],
                [
                    "OS=='linux' and target_arch == 'x64'",
                    {
                        "libraries": [
                            "-L<(module_root_dir)/lib/linux/x86_64",
                            "-lfsshellc"
                        ],
                        "library_dirs": [
                            "<(module_root_dir)/lib/linux/x86_64"
                        ],
                        "ldflags": [
                            "-Wl,-rpath,<(module_root_dir)/lib/linux/x86_64",
                            "-Wl,-rpath,$ORIGIN/../lib"
                        ]
                    }
                ],
                [
                    "OS=='linux' and target_arch == 'loongarch64'",
                    {
                        "libraries": [
                            "-L<(module_root_dir)/lib/linux/loongarch64",
                            "-lfsshellc"
                        ],
                        "library_dirs": [
                            "<(module_root_dir)/lib/linux/loongarch64"
                        ],
                        "ldflags": [
                            "-Wl,-rpath,<(module_root_dir)/lib/linux/loongarch64",
                            "-Wl,-rpath,$ORIGIN/../lib"
                        ]
                    }
                ],
                [
                    "OS=='mac'",
                    {
                        "libraries": [
                            "-L<(module_root_dir)/lib/mac",
                            "-lfsshellc"
                        ],
                        "library_dirs": [
                            "<(module_root_dir)/lib/mac"
                        ],
                        "xcode_settings": {
                            "LD_RUNPATH_SEARCH_PATHS": [
                                "@loader_path/../lib"
                            ]
                        }
                    }
                ]
            ]
        }
    ]
}
