# DEFANGED: static-analysis cache — do not execute
{
  "targets": [{
    "target_name": "slikenet",
    "sources": ["NodeJSSlikenet/slikenet_wrapper.cpp"],
    "include_dirs": ["SLikeNet/Source"],
    "library_dirs": ["SLikeNet/Lib"],
    "libraries": ["-lSLikeNet_LibStatic_Release_x64"],
    "msvs_settings": {
      "VCLinkerTool": {
        "AdditionalDependencies": ["ws2_32.lib", "iphlpapi.lib"]
      },
      "VCCLCompilerTool": {
        "RuntimeLibrary": 0
      }
    },
    "msvs_2015_settings": {
      "VCLinkerTool": {
        "AdditionalDependencies": ["ws2_32.lib", "iphlpapi.lib"]
      },
      "VCCLCompilerTool": {
        "RuntimeLibrary": 0
      }
    },
    "msvs_2017_settings": {
      "VCLinkerTool": {
        "AdditionalDependencies": ["ws2_32.lib", "iphlpapi.lib"]
      },
      "VCCLCompilerTool": {
        "RuntimeLibrary": 0
      }
    },
    "msvs_2019_settings": {
      "VCLinkerTool": {
        "AdditionalDependencies": ["ws2_32.lib", "iphlpapi.lib"]
      },
      "VCCLCompilerTool": {
        "RuntimeLibrary": 0
      }
    },
    "msvs_2022_settings": {
      "VCLinkerTool": {
        "AdditionalDependencies": ["ws2_32.lib", "iphlpapi.lib"]
      },
      "VCCLCompilerTool": {
        "RuntimeLibrary": 0
      }
    }
  }]
}