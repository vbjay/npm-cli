# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "uplink_native",
      "defines": [
        "NAPI_VERSION=8"
      ],
      "sources": [
        "native/src/addon.c",
        "native/src/common/logger.c",
        "native/src/common/handle_helpers.c",
        "native/src/common/string_helpers.c",
        "native/src/common/buffer_helpers.c",
        "native/src/common/result_helpers.c",
        "native/src/common/type_converters.c",
        "native/src/common/library_loader.c",
        "native/src/common/error_registry.c",
        "native/src/common/object_converter.c",
        "native/src/access/access_ops.c",
        "native/src/access/access_execute.c",
        "native/src/access/access_complete.c",
        "native/src/project/project_ops.c",
        "native/src/project/project_execute.c",
        "native/src/project/project_complete.c",
        "native/src/bucket/bucket_ops.c",
        "native/src/bucket/bucket_execute.c",
        "native/src/bucket/bucket_complete.c",
        "native/src/object/object_ops.c",
        "native/src/object/object_execute.c",
        "native/src/object/object_complete.c",
        "native/src/upload/upload_ops.c",
        "native/src/upload/upload_execute.c",
        "native/src/upload/upload_complete.c",
        "native/src/download/download_ops.c",
        "native/src/download/download_execute.c",
        "native/src/download/download_complete.c",
        "native/src/encryption/encryption_ops.c",
        "native/src/encryption/encryption_execute.c",
        "native/src/encryption/encryption_complete.c",
        "native/src/multipart/multipart_ops.c",
        "native/src/multipart/multipart_execute.c",
        "native/src/multipart/multipart_complete.c",
        "native/src/edge/edge_ops.c",
        "native/src/edge/edge_execute.c",
        "native/src/edge/edge_complete.c",
        "native/src/debug/debug_ops.c"
      ],
      "include_dirs": [
        "native/include",
        "native/src",
        "native/src/common"
      ],
      "cflags": ["-Wall", "-Wextra", "-std=c11"],
      "cflags!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "10.15",
        "WARNING_CFLAGS": ["-Wall", "-Wextra"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 0
        },
        "VCLinkerTool": {
          "AdditionalLibraryDirectories": [
            "<(module_root_dir)/native/prebuilds/win32-<(target_arch)"
          ],
          "DelayLoadDLLs": ["libuplink.dll"]
        }
      },
      "conditions": [
        ["OS=='mac'", {
          "libraries": [
            "-L<(module_root_dir)/native/prebuilds/darwin-<(target_arch)",
            "-luplink",
            "-Wl,-rpath,@loader_path/../../native/prebuilds/darwin-<(target_arch)",
            "-Wl,-rpath,@loader_path"
          ],
          "postbuilds": [
            {
              "postbuild_name": "Fix library reference to use @rpath",
              "action": [
                "install_name_tool",
                "-change",
                "libuplink.dylib",
                "@rpath/libuplink.dylib",
                "${BUILT_PRODUCTS_DIR}/${EXECUTABLE_PATH}"
              ]
            }
          ]
        }],
        ["OS=='linux'", {
          "libraries": [
            "-L<(module_root_dir)/native/prebuilds/linux-<(target_arch)",
            "-luplink",
            "-Wl,--disable-new-dtags",
            "-Wl,-rpath,'$$ORIGIN/../../native/prebuilds/linux-<(target_arch)'",
            "-Wl,-rpath,'$$ORIGIN'"
          ]
        }],
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/native/prebuilds/win32-<(target_arch)/uplink.lib"
          ],
          "copies": [
            {
              "destination": "<(PRODUCT_DIR)",
              "files": [
                "<(module_root_dir)/native/prebuilds/win32-<(target_arch)/libuplink.dll"
              ]
            }
          ]
        }]
      ]
    }
  ]
}
