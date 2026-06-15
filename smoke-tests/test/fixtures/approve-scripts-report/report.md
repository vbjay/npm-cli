# npm Lifecycle Script Approval Review

> **Note:** This report is best-effort and does not claim to prove a package is safe.
> A human must review this evidence before approving or denying any package.

## Package: @sentry/cli@1.77.3

**Location:** `node_modules/@sentry/cli`  
**Dependency type:** transitive  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- allow-scripts-demo → @sentry/webpack-plugin@1.21.0 → @sentry/cli@1.77.3
- allow-scripts-demo → ember-cli-deploy-sentry-cli@3.1.0 → @sentry/cli@1.77.3

**Lifecycle scripts:**
```json
{
  "install": "node ./scripts/install.js"
}
```

### Referenced files

#### `scripts/install.js`

**Reason:** referenced by lifecycle script: `install`  
**SHA-256:** `f693c46a257952dd4f4c76cc7f7c3ab4536599e2ad0548a27d7a8183536f6c93`  
**Size:** 839 B  

**Detected signals:**
- reads process.env
- makes network requests
- may write outside the package directory
- imports local files

**Local imports:**
- `js/install.js`

#### `js/install.js`

**Reason:** required by ./scripts/install.js  
**SHA-256:** `a15ee1c659fe9f3368eb99cde08f424f4b44cf963fa8b9c6427458a970a95e2c`  
**Size:** 8.9 kB  

**Detected signals:**
- reads process.env
- makes network requests
- writes files to disk
- may write outside the package directory
- references external URLs
- imports local files

**Local imports:**
- `js/helper.js`
- `package.json`
- `js/logger.js`

#### `js/helper.js`

**Reason:** required by ./js/install.js  
**SHA-256:** `76f511fd75cf4cb2afc251a9ba62ecbbc8aeb571233d13e4958a4d82f2a1359c`  
**Size:** 6.1 kB  

**Detected signals:**
- uses child_process (can spawn external commands)
- reads process.env

#### `package.json`

**Reason:** required by ./js/install.js  
**SHA-256:** `8ab62ccee75956b622201e5d16bccec41c6883b0771146310bc6ded8e26f5a9d`  
**Size:** 1.9 kB  

**Detected signals:**
- references external URLs

#### `js/logger.js`

**Reason:** required by ./js/install.js  
**SHA-256:** `d7d63601d3347efc93425f4f93049cfb9ed2b9ead1dce662c9c1bed3cba302e0`  
**Size:** 253 B  

### Risk summary

- makes network requests
- may write outside the package directory
- uses child_process (can spawn external commands)

### Suggested review focus

- confirm what remote endpoints are contacted and whether responses are verified
- confirm whether file writes are scoped to the package directory
- confirm what external commands are executed and whether they are constrained

---

## Package: canvas@2.11.2

**Location:** `node_modules/canvas`  
**Dependency type:** direct  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- allow-scripts-demo → canvas@2.11.2

**Lifecycle scripts:**
```json
{
  "install": "node-gyp rebuild"
}
```

### Referenced files

#### `<inline>`

**Reason:** inline lifecycle script: `install`  

**Detected signals:**
- builds native code (node-gyp / binding.gyp)

### Native build (node-gyp)

**`binding.gyp` SHA-256:** `684e491f30b36151ebc98bef3eef17a1078b1227003ceaea6fec355441813666`  

**2 native targets declared:**

- **`canvas-postbuild`**
  - Conditions: yes — inspect for platform-specific build behaviour
- **`canvas`**
  - Sources (16): `src/backend/Backend.cc`, `src/backend/ImageBackend.cc`, `src/backend/PdfBackend.cc`, `src/backend/SvgBackend.cc`, `src/bmp/BMPParser.cc`, `src/Backends.cc`, `src/Canvas.cc`, `src/CanvasGradient.cc`, `src/CanvasPattern.cc`, `src/CanvasRenderingContext2d.cc`, `src/closure.cc`, `src/color.cc`, `src/Image.cc`, `src/ImageData.cc`, `src/init.cc`, `src/register_font.cc`
  - Libraries: `-l<(GTK_Root)/lib/cairo.lib`, `-l<(GTK_Root)/lib/libpng.lib`, `-l<(GTK_Root)/lib/pangocairo-1.0.lib`, `-l<(GTK_Root)/lib/pango-1.0.lib`, `-l<(GTK_Root)/lib/freetype.lib`, `-l<(GTK_Root)/lib/glib-2.0.lib`, `-l<(GTK_Root)/lib/gobject-2.0.lib`, `<!@(pkg-config pixman-1 --libs)`, `<!@(pkg-config cairo --libs)`, `<!@(pkg-config libpng --libs)`, `<!@(pkg-config pangocairo --libs)`, `<!@(pkg-config freetype2 --libs)`, `-l<(jpeg_root)/lib/jpeg.lib`, `<!@(pkg-config libjpeg --libs)`, `-l<(GTK_Root)/lib/gif.lib`, `-L/opt/homebrew/lib`, `-lgif`, `-l<(GTK_Root)/lib/librsvg-2-2.lib`, `<!@(pkg-config librsvg-2.0 --libs)`
  - Include dirs: `<!(node -e "require('nan')")`, `<(GTK_Root)/include`, `<(GTK_Root)/include/cairo`, `<(GTK_Root)/include/pango-1.0`, `<(GTK_Root)/include/glib-2.0`, `<(GTK_Root)/include/freetype2`, `<(GTK_Root)/lib/glib-2.0/include`, `<!@(pkg-config cairo --cflags-only-I | sed s/-I//g)`, `<!@(pkg-config libpng --cflags-only-I | sed s/-I//g)`, `<!@(pkg-config pangocairo --cflags-only-I | sed s/-I//g)`, `<!@(pkg-config freetype2 --cflags-only-I | sed s/-I//g)`, `<(jpeg_root)/include`, `<!@(pkg-config libjpeg --cflags-only-I | sed s/-I//g)`, `/opt/homebrew/include`, `<!@(pkg-config librsvg-2.0 --cflags-only-I | sed s/-I//g)`
  - Conditions: yes — inspect for platform-specific build behaviour

### Risk summary

- builds native code (node-gyp / binding.gyp)

### Suggested review focus

- review the binding.gyp targets — inspect native source files for unsafe C/C++ operations, verify external library dependencies are expected, and check platform-specific conditions

---

## Package: esbuild@0.20.0

**Location:** `node_modules/esbuild`  
**Dependency type:** direct  
**Approval status:** pending  
**Change:** no previous approval found (new)  

**Introduced by:**
- allow-scripts-demo → esbuild@0.20.0

**Lifecycle scripts:**
```json
{
  "postinstall": "node install.js"
}
```

### Referenced files

#### `install.js`

**Reason:** referenced by lifecycle script: `postinstall`  
**SHA-256:** `a061231445c23fe8ed9f1f102a639adc796982541b3cc5976beb7544dca24a77`  
**Size:** 11.0 kB  

**Detected signals:**
- uses child_process (can spawn external commands)
- reads process.env
- makes network requests
- references external URLs

### Risk summary

- uses child_process (can spawn external commands)
- makes network requests

### Suggested review focus

- confirm what external commands are executed and whether they are constrained
- confirm what remote endpoints are contacted and whether responses are verified

---
