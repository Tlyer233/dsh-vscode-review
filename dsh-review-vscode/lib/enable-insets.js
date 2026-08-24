'use strict'

/**
 * Persist editorInsets for THIS extension id in VS Code argv.json.
 *
 * This is the same mechanism dsh-review-vscode relied on:
 *   package.json enabledApiProposals: ["editorInsets"]
 *   + user argv.json enable-proposed-api: ["<publisher>.<name>"]
 *
 * After a full restart, Dock/Finder launches pick it up — no shell script.
 * VS Code does NOT read ~/.vscode/argv.json; it reads the user-data file.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vscode = require('vscode')

/**
 * User-data argv.json for the host app (Code / Insiders / Cursor).
 * @param {string} appName
 * @returns {string}
 */
function argvJsonPath(appName) {
  const home = os.homedir()
  if (process.env.VSCODE_APPDATA) {
    return path.join(process.env.VSCODE_APPDATA, 'argv.json')
  }
  const name = String(appName || '')
  let product = 'Code'
  if (/insiders/i.test(name)) product = 'Code - Insiders'
  else if (/cursor/i.test(name)) product = 'Cursor'
  else if (/visual studio code|vscode/i.test(name)) product = 'Code'
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', product, 'argv.json')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), product, 'argv.json')
  }
  return path.join(home, '.config', product, 'argv.json')
}

/**
 * Merge extensionId into the enable-proposed-api array, preserving JSONC comments.
 * @param {string} text
 * @param {string} extensionId
 * @returns {{ text: string, changed: boolean }}
 */
function mergeProposedApi(text, extensionId) {
  const idJson = JSON.stringify(extensionId)
  const re = /"enable-proposed-api"\s*:\s*(\[[^\]]*\])/
  const m = text.match(re)
  if (m) {
    let arr
    try {
      arr = JSON.parse(m[1])
    } catch {
      arr = []
    }
    if (!Array.isArray(arr)) arr = []
    if (arr.indexOf(extensionId) >= 0) {
      return { text, changed: false }
    }
    arr.push(extensionId)
    const next = text.replace(re, '"enable-proposed-api": ' + JSON.stringify(arr))
    return { text: next, changed: true }
  }
  const insert = '\t"enable-proposed-api": [' + idJson + '],\n'
  const brace = text.match(/^[ \t]*\{/m)
  if (!brace || brace.index == null) {
    return { text: '{\n' + insert + '}\n', changed: true }
  }
  const at = brace.index + brace[0].length
  const next = text.slice(0, at) + '\n' + insert + text.slice(at)
  return { text: next, changed: true }
}

/**
 * Ensure argv.json lists this extension. Call once on activate.
 * @param {string} extensionId publisher.name
 * @returns {{ ok: boolean, changed: boolean, path: string, error?: string }}
 */
function ensureProposedApi(extensionId) {
  const file = argvJsonPath(vscode.env.appName)
  try {
    let raw = '{\n}\n'
    if (fs.existsSync(file)) {
      raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') // strip BOM; VS Code argv parser is picky on Windows
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    }
    const merged = mergeProposedApi(raw, extensionId)
    if (merged.changed) {
      fs.writeFileSync(file, merged.text, 'utf8') // Node utf8 has no BOM
    }
    return { ok: true, changed: merged.changed, path: file }
  } catch (e) {
    return { ok: false, changed: false, path: file, error: e && e.message || String(e) }
  }
}

module.exports = { ensureProposedApi, argvJsonPath, mergeProposedApi }
