# DEFANGED: static-analysis cache — do not execute
{
	'targets': [{
		'target_name': 'gles',
		'sources': [
			'src/module.cpp',
			'src/egl_context.cpp',
			'src/gl_bindings.cpp',
		],
		'dependencies': [
			"<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
		],
		'defines': [
			'NAPI_VERSION=<(napi_build_version)',
			'NODE_ADDON_API_DISABLE_DEPRECATED',
		],
		'cflags': [ '-Werror', '-Wall', '-Wextra' ],
		'conditions': [
			['OS == "linux"', {
				'cflags_cc': [ '-std=c++17' ],
				'libraries': [ '-lEGL', '-lGLESv2' ],
			}],
			['OS == "mac"', {
				'cflags_cc': [ '-std=c++17' ],
				'xcode_settings': { 'OTHER_CFLAGS': [ '-std=c++17' ] },
				'include_dirs': [ '$(ANGLE_INC)' ],
				'libraries': [ '-L$(ANGLE_LIB)', '-lEGL', '-lGLESv2' ],
				'link_settings': {
					'libraries': [ '-Wl,-rpath,@loader_path' ],
				},
			}],
			['OS == "win"', {
				'msvs_settings': {
					'VCCLCompilerTool': {
						'AdditionalOptions': [ '-std:c++17' ],
					},
				},
				'include_dirs': [ '<!(echo %ANGLE_INC%)' ],
				'libraries': [
					'-l<!(echo %ANGLE_LIB%)\\libEGL.lib',
					'-l<!(echo %ANGLE_LIB%)\\libGLESv2.lib',
				],
			}],
		],
	}],
}
