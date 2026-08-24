'use strict'

const vscode = require('vscode')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFile, spawn } = require('node:child_process')
const { reloadDshWebview, showDshOfflineOverlay, showDshRestartingOverlay } = require('./dsh-browser.js')

const STOCK_DSH_COMMAND = 'node ${env:HOME}/.local/bin/dsh --profile web --no-open' // package.json default (mac-oriented)

function cfg() {
  return vscode.workspace.getConfiguration('dshReview')
}

function dshPort() {
  const configured = Number(cfg().get('dshPort'))
  if (Number.isFinite(configured) && configured > 0) return configured
  try {
    const url = new URL(String(cfg().get('webUrl') || 'http://127.0.0.1:3080'))
    return Number(url.port) || 3080
  } catch {
    return 3080
  }
}

/**
 * @param {string} value
 * @returns {string}
 * @description Quote a path for /bin/sh or cmd.exe /c.
 */
function quoteShellArg(value) {
  const s = String(value)
  if (process.platform === 'win32') {
    if (!/[\s&()^|<>"]/.test(s)) return s
    return '"' + s.replace(/"/g, '""') + '"'
  }
  if (!/[\s'"\\]/.test(s)) return s
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function fileExists(file) {
  try { return fs.existsSync(file) } catch { return false }
}

/**
 * @returns {string | null}
 * @description Locate dsh on PATH, ~/.local/bin, or Windows npm global.
 */
function findDshBin() {
  const home = os.homedir()
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh']
  const dirs = [
    path.join(home, '.local', 'bin'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
    path.join(home, 'AppData', 'Roaming', 'npm'),
  ].filter(Boolean)
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir)
  }
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const dir of dirs) {
    for (const name of names) {
      const direct = path.join(dir, name)
      if (fileExists(direct)) return direct
      if (process.platform === 'win32' && !path.extname(name)) {
        for (const ext of exts) {
          const p = path.join(dir, name + ext)
          if (fileExists(p)) return p
        }
      }
    }
  }
  return null
}

/**
 * @param {string} raw
 * @returns {boolean}
 * @description True when the setting is still the stock default (resolve per-OS).
 */
function isStockDshCommand(raw) {
  const n = String(raw || '').trim()
  if (!n) return true
  if (n === STOCK_DSH_COMMAND) return true
  if (n === 'dsh --profile web --no-open') return true
  const expanded = STOCK_DSH_COMMAND.replace(/\$\{env:HOME\}/g, os.homedir())
  if (n === expanded) return true
  const unixHome = 'node ' + os.homedir() + '/.local/bin/dsh --profile web --no-open'
  if (n === unixHome) return true
  return false
}

/**
 * @param {string} raw
 * @returns {string}
 */
function expandDshCommand(raw) {
  return String(raw)
    .replace(/\$\{env:HOME\}/g, os.homedir())
    .replace(/\$\{env:USERPROFILE\}/g, os.homedir())
    .replace(/%USERPROFILE%/gi, os.homedir())
}

function dshCommand() {
  const raw = String(cfg().get('dshCommand') || STOCK_DSH_COMMAND)
  if (isStockDshCommand(raw)) {
    const bin = findDshBin()
    const cmd = bin
      ? quoteShellArg(bin) + ' --profile web --no-open' // full path so GUI PATH does not matter
      : 'dsh --profile web --no-open' // last resort: cmd/sh PATH
    return cmd
  }
  let cmd = expandDshCommand(raw)
  if (!/(^|\s)--no-open(\s|$)/.test(cmd)) cmd += ' --no-open'
  return cmd
}

function proxyPort() {
  const p = Number(cfg().get('proxyPort'))
  return Number.isFinite(p) && p > 0 ? p : 7897
}

/**
 * @returns {NodeJS.ProcessEnv}
 * @description Proxy vars for spawn env (do not prefix Unix `env` — that is not a Win command).
 */
function proxyEnv() {
  const p = proxyPort()
  return {
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:' + p,
    HTTP_PROXY: 'http://127.0.0.1:' + p,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  }
}

/**
 * @param {string} stdout
 * @param {number} port
 * @returns {string[]}
 */
function parseNetstatPids(stdout, port) {
  const pids = []
  const seen = Object.create(null)
  const pin = new RegExp(':' + String(port) + '(?:\\s|\\]|$)')
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!pin.test(line)) continue
    const m = line.trim().match(/(\d+)\s*$/)
    if (!m || m[1] === '0' || seen[m[1]]) continue
    seen[m[1]] = 1
    pids.push(m[1])
  }
  return pids
}

/**
 * @param {number} port
 * @returns {Promise<string[]>}
 */
function listPidsOnPortUnix(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', 'tcp:' + port], { timeout: 5000 }, (err, stdout) => {
      const pids = String(stdout || '').trim().split(/\s+/).filter(Boolean)
      resolve(pids)
    })
  })
}

/**
 * @param {number} port
 * @returns {Promise<string[]>}
 */
function listPidsOnPortWin(port) {
  return new Promise((resolve) => {
    const ps = 'Get-NetTCPConnection -LocalPort ' + Number(port)
      + ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 8000,
      windowsHide: true,
    }, (err, stdout) => {
      const pids = String(stdout || '').split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s) && s !== '0')
      const uniq = [...new Set(pids)]
      if (uniq.length > 0 || !err) {
        resolve(uniq)
        return
      }
      execFile('netstat', ['-ano'], { timeout: 8000, windowsHide: true }, (e2, out2) => {
        resolve(parseNetstatPids(out2, port))
      })
    })
  })
}

/**
 * @param {number} port
 * @returns {Promise<string[]>}
 */
function listPidsOnPort(port) {
  return process.platform === 'win32' ? listPidsOnPortWin(port) : listPidsOnPortUnix(port)
}

/**
 * @param {string} pid
 * @returns {Promise<void>}
 */
function killPid(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/PID', String(pid)], { timeout: 5000, windowsHide: true }, () => resolve())
    } else {
      execFile('kill', ['-9', String(pid)], { timeout: 5000 }, () => resolve())
    }
  })
}

/**
 * @param {number} port
 * @returns {Promise<number>}
 */
async function stopDshProcess(port) {
  const pids = await listPidsOnPort(port)
  if (pids.length === 0) return 0
  await Promise.all(pids.map(killPid))
  return pids.length
}

/**
 * True when some process still holds the dsh TCP port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function portHasProcess(port) {
  const pids = await listPidsOnPort(port)
  return pids.length > 0
}

/**
 * True when the dsh HTTP server answers (any status below 500).
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function httpIsUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 800 }, (res) => {
      res.resume()
      resolve(!!res.statusCode && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * @param {() => Promise<boolean>} check
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @param {() => boolean} stillCurrent
 * @returns {Promise<boolean>}
 */
async function waitUntil(check, timeoutMs, intervalMs, stillCurrent) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!stillCurrent()) return false
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/** Ignore overlapping restart clicks. */
let restartToken = 0

/**
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @returns {number | undefined}
 * @description Spawn via cmd.exe on Windows and /bin/sh on macOS/Linux. Log to ~/.dsh/review/dsh-restart.log.
 */
function startDshProcess(extraEnv) {
  const logPath = path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch { /* noop */ }
  const out = fs.openSync(logPath, 'a')
  const win = process.platform === 'win32'
  const file = win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = win ? ['/d', '/s', '/c', dshCommand()] : ['-c', dshCommand()]
  const child = spawn(file, args, {
    cwd: os.homedir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, extraEnv || {}),
    windowsHide: true,
  })
  child.unref()
  try { fs.closeSync(out) } catch { /* child keeps the inherited fd */ }
  return child.pid
}

/**
 * Blank the iframe, kill+start dsh, wait until HTTP is up, then load the
 * sidebar once. The old 1.2/3/6s triple html rewrite flashed and remounted
 * the conversation (which retried the last send).
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @param {string} doneMsg
 */
async function restartDshCore(extraEnv, doneMsg) {
  const token = ++restartToken
  const stillCurrent = () => token === restartToken
  const port = dshPort()
  const url = String(cfg().get('webUrl') || 'http://127.0.0.1:3080')

  showDshRestartingOverlay()
  const killed = await stopDshProcess(port)
  await waitUntil(async () => !(await portHasProcess(port)), 4000, 100, stillCurrent)
  if (!stillCurrent()) return

  startDshProcess(extraEnv)
  const up = await waitUntil(() => httpIsUp(url), 20000, 250, stillCurrent)
  if (!stillCurrent()) return

  if (up) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (!stillCurrent()) return
    reloadDshWebview(true)
  } else {
    showDshOfflineOverlay()
  }
  const bits = [doneMsg]
  if (killed > 0) bits.push('killed ' + killed + ' old process')
  if (!up) bits.push('server did not come up')
  vscode.window.showInformationMessage(bits.join(' — '))
}

async function restartDsh() {
  const port = dshPort()
  await restartDshCore(undefined, 'dsh restarted on port ' + port)
}

async function restartDshProxy() {
  const port = dshPort()
  const proxy = proxyPort()
  await restartDshCore(
    proxyEnv(),
    'dsh restarted via proxy 127.0.0.1:' + proxy + ' (dsh port ' + port + ')',
  )
}

async function stopDsh() {
  const port = dshPort()
  const killed = await stopDshProcess(port)
  vscode.window.showInformationMessage(
    killed > 0 ? 'dsh stopped (port ' + port + ')' : 'dsh is not running (port ' + port + ')',
  )
  // Do not reload iframe after stop — that would only black-screen and could
  // disturb a shared mental model with a browser tab. Show offline overlay instead.
  showDshOfflineOverlay()
}

module.exports = {
  restartDsh,
  restartDshProxy,
  stopDsh,
  dshPort,
  dshCommand,
}
