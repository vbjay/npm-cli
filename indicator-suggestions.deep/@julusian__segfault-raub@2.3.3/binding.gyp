# DEFANGED: static-analysis cache — do not execute
{
	'variables': {
		'arch': '<!(node -p "process.arch")',
	},
	'targets': [{
		'target_name': 'julusian_segfault_handler',
		'sources': [
			'src/cpp/bindings.cpp',
			'src/cpp/segfault-handler.cpp',
		],
		'include_dirs': [
			'<!@(node -p "require(\'addon-tools-raub\').getInclude()")',
		],
		'cflags_cc': ['-std=c++17', '-fno-exceptions'],
		'cflags': ['-O0', '-funwind-tables', '-fno-exceptions'],
		'conditions': [
			['OS=="linux"', {
				'defines': ['__linux__'],
				'conditions': [
					['"<(arch)"=="arm64"', {
						'libraries': ['-lstdc++fs'],
					}],
				],
			}],
			['OS=="mac"', {
				'MACOSX_DEPLOYMENT_TARGET': '10.9',
				'defines': ['__APPLE__'],
				'CLANG_CXX_LIBRARY': 'libc++',
				'OTHER_CFLAGS': ['-std=c++17', '-O0', '-funwind-tables', '-fno-exceptions'],
			}],
			['OS=="win"', {
				'defines': ['WIN32_LEAN_AND_MEAN', 'VC_EXTRALEAN', '_WIN32', '_HAS_EXCEPTIONS=0'],
				'sources': ['src/cpp/stack-windows.cpp'],
				'msvs_settings': {
					'VCCLCompilerTool': {
						'AdditionalOptions' : [
							'/GL', '/GF', '/EHa-s-c-', '/GS', '/Gy', '/GR-', '/std:c++17',
						],
					},
					'VCLinkerTool': {
						'AdditionalOptions' : ['/DEBUG:NONE', '/LTCG', '/OPT:NOREF'],
					},
				},
			}],
		],
	}],
}
