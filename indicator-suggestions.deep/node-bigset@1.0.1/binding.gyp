# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "bigset",
      "sources": [ "src/BigSet.cpp" ],
      "include_dirs": [
        "<!(node -e \"require('node-addon-api').include\")",
        "node_modules/node-addon-api"
      ],
      "cflags": [
        "/EHsc",                  #启用 C++ 异常处理  Enable C++ exception handling
        "-DNAPI_CPP_EXCEPTIONS"   # 定义 NAPI_CPP_EXCEPTIONS 以启用 N-API 的 C++ 异常支持  Define NAPI_CPP_EXCEPTIONS to enable C++ exception support in N-API
      ],
      "cflags!": [               # 禁用默认的异常处理选项  Disable default exception handling options
        "-fno-exceptions"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    }
  ]
}
