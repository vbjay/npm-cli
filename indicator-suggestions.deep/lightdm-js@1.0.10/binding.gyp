# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "lightdmjs",
      "sources": [ "lightdmjs.cc", "greeter.cc", "event_loop.cc", "callbacks.cc", "users.cc", "sessions.cc", "languages.cc", "power.cc" ],
      "include_dirs": [
        "./src",
        "<!@(node -p \"require('node-addon-api').include\")",
        "/usr/include/lightdm-gobject-1",
        "/usr/include/glib-2.0",
        "/usr/lib/glib-2.0/include",
        "/usr/include/sysprof-4",
        "/usr/include/libmount",
        "/usr/include/blkid",
        "/usr/include/gio-unix-2.0",
        "/usr/include/libxml2"
      ],
      "cflags": [ "-fPIC", "-pthread" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        [ 'OS=="mac"', {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "OTHER_CFLAGS": [ "-shared" ],
            "OTHER_LDFLAGS": [ "-shared" ]
          }
        }]
      ],
      "link_settings": {
        "libraries": [
          "-llightdm-gobject-1",
          "-lgobject-2.0",
          "-lglib-2.0"
        ]
      },
    }
  ]
}