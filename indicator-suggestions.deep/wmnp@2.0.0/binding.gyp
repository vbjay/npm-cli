# DEFANGED: static-analysis cache — do not execute
{
	"targets": [{
		"target_name": "wmnp",
		"sources": [
			"src/WmnpWindow.cc",
			"src/Wmnp.cc"
		],
		"include_dirs": [
			"<!@(node -p \"require('node-addon-api').include\")",
			"<(node_root_dir)/include/node"
		],
		"conditions": [
			['OS=="win"', {
				"msvs_settings": {
					"VCCLCompilerTool": {
						"ExceptionHandling": 1
					}
				},
				"libraries": [
					"user32.lib"
				]
			}]
		],
		"defines": [
			"NAPI_DISABLE_CPP_EXCEPTIONS"
		],
		"cflags!": ["-fno-exceptions"],
		"cflags_cc!": ["-fno-exceptions"],
		"xcode_settings": {
			"GCC_ENABLE_CPP_EXCEPTIONS": "YES",
			"CLANG_CXX_LIBRARY": "libc++",
			"MACOSX_DEPLOYMENT_TARGET": "10.7"
		}
	}]
}