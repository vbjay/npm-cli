# DEFANGED: static-analysis cache — do not execute
{
    "conditions": [
        ['OS=="win"', {
            "targets": [
                {
                    "target_name": "rinku_native_addons_win32",
                    "sources": ["lib/windows.cc"],
                    "include_dirs": [
                        "<!@(node -p \"require('node-addon-api').include\")"
                    ],
                    "defines": [
                        "NAPI_DISABLE_CPP_EXCEPTIONS"
                    ]
                }
            ]
        }]
    ]
}