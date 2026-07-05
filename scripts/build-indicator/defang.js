'use strict'

const fs = require('fs/promises')
const path = require('path')

// Null byte at position 0 causes SyntaxError in all Node.js versions, preventing
// accidental execution of cached JS files while leaving text content intact for
// static analysis (regex matching is unaffected).
const DEFANG_MSG = 'DEFANGED: static-analysis cache — do not execute'
const DEFANG_SHEBANG = `#!/usr/bin/env false  # ${DEFANG_MSG}`

// Binary executable magic bytes — these files are skipped entirely (defangBuf returns null).
const BINARY_MAGIC = [
  Buffer.from([0x4d, 0x5a]),             // MZ   — Windows PE (.exe .dll .node)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF  — Linux/Android native
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O fat binary
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit LE
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // Mach-O 32-bit LE
]

/**
 * Overwrite any existing shebang (or prepend one) with #!/usr/bin/env false,
 * then inject killLine immediately after it.
 * #!/usr/bin/env false causes OS-level execution to exit 1 before the interpreter
 * ever sees the file content; killLine handles interpreter-direct invocation.
 */
function defangWithShebang(str, killLine) {
  const nlIdx = str.indexOf('\n')
  const afterFirst = nlIdx >= 0 ? str.slice(nlIdx + 1) : ''
  return `${DEFANG_SHEBANG}\n# ${DEFANG_MSG}\n${killLine}\n${afterFirst}`
}

/**
 * Defang a downloaded file so it cannot be accidentally executed.
 * Returns null for binary executables (caller should skip writing).
 * Returns a modified Buffer with an inert header for script/build-tool types.
 * Returns the original buf unchanged for safe data types (JSON, TOML, .rs, …).
 */
function defangBuf(relPath, buf) {
  // 1. Binary executable → skip entirely
  if (BINARY_MAGIC.some(m => buf.length >= m.length && buf.slice(0, m.length).equals(m))) {
    return null
  }

  const ext = path.extname(relPath).toLowerCase()
  const base = path.basename(relPath).toLowerCase()

  // 2. JS/TS: null byte → SyntaxError; also overwrite any shebang
  if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(ext)) {
    let str = buf.toString('utf8')
    if (str.startsWith('#!')) {
      const nl = str.indexOf('\n')
      str = `${DEFANG_SHEBANG}\n` + (nl >= 0 ? str.slice(nl + 1) : '')
    }
    return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), Buffer.from(str)])
  }

  // 3. Shell scripts — defanged shebang + exit 1
  if (['.sh', '.bash', '.zsh', '.ksh', '.fish'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), 'exit 1'))
  }

  // 4. Windows batch — no shebang concept; prepend @exit
  if (['.bat', '.cmd'].includes(ext)) {
    return Buffer.from(`@rem ${DEFANG_MSG}\r\n@exit /b 1\r\n${buf.toString('utf8')}`)
  }

  // 5. PowerShell — # comment + throw (shebang is harmless as a comment in PS)
  if (['.ps1', '.psm1', '.psd1'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `throw '${DEFANG_MSG}'`))
  }

  // 6. Python — defanged shebang + sys.exit
  if (['.py', '.pyw'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `import sys; sys.exit('${DEFANG_MSG}')`))
  }

  // 7. Ruby — defanged shebang + abort
  if (['.rb'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `abort '${DEFANG_MSG}'`))
  }

  // 8. Perl — defanged shebang + die
  if (['.pl', '.pm'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `die '${DEFANG_MSG}';`))
  }

  // 9. Makefile variants — override every common target + .DEFAULT to exit 1
  if (['makefile', 'gnumakefile', 'bsdmakefile'].includes(base) || ['.mk', '.make'].includes(ext)) {
    return Buffer.from(
      `# ${DEFANG_MSG}\n` +
      `.PHONY: all install build clean test configure\n` +
      `all install build clean test configure: ; @exit 1\n` +
      `.DEFAULT: ; @exit 1\n\n` +
      buf.toString('utf8')
    )
  }

  // 10. Gradle / Kotlin build scripts — Groovy throw
  if (['.gradle', '.gradle.kts'].includes(ext)) {
    return Buffer.from(`// ${DEFANG_MSG}\nthrow new Exception('${DEFANG_MSG}')\n${buf.toString('utf8')}`)
  }

  // 11. GYP/GYPI — Python comment marker
  if (['.gyp', '.gypi'].includes(ext)) {
    return Buffer.from(`# ${DEFANG_MSG}\n${buf.toString('utf8')}`)
  }

  // 12. Content-based detection for extensionless / unrecognized extensions
  const head = buf.slice(0, 512).toString('utf8')
  if (head.startsWith('#!')) {
    // Shebang present — check interpreter
    const shebangLine = head.slice(0, head.indexOf('\n'))
    if (/node|deno/.test(shebangLine)) {
      // Node shebang script → JS defang (null byte + overwrite shebang)
      const str = `${DEFANG_SHEBANG}\n` + head.slice(head.indexOf('\n') + 1)
      return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), Buffer.from(str)])
    }
    if (/python/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `import sys; sys.exit('${DEFANG_MSG}')`))
    }
    if (/ruby/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `abort '${DEFANG_MSG}'`))
    }
    if (/perl/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `die '${DEFANG_MSG}';`))
    }
    // Unknown interpreter — defanged shebang + exit 1 covers sh, env, etc.
    return Buffer.from(defangWithShebang(buf.toString('utf8'), 'exit 1'))
  }

  // JS content without recognized extension (e.g. underscore-contrib .arity/.builders,
  // appium extensionless modules, etc.)
  if (/^["']use strict["']/.test(head) ||
    /^\/\//.test(head) ||
    /^\(function/.test(head) ||
    /^(?:var |const |let |function |class |module\.exports|exports\.)/.test(head)) {
    return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), buf])
  }

  // 13. Git hook directories — extensionless files with no recognized content marker.
  // Git hook scripts (husky, lefthook, simple-git-hooks) are often extensionless
  // shell scripts that lack a shebang when authored for older hook managers.
  // A file inside .husky/, .lefthook/, or a standard git hooks/ directory with no
  // extension and no detectable content type is treated as a shell script.
  const posix = relPath.replace(/\\/g, '/')
  if (ext === '' && /(?:^|\/)(?:\.husky|\.lefthook|hooks)\/[^/]+$/.test(posix)) {
    return Buffer.from(`# ${DEFANG_MSG}\nexit 1\n${buf.toString('utf8')}`)
  }

  return buf  // safe data files (JSON, TOML, .rs, .c, CMakeLists.txt, …)
}

/**
 * Write a defanged buffer to disk and strip execute permissions on non-Windows.
 * Returns false if the file should be skipped (binary executable).
 */
async function writeDefanged(dest, relPath, buf) {
  const safe = defangBuf(relPath, buf)
  if (!safe) return false
  await fs.writeFile(dest, safe)
  if (process.platform !== 'win32') {
    await fs.chmod(dest, 0o444).catch(() => { /* best-effort */ })
  }
  return true
}

/**
 * Remove a directory tree, clearing read-only flags first on non-Windows so
 * that files chmod'd to 0o444 by writeDefanged can be deleted.
 */
async function rmReadOnly(dir) {
  if (process.platform !== 'win32') {
    // Walk and restore write permission before removal
    const restoreWrite = async (p) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true })
        await Promise.all(entries.map(e => {
          const full = path.join(p, e.name)
          return e.isDirectory() ? restoreWrite(full) : fs.chmod(full, 0o644).catch(() => { })
        }))
      } catch { /* ignore */ }
    }
    await restoreWrite(dir)
  }
  await fs.rm(dir, { recursive: true, force: true })
}

module.exports = {
  DEFANG_MSG,
  DEFANG_SHEBANG,
  BINARY_MAGIC,
  defangWithShebang,
  defangBuf,
  writeDefanged,
  rmReadOnly,
}
