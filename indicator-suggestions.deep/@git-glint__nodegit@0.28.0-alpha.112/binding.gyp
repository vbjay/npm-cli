# DEFANGED: static-analysis cache — do not execute
# This is a generated file, modify: generate/templates/templates/binding.gyp

{
  "variables": {
    "variables": {
      "target%": "none",
    },
    "is_electron%": "<!(node ./utils/isBuildingForElectron.js <(node_root_dir))",
    "is_IBMi%": "<!(node -p \"os.platform() == 'aix' && os.type() == 'OS400' ? 1 : 0\")",
    "electron_openssl_root%": "<!(node ./utils/getElectronOpenSSLRoot.js <(module_root_dir))",
    "electron_openssl_static%": "<!(node -p \"process.platform !== 'linux' || process.env.NODEGIT_OPENSSL_STATIC_LINK === '1' ? 1 : 0\")",
    "cxx_version%": "<!(node ./utils/defaultCxxStandard.js <(target))",
    "has_cxxflags%": "<!(node -p \"process.env.CXXFLAGS ? 1 : 0\")",
    "macOS_deployment_target": "10.11",
    #https: //github.com/nodejs/node-gyp/issues/2673
      'openssl_fips': '',
  },

  "targets": [{
    "target_name": "nodegit",

    "dependencies": [
      "vendor/libgit2.gyp:libgit2"
    ],

    "variables": {
      "coverage%": 0
    },
    "sources": [
      "src/async_baton.cc",
      "src/async_worker.cc",
      "src/lock_master.cc",
      "src/reference_counter.cc",
      "src/thread_pool.cc",
      "src/nodegit.cc",
      "src/init_ssh2.cc",
      "src/promise_completion.cc",
      "src/wrapper.cc",
      "src/functions/copy.cc",
      "src/functions/free.cc",
      "src/cleanup_handle.cc",
      "src/convenient_patch.cc",
      "src/convenient_hunk.cc",
      "src/filter_registry.cc",
      "src/git_buf_converter.cc",
      "src/str_array_converter.cc",
      "src/context.cc",
      "src/v8_helpers.cc",
      "src/tracker_wrap.cc",
      "src/annotated_commit.cc",
      "src/apply.cc",
      "src/apply_options.cc",
      "src/apply_options.cc",
      "src/attr.cc",
      "src/attr_options.cc",
      "src/blame.cc",
      "src/blame_hunk.cc",
      "src/blame_options.cc",
      "src/blob.cc",
      "src/blob_filter_options.cc",
      "src/blob_filter_options.cc",
      "src/branch.cc",
      "src/branch_iterator.cc",
      "src/buf.cc",
      "src/cert.cc",
      "src/cert_hostkey.cc",
      "src/cert_x509.cc",
      "src/checkout.cc",
      "src/checkout_options.cc",
      "src/checkout_perfdata.cc",
      "src/cherrypick.cc",
      "src/cherrypick_options.cc",
      "src/clone.cc",
      "src/clone_options.cc",
      "src/commit.cc",
      "src/commit_create_options.cc",
      "src/commit_graph.cc",
      "src/commit_graph_writer.cc",
      "src/commitarray.cc",
      "src/config.cc",
      "src/config_backend_memory_options.cc",
      "src/config_entry.cc",
      "src/config_entry.cc",
      "src/config_iterator.cc",
      "src/configmap.cc",
      "src/credential.cc",
      "src/describe_format_options.cc",
      "src/describe_format_options.cc",
      "src/describe_options.cc",
      "src/describe_options.cc",
      "src/describe_result.cc",
      "src/diff.cc",
      "src/diff_binary.cc",
      "src/diff_binary_file.cc",
      "src/diff_delta.cc",
      "src/diff_file.cc",
      "src/diff_find_options.cc",
      "src/diff_hunk.cc",
      "src/diff_line.cc",
      "src/diff_options.cc",
      "src/diff_parse_options.cc",
      "src/diff_patchid_options.cc",
      "src/diff_perfdata.cc",
      "src/diff_stats.cc",
      "src/email.cc",
      "src/email_create_options.cc",
      "src/error.cc",
      "src/fetch.cc",
      "src/fetch_options.cc",
      "src/fetch_options.cc",
      "src/filter.cc",
      "src/filter.cc",
      "src/filter_list.cc",
      "src/filter_options.cc",
      "src/filter_source.cc",
      "src/graph.cc",
      "src/hashsig.cc",
      "src/ignore.cc",
      "src/index.cc",
      "src/index_conflict_iterator.cc",
      "src/index_entry.cc",
      "src/index_iterator.cc",
      "src/index_name_entry.cc",
      "src/index_reuc_entry.cc",
      "src/index_time.cc",
      "src/indexer_progress.cc",
      "src/libgit2.cc",
      "src/mailmap.cc",
      "src/merge.cc",
      "src/merge_file_input.cc",
      "src/merge_file_options.cc",
      "src/merge_file_result.cc",
      "src/merge_options.cc",
      "src/midx_writer.cc",
      "src/note.cc",
      "src/note_iterator.cc",
      "src/object.cc",
      "src/odb.cc",
      "src/odb_backend_loose_options.cc",
      "src/odb_backend_pack_options.cc",
      "src/odb_object.cc",
      "src/odb_options.cc",
      "src/oid.cc",
      "src/oid_shorten.cc",
      "src/oidarray.cc",
      "src/packbuilder.cc",
      "src/patch.cc",
      "src/path.cc",
      "src/pathspec.cc",
      "src/pathspec_match_list.cc",
      "src/proxy.cc",
      "src/proxy_options.cc",
      "src/push_options.cc",
      "src/push_update.cc",
      "src/rebase.cc",
      "src/rebase_operation.cc",
      "src/rebase_options.cc",
      "src/refdb.cc",
      "src/reference.cc",
      "src/reflog.cc",
      "src/reflog_entry.cc",
      "src/refspec.cc",
      "src/remote.cc",
      "src/remote_callbacks.cc",
      "src/remote_callbacks.cc",
      "src/remote_connect_options.cc",
      "src/remote_create_options.cc",
      "src/remote_create_options.cc",
      "src/remote_head.cc",
      "src/remote_head.cc",
      "src/repository.cc",
      "src/repository_init_options.cc",
      "src/reset.cc",
      "src/revert.cc",
      "src/revert_options.cc",
      "src/revparse.cc",
      "src/revspec.cc",
      "src/revwalk.cc",
      "src/signature.cc",
      "src/stash.cc",
      "src/stash_apply_options.cc",
      "src/stash_apply_options.cc",
      "src/stash_save_options.cc",
      "src/status.cc",
      "src/status_entry.cc",
      "src/status_list.cc",
      "src/status_options.cc",
      "src/status_options.cc",
      "src/strarray.cc",
      "src/submodule.cc",
      "src/submodule_update_options.cc",
      "src/tag.cc",
      "src/time.cc",
      "src/trace.cc",
      "src/transaction.cc",
      "src/transport.cc",
      "src/tree.cc",
      "src/tree_entry.cc",
      "src/tree_update.cc",
      "src/treebuilder.cc",
      "src/worktree.cc",
      "src/worktree_add_options.cc",
      "src/worktree_add_options.cc",
      "src/worktree_prune_options.cc",
      "src/worktree_prune_options.cc",
      "src/writestream.cc",
    ],

    "include_dirs": [
      "vendor/libv8-convert",
      "vendor/libssh2/include",
      "<!(node -e \"require('@axosoft/nan')\")"
    ],

    "cflags": [
      "-Wall"
    ],

    "conditions": [
      [
        "coverage==1", {
          "cflags": [
            "-ftest-coverage",
            "-fprofile-arcs"
          ],
          "link_settings": {
            "libraries": [
              "-lgcov"
            ]
          },
        }
      ],
      [
        "OS=='mac'", {
          "libraries": [
            "-liconv",
          ],
          "conditions": [
            ["<(is_electron) == 1", {
              "include_dirs": [
                "<(electron_openssl_root)/include"
              ],
              "libraries": [
                "<(electron_openssl_root)/lib/libssl.a",
                "<(electron_openssl_root)/lib/libcrypto.a"
              ]
            }]
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "<(macOS_deployment_target)",
            'CLANG_CXX_LIBRARY': 'libc++',
            'CLANG_CXX_LANGUAGE_STANDARD': 'c++<(cxx_version)',

            "WARNING_CFLAGS": [
              "-Wno-unused-variable",
              "-Wint-conversions",
              "-Wmissing-field-initializers",
              "-Wno-c++11-extensions"
            ]
          }
        }
      ],
      [
        "OS=='win'", {
          "conditions": [
            ["<(is_electron) == 1", {
              "include_dirs": ["<(electron_openssl_root)/include"],
              "libraries": [
                "<(electron_openssl_root)/lib/libcrypto.lib",
                "<(electron_openssl_root)/lib/libssl.lib"
              ],
              "copies": [{
                "destination": "<(module_root_dir)/build/Release/",
                "files": [
                  "<(electron_openssl_root)/bin/libcrypto-1_1-x64.dll",
                  "<(electron_openssl_root)/bin/libssl-1_1-x64.dll"
                ]
              }]
            }]
          ],
          "defines": [
            "_HAS_EXCEPTIONS=1",
            "NOMINMAX=1"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [
                "/std:c++<(cxx_version)",
                "/EHsc"
              ]
            },
            "VCLinkerTool": {
              "AdditionalOptions": [
                "/FORCE:MULTIPLE"
              ]
            }
          },
          "libraries": [
            "ws2_32.lib",
            "crypt32.lib",
            "rpcrt4.lib",
            "secur32.lib"
          ]
        }
      ],
      ["OS=='mac' or OS=='linux' or OS.endswith('bsd') or <(is_IBMi) == 1", {
        "libraries": [
          "<!(krb5-config gssapi --libs)"
        ]
      }],
      ["OS=='linux' or OS.endswith('bsd') or <(is_IBMi) == 1", {
        "conditions": [
          ["<(has_cxxflags) == 0", {
            "cflags_cc": [
              "-std=c++<(cxx_version)"
            ],
          }],
          ["<(is_electron) == 1 and <(electron_openssl_static) == 1", {
            "include_dirs": [
              "<(electron_openssl_root)/include"
            ],
            "libraries": [#this order is significant on centos7 apparently...
              "<(electron_openssl_root)/lib/libssl.a",
              "<(electron_openssl_root)/lib/libcrypto.a"
            ]
          }],
          ["<(is_electron) == 1 and <(electron_openssl_static) != 1", {
            "libraries": [
              "-lcrypto",
              "-lssl"
            ]
          }]
        ],
      }],
      [
        "<(is_IBMi) == 1", {
          "include_dirs": [
            "/QOpenSys/pkgs/include"
          ],
          "libraries": [
            "-L/QOpenSys/pkgs/lib"
          ]
        }
      ]
    ]
  }]
}