'use strict'
/**
 * (2.1.0) Shared remote-aware file writer.
 * Local window: plain node fs. SSH window: vscode.workspace.fs with a
 * vscode-remote URI built from the open workspace's authority — i.e. the
 * ALREADY-authenticated VS Code ssh channel (no scp, no extra sshd, no keys).
 * Same road annoPut proved live for annotation delivery (2.0.2).
 */
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

function remoteAuthority() {
  try {
    if (!vscode.env.remoteName) return null
    const f = (vscode.workspace.workspaceFolders || [])[0]
    return (f && f.uri.authority) ? f.uri.authority : null
  } catch (e) { return null }
}

function remoteUri(p, auth) {
  return vscode.Uri.from({ scheme: 'vscode-remote', authority: auth, path: p })
}

/**
 * Write content (Buffer or readable LOCAL source path) to targetPath.
 * targetPath is interpreted on the machine that will run the agent:
 * remote window -> a Linux path written through the ssh channel;
 * local window -> a path written with node fs.
 * @param {string} targetPath posix-style destination
 * @param {Buffer|string} content buffer, or local file path to read
 * @returns {Promise<string>} the final reference path (== targetPath)
 */
async function put(targetPath, content) {
  const buf = Buffer.isBuffer(content) ? content : fs.readFileSync(content)
  const auth = remoteAuthority()
  if (!auth) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, buf)
    return targetPath
  }
  await vscode.workspace.fs.createDirectory(remoteUri(path.posix.dirname(targetPath), auth))
  await vscode.workspace.fs.writeFile(remoteUri(targetPath, auth), buf)
  return targetPath
}

module.exports = { remoteAuthority, put }
