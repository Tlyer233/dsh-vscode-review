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

function biliPort() {
  const p = Number(cfg().get('biliPort'))
  return Number.isFinite(p) && p > 0 ? p : 8787
}

/**
 * @returns {string | null}
 * @description Locate the bili launcher in ~/.local/bin or on PATH.
 */
function findBiliBin() {
  const home = os.homedir()
  const names = process.platform === 'win32' ? ['bili.cmd', 'bili.exe', 'bili.bat', 'bili'] : ['bili']
  const dirs = [path.join(home, '.local', 'bin')]
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir)
  }
  for (const dir of dirs) {
    for (const name of names) {
      if (fileExists(path.join(dir, name))) return path.join(dir, name)
    }
  }
  return null
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 * @description True when the bili proxy answers /__bili/health with ok:true.
 */
function biliHealthUp(port) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + String(port) + '/__bili/health', { timeout: 1000 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let ok = false
        try { ok = !!res.statusCode && res.statusCode < 500 && /"ok"\s*:\s*true/.test(body) } catch { ok = false }
        resolve(ok)
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/**
 * @returns {string[]}
 * @description NO_PROXY entries: built-in loopback set plus the user whitelist from
 * `dshReview.noProxyExtra` (comma/whitespace-separated, e.g. a Tailscale IP).
 */
function noProxyList() {
  const base = ['localhost', '127.0.0.1', '::1']
  const extra = String(cfg().get('noProxyExtra') || '')
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter((s) => s && !base.includes(s))
  return [...base, ...extra]
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
    NO_PROXY: noProxyList().join(','),
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
 * @returns {string | null}
 * @description System node.exe/node, never Electron's process.execPath.
 */
function findNodeBin() {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const p = path.join(dir, name)
      if (fileExists(p) && !/electron/i.test(p)) return p
    }
  }
  return null
}

/**
 * @returns {string | null}
 * @description System node from PATH, falling back to common install locations
 * (a Dock-launched VS Code may have a minimal PATH).
 */
function findNodeBinStrict() {
  const node = findNodeBin()
  if (node) return node
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin', 'node'),
    path.join(home, '.hermes', 'node', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const p of candidates) {
    if (fileExists(p)) return p
  }
  return null
}

/**
 * @param {string} cmdPath
 * @returns {string | null}
 * @description Resolve the JS CLI that npm's dsh.cmd forwards to.
 */
function dshScriptFromCmd(cmdPath) {
  let text = ''
  try { text = fs.readFileSync(cmdPath, 'utf8') } catch { return null }
  const dir = path.dirname(cmdPath)
  const rel = text.match(/%~dp0%?\\([^"\r\n]+)/i) || text.match(/%dp0%\\([^"\r\n]+)/i)
  if (rel) {
    const p = path.join(dir, rel[1].replace(/\\/g, path.sep))
    if (fileExists(p)) return p
  }
  const candidates = [
    path.join(dir, 'node_modules', 'dsh', 'bin', 'dsh.js'),
    path.join(dir, 'node_modules', 'dsh', 'bin', 'dsh'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.js'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh'),
  ]
  for (const p of candidates) {
    if (fileExists(p)) return p
  }
  return null
}

/**
 * @returns {{ file: string, args: string[] } | null}
 * @description Direct argv spawn so Windows does not allocate a console for cmd.exe → node.exe.
 */
function resolveDirectSpawn() {
  const raw = String(cfg().get('dshCommand') || STOCK_DSH_COMMAND)
  const extra = ['--profile', 'web', '--no-open']
  if (isStockDshCommand(raw)) {
    const bin = findDshBin()
    const node = findNodeBin()
    if (bin && /\.(cmd|bat)$/i.test(bin) && node) {
      const script = dshScriptFromCmd(bin)
      if (script) return { file: node, args: [script].concat(extra) }
    }
    if (bin && !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args: extra }
    if (node && bin && !/\.(cmd|bat)$/i.test(bin)) return { file: node, args: [bin].concat(extra) }
    return null
  }
  const expanded = expandDshCommand(raw)
  const m = expanded.match(/^\s*(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))(.*)$/)
  if (m && /node(\.exe)?$/i.test(m[1] || m[2] || '')) {
    const node = m[1] || m[2]
    const script = m[3] || m[4]
    const rest = String(m[5] || '').trim().split(/\s+/).filter(Boolean)
    if (!rest.includes('--no-open')) rest.push('--no-open')
    return { file: node, args: [script].concat(rest) }
  }
  return null
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv | undefined} extraEnv
 * @param {string} logPath
 * @returns {number | undefined}
 * @description Windows nohup: WScript.Run window style 0 (hidden, do not wait).
 */
function startWinHiddenCmd(command, extraEnv, logPath) {
  const dir = path.dirname(logPath)
  const batPath = path.join(dir, 'restart-hidden.cmd')
  const vbsPath = path.join(dir, 'restart-hidden.vbs')
  const lines = []
  if (extraEnv) {
    for (const key of Object.keys(extraEnv)) {
      lines.push('set "' + key + '=' + String(extraEnv[key]).replace(/[\r\n"]/g, '') + '"')
    }
  }
  lines.push(command + ' >> "' + logPath + '" 2>&1')
  fs.writeFileSync(batPath, lines.join('\r\n') + '\r\n', 'utf8')
  const vbs = 'Set sh = CreateObject("WScript.Shell")\r\n'
    + 'sh.Run "cmd.exe /c ""' + batPath.replace(/"/g, '') + '""", 0, False\r\n'
  fs.writeFileSync(vbsPath, vbs, 'utf8')
  const child = spawn('wscript.exe', ['//nologo', '//B', vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child.pid
}

/**
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @returns {number | undefined}
 * @description Spawn via /bin/sh on macOS/Linux; on Windows hide the console (no cmd window).
 */
function startDshProcess(extraEnv) {
  const logPath = path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch { /* noop */ }
  if (process.platform === 'win32') {
    const direct = resolveDirectSpawn()
    if (direct) {
      const out = fs.openSync(logPath, 'a')
      const child = spawn(direct.file, direct.args, {
        cwd: os.homedir(),
        detached: true,
        stdio: ['ignore', out, out],
        env: Object.assign({}, process.env, extraEnv || {}),
        windowsHide: true,
        shell: false,
      })
      child.unref()
      try { fs.closeSync(out) } catch { /* child keeps the inherited fd */ }
      return child.pid
    }
    return startWinHiddenCmd(dshCommand(), extraEnv, logPath)
  }
  const out = fs.openSync(logPath, 'a')
  const child = spawn('/bin/sh', ['-c', dshCommand()], {
    cwd: os.homedir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, extraEnv || {}),
  })
  child.unref()
  try { fs.closeSync(out) } catch { /* child keeps the inherited fd */ }
  return child.pid
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @returns {number | undefined}
 * @description Spawn an explicit launch command (used by the bili restart),
 * logging to the same dsh-restart.log.
 */
function startDshProcessWith(command, extraEnv) {
  const logPath = path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch { /* noop */ }
  if (process.platform === 'win32') {
    return startWinHiddenCmd(command, extraEnv || {}, logPath)
  }
  const out = fs.openSync(logPath, 'a')
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: os.homedir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, extraEnv || {}),
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

  let logMark = 0
  try { logMark = fs.statSync(path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')).size } catch { logMark = 0 }
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

/**
 * Restart dsh through the bili (billion-context) proxy: the bili launcher
 * starts a fresh proxy (bound to dshReview.biliPort) and launches dsh against
 * it with the ACP compression plugin. A stale bili proxy on that port is
 * replaced; a non-bili occupant aborts the restart.
 */
async function restartDshBili() {
  const biliBin = findBiliBin()
  const nodeBin = findNodeBinStrict()
  if (!biliBin) {
    vscode.window.showErrorMessage('dshReview: bili not found (looked in ~/.local/bin and PATH)')
    return
  }
  if (!nodeBin) {
    vscode.window.showErrorMessage('dshReview: node not found (PATH or common install locations)')
    return
  }
  const port = dshPort()
  const bport = biliPort()
  const url = String(cfg().get('webUrl') || 'http://127.0.0.1:3080')
  const token = ++restartToken
  const stillCurrent = () => token === restartToken

  showDshRestartingOverlay()

  // The bili launcher always spawns its own proxy and falls back to a random
  // port when the preferred one is taken. Replace a stale bili proxy so the
  // port stays deterministic (refuse to kill a non-bili process).
  let replaced = 0
  if (await portHasProcess(bport)) {
    if (await biliHealthUp(bport)) {
      replaced = await stopDshProcess(bport)
    } else {
      vscode.window.showErrorMessage(
        'dshReview: port ' + bport + ' is occupied by a non-bili process — free it manually, then retry.',
      )
      showDshOfflineOverlay()
      return
    }
  }
  if (!stillCurrent()) return
  await waitUntil(async () => !(await portHasProcess(bport)), 4000, 100, stillCurrent)
  if (!stillCurrent()) return

  const killed = await stopDshProcess(port)
  await waitUntil(async () => !(await portHasProcess(port)), 4000, 100, stillCurrent)
  if (!stillCurrent()) return

  const command = quoteShellArg(nodeBin) + ' ' + quoteShellArg(biliBin) + ' dsh -- --profile web --no-open'
  const extraEnv = {
    PATH: path.join(os.homedir(), '.local', 'bin') + path.delimiter + (process.env.PATH || ''),
    ACP_PORT: String(bport),
    ACP_DEBUG: '1',
    ACP_RENDER_NONE: '1',
  }
  let logMark = 0
  try { logMark = fs.statSync(path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')).size } catch { logMark = 0 }
  startDshProcessWith(command, extraEnv)
  const up = await waitUntil(() => httpIsUp(url), 25000, 250, stillCurrent)
  if (!stillCurrent()) return

  if (up) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (!stillCurrent()) return
    reloadDshWebview(true)
  } else {
    showDshOfflineOverlay()
  }
  const bits = ['dsh restarted via bili (proxy http://127.0.0.1:' + bport + ')']
  if (killed > 0) bits.push('killed ' + killed + ' old dsh')
  if (replaced > 0) bits.push('replaced stale bili proxy')
  if (!up) bits.push('server did not come up')
  vscode.window.showInformationMessage(bits.join(' — '))
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
  restartDshBili,
  stopDsh,
  dshPort,
  dshCommand,
}
