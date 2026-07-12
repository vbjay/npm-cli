# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "muparser_node",
      "sources": [
        "src/muparser_node.cpp",
        "muparser/src/muParser.cpp",
        "muparser/src/muParserBase.cpp",
        "muparser/src/muParserBytecode.cpp",
        "muparser/src/muParserCallback.cpp",
        "muparser/src/muParserError.cpp",
        "muparser/src/muParserTokenReader.cpp"
      ],
      "include_dirs": [
        "muparser/include",
        "node_modules/node-addon-api",
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "MUPARSER_STATIC",
        "NAPI_CPP_EXCEPTIONS"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++14", "-fexceptions", "-fno-rtti" ],
      "conditions": [
        [ "OS=='linux'", {
          "cflags_cc": [ "-std=c++14", "-fexceptions", "-fPIC" ]
        }],
        [ "OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.13",
            "OTHER_CPLUSPLUSFLAGS": [ "-std=c++14", "-fexceptions" ]
          }
        }],
        [ "OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { 
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++14" ]
            }
          }
        }]
      ]
    }
  ]
}