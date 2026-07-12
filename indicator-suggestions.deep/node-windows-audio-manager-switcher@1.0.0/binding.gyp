# DEFANGED: static-analysis cache — do not execute
{
    "variables": {"openssl_fips": ""},
    "targets": [
        {
            "target_name": "addon",
            "sources": [
                "native/src/addon.cpp",
                "native/src/AudioSwitcher/AudioSwitcher.cpp",
                "native/src/Utility/DeviceUtils.cpp",
                "native/src/Utility/COMInitializer.cpp",
            ],
            "include_dirs": [
                "native/include",
                "node_modules/node-addon-api",
                "<!(node -p \"require('node-addon-api').include\")",
                "<!(node -p \"require('node-addon-api').include_dir\")",
                "<!(node -p \"require('node-addon-api').include.replace(/\\/include$/, '') + '/include/node')\"",
            ],
            "defines": ["NAPI_CPP_EXCEPTIONS"],
            "cflags_cc": ["/std:c++17"],
            "conditions": [
                [
                    "OS=='win'",
                    {
                        "msvs_settings": {
                            "VCCLCompilerTool": {
                                "ExceptionHandling": 1,
                                "RuntimeLibrary": 2,
                            },
                            "PlatformToolset": "v143",
                        },
                        # "msvs_windows_target_platform_version": "10.0.26100.0"
                    },
                ]
            ],
        }
    ],
}
