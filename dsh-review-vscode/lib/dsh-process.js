'use strict'

const vscode = require('vscode')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFile, spawn } = require('node:child_process')
const { reloadDshWebview, showDshOfflineOverlay, showDshRestartingOverlay } = require('./dsh-browser.js')

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

function dshCommand() {
  const raw = String(cfg().get('dshCommand') || `node ${os.homedir()}/.local/bin/dsh --profile web --no-open`)
  let cmd = raw.replace(/\$\{env:HOME\}/g, os.homedir())
  if (!/(^|\s)--no-open(\s|$)/.test(cmd)) cmd += ' --no-open'
  return cmd
}

function proxyPort() {
  const p = Number(cfg().get('proxyPort'))
  return Number.isFinite(p) && p > 0 ? p : 7897
}

function dshProxyCommand() {
  const p = proxyPort()
  const prefix = 'env NODE_USE_ENV_PROXY=1' +
    ' HTTPS_PROXY=http://127.0.0.1:' + p +
    ' HTTP_PROXY=http://127.0.0.1:' + p +
    ' NO_PROXY=localhost,127.0.0.1,::1 '
  return prefix + dshCommand()
}

function stopDshProcess(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', 'tcp:' + port], { timeout: 5000 }, (err, stdout) => {
      const pids = (stdout || '').trim().split(/\s+/).filter(Boolean)
      if (pids.length === 0) {
        resolve(0)
        return
      }
      let remaining = pids.length
      for (const pid of pids) {
        execFile('kill', ['-9', String(pid)], { timeout: 5000 }, () => {
          remaining -= 1
          if (remaining === 0) resolve(pids.length)
        })
      }
    })
  })
}

/**
 * True when some process still holds the dsh TCP port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portHasProcess(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', 'tcp:' + port], { timeout: 3000 }, (err, stdout) => {
      resolve(!!(stdout || '').trim())
    })
  })
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

function startDshProcess(command) {
  const logPath = path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')
  try {
    require('node:fs').mkdirSync(path.dirname(logPath), { recursive: true })
  } catch { /* noop */ }
  const child = spawn('/bin/sh', ['-c', (command || dshCommand()) + ' >> "' + logPath + '" 2>&1'], {
    cwd: os.homedir(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child.pid
}

/**
 * Blank the iframe, kill+start dsh, wait until HTTP is up, then load the
 * sidebar once. The old 1.2/3/6s triple html rewrite flashed and remounted
 * the conversation (which retried the last send).
 * @param {string} [command]
 * @param {string} doneMsg
 */
async function restartDshCore(command, doneMsg) {
  const token = ++restartToken
  const stillCurrent = () => token === restartToken
  const port = dshPort()
  const url = String(cfg().get('webUrl') || 'http://127.0.0.1:3080')

  showDshRestartingOverlay()
  const killed = await stopDshProcess(port)
  await waitUntil(async () => !(await portHasProcess(port)), 4000, 100, stillCurrent)
  if (!stillCurrent()) return

  startDshProcess(command)
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
    dshProxyCommand(),
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
