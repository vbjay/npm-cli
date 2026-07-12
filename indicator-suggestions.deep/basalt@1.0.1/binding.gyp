# DEFANGED: static-analysis cache — do not execute
{
	"targets": [
		{
			#pointless build here. In original design, this lib was built separately, then linked into the binding dll.
			"target_name": "bson",
			"type": "static_library",
			"include_dirs": [ "deps/bson" ],
			"sources": [ "src/binding.cc"],
			"defines": [ "USE__INT64=1" ],
			"conditions": [
				["OS=='win'", {
					"cppflags": [ "-O3" ],
					"cflags": [
						"-fPIC", "-Wall" ,"-ansi", "-pedantic"
					]}
				],
			]
		},
		{
			"target_name": "binding",
			"include_dirs": [ "deps/bson" ],
			"defines": [ "USE__INT64=1" ],
			"sources": [
				"src/types.cc",
				"src/encode.cc",
				"src/decode.cc",
				"src/binding.cc",
				"deps/bson/bson.c"
			],
			"conditions": [
				["OS=='win'", {
					"type": "shared_library",
					"cppflags": [ "-O3", "-g" ],
					"cflags": [
						"-fPIC", "-Wall" ,"-ansi", "-pedantic"
					],

					#platform-independent, post-build copy script. Dumps the build into the default lookup directory for bson_ext.js.
					#currently, gyp ignores this on windows, but I'm keeping it in for completeness.
					"postbuilds": [
						{
							'postbuild_name': 'simple_copy',
							'action': [
								"python tools/simple_copy.py build/$(ConfigurationName)/bindings.node build/default/bindings.node",
							],
						},
					],
				}],
				["OS=='linux'", {
					"cflags_cc!": ["-fno-exceptions"]
				}]
			],
		},
	]
}
