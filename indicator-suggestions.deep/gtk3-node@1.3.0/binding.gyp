# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "gtk3_node",
      "sources": [
        "src/gtk3_node.cpp",
        "src/button.cpp",
        "widgets/label/label.cpp",
        "widgets/box/box.cpp",
        "widgets/scroll/scroll.cpp",
        "widgets/entry/entry.cpp",
        "widgets/stringgrid/stringgrid.cpp",
        "widgets/textview/textview.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/usr/include/gtk-3.0",
        "/usr/include/glib-2.0",
        "/usr/lib/x86_64-linux-gnu/glib-2.0/include",
        "/usr/include/pango-1.0",
        "/usr/include/harfbuzz",
        "/usr/include/freetype2",
        "/usr/include/libpng16",
        "/usr/include/libmount",
        "/usr/include/blkid",
        "/usr/include/fribidi",
        "/usr/include/cairo",
        "/usr/include/pixman-1",
        "/usr/include/gdk-pixbuf-2.0",
        "/usr/include/x86_64-linux-gnu",
        "/usr/include/gio-unix-2.0",
        "/usr/include/atk-1.0",
        "/usr/include/at-spi2-atk/2.0",
        "/usr/include/at-spi-2.0",
        "/usr/include/dbus-1.0",
        "/usr/lib/x86_64-linux-gnu/dbus-1.0/include"
      ],
      "libraries": [
        "-lgtk-3",
        "-lgobject-2.0",
        "-lglib-2.0",
        "-lgdk-3",
        "-lpango-1.0",
        "-lcairo",
        "-lgdk_pixbuf-2.0",
        "-latk-1.0"
      ],
      "cflags": [
        "-std=c++17"
      ],
      "cflags_cc": [
        "-std=c++17"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ]
    }
  ]
}