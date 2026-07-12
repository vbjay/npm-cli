# DEFANGED: static-analysis cache — do not execute
{
	"targets": [
		{
			"target_name": "addon",
			"sources": [],
			"defines": [
				"UNICODE"
			],
			"include_dirs": [
				"<!(node -e \"require('nan')\")"
			],
			"conditions": [
				[ "OS=='win'",
					{
						"sources": [
							"lib/clipboard.cc"
						],
					}
				]
			]
		}
	]
}