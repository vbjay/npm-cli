# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "say_hello_addon",
      "sources": [
     	  "src/main.cpp"
		],
      "include_dirs": [
      "src"
       ]
    },
	{
	  "target_name": "action_after_build",
	  "type": "none",
	  "dependencies": [ "<(module_name)" ],
	  "copies": [{
	     "files": [ "<(PRODUCT_DIR)/<(module_name).node" ],
	     "destination": "<(module_path)"
	   }]
	}
	
	]
}