# DEFANGED: static-analysis cache — do not execute
{
    "variables": {
        "library_files": [
            "lib/ccrypto_fn.js",
            "lib/ccrypto_js.js"
        ]
    },
    "conditions": [
        [
            "OS=='win'", 
            { "variables": { "ONI_Root%": "../" } }, 
            { "variables": { "ONI_Root%": "" } }
        ]
    ], 
    "targets": [
        {
            "cflags": [ "-O3" ], 
            "cflags!": [ "-fno-exceptions" ], 
            "cflags_cc!": [ "-fno-exceptions" ], 
            "conditions": [
                [
                    "OS=='mac'", 
                    {
                        "xcode_settings": {
                            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
                        }
                    }
                ]
            ], 
            "include_dirs": ["src"],
            "sources": [
                "src/ccrypto.cpp",
                "src/ccrypto_fn.cpp",
                "src/ccrypto_fn_bindings.cpp"
            ], 
            "target_name": "ccrypto"
        },
        {
            "cflags": [ "-O3" ], 
            "cflags!": [ "-fno-exceptions" ], 
            "cflags_cc!": [ "-fno-exceptions" ], 
            "conditions": [
                [
                    "OS=='mac'", 
                    {
                        "xcode_settings": {
                            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
                        }
                    }
                ]
            ], 
            "include_dirs": ["src"],
            "sources": [
                "src/ccrypto.cpp",
                "src/ccrypto_fn.cpp",
                "src/ccrypto_fn_speed_test.cpp",
                "src/ccrypto_fn_bindings_speed_test.cpp"
            ], 
            "target_name": "ccrypto_speed_tests"
        },
        {
            "cflags": [ "-O3" ], 
            "cflags!": [ "-fno-exceptions" ], 
            "cflags_cc!": [ "-fno-exceptions" ], 
            "conditions": [
                [
                    "OS=='mac'", 
                    {
                        "xcode_settings": {
                            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
                        }
                    }
                ]
            ], 
            "include_dirs": ["src"],
            "sources": [
                "src/ccrypto.cpp",
                "src/ccrypto_fn.cpp",
                "src/ccrypto_fn_bindings.cpp"
            ], 
            "type": "static_library",
            "include_dirs": [
                "src",
            ],
            "all_dependent_settings": {
                "include_dirs": [
                    "src",
                ],
            },
            "target_name": "ccrypto_lib"
        }
    ]
}
