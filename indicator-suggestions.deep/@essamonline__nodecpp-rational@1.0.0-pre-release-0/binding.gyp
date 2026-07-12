# DEFANGED: static-analysis cache — do not execute
{
	'targets':  [                                    # The list of targets for which this .gyp file can generate builds.
		{
			'target_name': 'rational',               # The name of a target being defined.
			'sources'  : [                           # A list of source files that are used to build this target.
				'src/rational-addon.cpp',
				'src/addon.cpp'
			],
			'cflags'   : [
				'-Wall',
				'-std=c++11',
				'-fexceptions'
			],
			'cflags_cc': [
				'-fexceptions'
			],
			'xcode_settings': {
				'OTHER_CFLAGS': [
					'-Wall',
					'-std=c++11',
					'-fexceptions'
				]
			},
			'msvs_settings': {
				'VCCLCompilerTool': {
					'ExceptionHandling': 1 # /EHsc
				}
			},
			'configurations': {
				'Release': {
					'msvs_settings': {
						'VCCLCompilerTool': {
							'ExceptionHandling': 1,
						}
					}
				}
			},
			"conditions": [
				[ 'OS=="mac"', {
					"xcode_settings": {
							'OTHER_CPLUSPLUSFLAGS' : ['-std=c++11','-stdlib=libc++'],
							'OTHER_LDFLAGS': ['-stdlib=libc++'],
							'MACOSX_DEPLOYMENT_TARGET': '10.7'
						}
					}
				]
			]
		}
	]
}
