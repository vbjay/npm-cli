# DEFANGED: static-analysis cache — do not execute
{
	"targets": [{
		"target_name": "binding",
		"sources": [
			"binding.cc"
		],
		"include_dirs": [
			"<!(node -e \"require('nan')\")"
		]
	}]
}
