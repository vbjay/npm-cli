# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "CBOR",
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      "sources": [ "./src/addon_main.cc",
               "./src/CborObject.cpp",
               "./src/tinycbor/src/cborencoder.c",
               "./src/tinycbor/src/cborencoder_close_container_checked.c",
               "./src/tinycbor/src/cborerrorstrings.c",
               "./src/tinycbor/src/cborparser.c",
               "./src/tinycbor/src/cborparser_dup_string.c",
               "./src/tinycbor/src/cborpretty.c",
               "./src/tinycbor/src/cbortojson.c",
               "./src/tinycbor/src/open_memstream.c",
               "./src/addon_encoding.cc",
               "./src/addon_decoding.cc",
               "./src/cbor_pointer.cpp",
               "./src/cpp_redis/sources/future_client.cpp",
               "./src/cpp_redis/sources/logger.cpp",
               "./src/cpp_redis/sources/redis_client.cpp",
               "./src/cpp_redis/sources/redis_subscriber.cpp",
               "./src/cpp_redis/sources/reply.cpp",
               "./src/cpp_redis/sources/network/redis_connection.cpp",
               "./src/cpp_redis/sources/builders/array_builder.cpp",
               "./src/cpp_redis/sources/builders/builders_factory.cpp",
               "./src/cpp_redis/sources/builders/bulk_string_builder.cpp",
               "./src/cpp_redis/sources/builders/error_builder.cpp",
               "./src/cpp_redis/sources/builders/integer_builder.cpp",
               "./src/cpp_redis/sources/builders/reply_builder.cpp",
               "./src/cpp_redis/sources/builders/simple_string_builder.cpp",
               "./src/cpp_redis/tacopie/sources/network/unix/io_service.cpp",
               "./src/cpp_redis/tacopie/sources/network/unix/self_pipe.cpp",
               "./src/cpp_redis/tacopie/sources/network/unix/tcp_socket.cpp",
               "./src/cpp_redis/tacopie/sources/network/tcp_client.cpp",
               "./src/cpp_redis/tacopie/sources/network/tcp_server.cpp",
               "./src/cpp_redis/tacopie/sources/utils/thread_pool.cpp",
               "./src/cpp_redis/tacopie/sources/error.cpp",
               "./src/cpp_redis/tacopie/sources/logger.cpp"
        ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
        ]
    }
  ]
}