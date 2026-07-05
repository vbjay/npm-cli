#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1

# This script is solely for NPM installs, to be run after the initial "npm install"
# it is not used for travis tests, see travisScript.sh for that


# TODO: Work out a way to automatically add the plugin name to the <root>/config/api.js in general.paths []


# We'll wrap this in a condition so it can't fail - e.g. on travis
if [ -e ./config/ah-tdp-auth-plugin-config.js ]
	then 
		# Create (AH) config/plugins dir if it doesn't exist
		mkdir -p "../../config/plugins";

		# copy config file to AH
		cp ./config/ah-tdp-auth-plugin-config.js ../../config/plugins/ah-tdp-auth-plugin-config.js;
fi