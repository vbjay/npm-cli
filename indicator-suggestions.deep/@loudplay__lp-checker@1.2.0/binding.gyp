# DEFANGED: static-analysis cache — do not execute
{
    "targets":[
        {
            "target_name":"<(module_name)",
            "sources":[
                "src/common_export.cpp"
            ],
            "include_dirs":[
                "<!(node -p \"require('node-addon-api').include_dir\")",
                "include",
                "src"
            ],
            "defines":[
                'NAPI_CPP_EXCEPTIONS',
                'NAPI_VERSION=<(napi_build_version)'
            ],
            "cflags":[
                '-std=c++17',
                '-fexceptions',
                '-frtti'
            ],
            "cflags!":[
                '-fno-exceptions',
                '-fno-rtti'
            ],
            "cflags_cc!":[
                '-fno-exceptions',
                '-fno-rtti'
            ],
            "msvs_settings":{
                "VCCLCompilerTool":{
                    'ExceptionHandling':'1', # \EHsc
                    "AdditionalOptions":[
                        "/std:c++17"
                    ]
                }
            },
            "xcode_settings":{
                "CLANG_CXX_LANGUAGE_STANDARD":"c++17",
                "GCC_ENABLE_CPP_EXCEPTIONS":"YES",
                # "LD_RUNPATH_SEARCH_PATH":"@executable_path",
                # "OTHER_LDFLAGS":[
                #     "-undefined dynamic_lookup"
                # ]
            },
            "win_delay_load_hook":"true",
            "conditions":[
                [
                    'OS == "win"',
                    {
                        "sources":[
                            "src/export_win.cpp",
                        ],
                        "libraries":[
                            "Wlanapi",
                            "PowrProf",
                            "Iphlpapi",
                            "Wininet",
                            "dxgi",
                            "D3D11",
                            "D3d9",
                            "../checker_static.lib"
                        ],
                    }
                ],
                [
                    'OS == "mac"',
                    {
                        "sources":[
                            "src/export_mac.cpp",
                        ],
                        "libraries":[
                            "../libchecker_static_mac.a",
                            "../libchecker_swift.dylib"
                        ],
                        "copies":[
                            {
                                "files":[
                                    "libchecker_swift.dylib",
                                    "checker.libs"
                                ],
                                "destination":"<(module_path)"
                            }
                        ],
                        "link_settings":{
                            "libraries":[
                                "-Wl,-rpath,@loader_path"
                            ]
                        },
                        "actions": [
                            {
                                'action_name': 'bundle_dylib_deps',
                            'inputs': [
                                # Re-bundle on every install
                                '<(module_path)/../../libchecker_swift.dylib'
                            ],
                            'outputs': [
                                # There will be much more libraries, but we know that this one
                                # will be there for sure. It's enough to trigger rerun of this
                                # action if libchecker_swift.dylib changes.
                                '<(module_path)/checker.libs/libswiftCore.dylib'
                            ],
                            'action': [
                                'node',
                                '<(module_path)/../../tools/bundle_dylib_deps.js',
                                '<(module_path)/../../libchecker_swift.dylib',
                                '<(module_path)/../../checker.libs'
                            ]
                            }
                        ]
                    }
                ]
            ]
        },
        {
            "target_name":"action_after_build",
            "type":"none",
            "dependencies":[
                "<(module_name)"
            ],
            "copies":[
                {
                    "files":[
                        "<(PRODUCT_DIR)/<(module_name).node"
                    ],
                    "destination":"<(module_path)"
                }
            ]
        }
    ]
}
