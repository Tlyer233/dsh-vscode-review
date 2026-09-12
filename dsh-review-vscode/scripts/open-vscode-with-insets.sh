#!/bin/bash
# Open real VS Code with editorInsets proposed API enabled for this extension.
# Dock / Finder launches do NOT pass --enable-proposed-api, so insets fail and
# you get same-line red labels + CodeLens instead of phantom rows + AC/RJ.
set -euo pipefail
EXT_ID="dsn.dsh-review-vscode"
CODE_BIN="${CODE_BIN:-}"
if [[ -z "$CODE_BIN" ]]; then
  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  elif command -v code >/dev/null 2>&1; then
    CODE_BIN="$(command -v code)"
  else
    echo "code CLI not found" >&2
    exit 1
  fi
fi
# --remote-debugging-port lets the extension's CDP element-source read the
# chat input model in real time (sub-second, zero-click element interception).
# Port overridable: DSH_CDP_PORT=9224 ./open-vscode-with-insets.sh
CDP_PORT="${DSH_CDP_PORT:-9223}"
exec "$CODE_BIN" --enable-proposed-api="$EXT_ID" --remote-debugging-port="$CDP_PORT" "$@"
