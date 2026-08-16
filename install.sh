#!/usr/bin/env bash
# dsh-vscode-review — one-click install for dsh + VSCode
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo '=== [1/3] Install dsh-review ==='
dsh plugin --profile web add "$ROOT/packages/dsh-review"

echo '=== [2/3] Install dsh-review-changes ==='
dsh plugin --profile web add "$ROOT/packages/dsh-review-changes"

echo '=== [3/3] Install VSCode extension ==='
VSIX="$ROOT/vscode_dsh_plugin/dsh-review-vscode-0.1.0.vsix"
if [ -f "$VSIX" ]; then
  code --install-extension "$VSIX" --force
else
  echo 'VSIX not found; copying dev source into ~/.vscode/extensions instead.'
  DEST="$HOME/.vscode/extensions/dsn.dsh-review-vscode-0.1.0"
  mkdir -p "$DEST"
  cp -R "$ROOT/vscode_dsh_plugin/extension.js" \
        "$ROOT/vscode_dsh_plugin/package.json" \
        "$ROOT/vscode_dsh_plugin/lib" \
        "$ROOT/vscode_dsh_plugin/media" \
        "$DEST/"
fi

echo '=== Done ==='
echo '1. Restart dsh web.'
echo '2. In VSCode run Developer: Reload Window.'
