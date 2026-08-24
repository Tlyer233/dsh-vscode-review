#!/usr/bin/env bash
# Reverse install.sh: drop dsh-review, VS Code extension, argv proposed-api, shadow store.
# Idempotent: safe to re-run. Does not touch Cursor argv/extensions.
set -euo pipefail

EXT_ID="dsn.dsh-review-vscode"
EXT_OBSOLETE="demo.my-vscode-plugin"
VSCODE_EXT_DIR="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"

die() { echo "ERROR: $*" >&2; exit 1; }

# Remove EXT_ID (and obsolete ids) from enable-proposed-api. Leaves other ids.
unmerge_argv() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "no $file"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    local st=0
    python3 - "$file" "$EXT_ID" "$EXT_OBSOLETE" <<'PY' || st=$?
import pathlib, re, json, sys
path = pathlib.Path(sys.argv[1])
drop = set([sys.argv[2]] + [x for x in sys.argv[3].split(",") if x])
text = path.read_text(encoding="utf-8")
m = re.search(r'"enable-proposed-api"\s*:\s*(\[[^\]]*\])', text)
if not m:
    sys.exit(3)
arr = json.loads(m.group(1))
if not isinstance(arr, list):
    sys.exit(3)
cleaned = [x for x in arr if x not in drop]
if cleaned == arr:
    sys.exit(3)
text = text[: m.start(1)] + json.dumps(cleaned) + text[m.end(1) :]
path.write_text(text, encoding="utf-8")
sys.exit(0)
PY
    if [ "$st" -eq 0 ]; then
      echo "updated $file"
      return
    fi
    if [ "$st" -eq 3 ]; then
      echo "already clean $file"
      return
    fi
  fi
  echo "skip argv python missing or parse failed: $file"
}

# Delete extension folders + drop matching rows from extensions.json.
purge_vscode_extension() {
  local ext_dir="$1"
  mkdir -p "$ext_dir"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ext_dir" "$EXT_ID" "$EXT_OBSOLETE" <<'PY'
import json, pathlib, shutil, sys

ext_dir = pathlib.Path(sys.argv[1])
ext_id = sys.argv[2]
obsolete = [x for x in sys.argv[3].split(",") if x]
drop_ids = set(obsolete + [ext_id])
removed = []
for child in list(ext_dir.iterdir()):
    if not child.is_dir():
        continue
    name = child.name
    drop = False
    for did in drop_ids:
        if name == did or name.startswith(did + "-"):
            drop = True
            break
    if drop:
        shutil.rmtree(child, ignore_errors=True)
        removed.append(name)

catalog = ext_dir / "extensions.json"
entries = []
if catalog.exists():
    try:
        raw = json.loads(catalog.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            entries = raw
    except json.JSONDecodeError:
        entries = []
kept = []
for item in entries:
    ident = item.get("identifier") if isinstance(item, dict) else None
    eid = ident.get("id") if isinstance(ident, dict) else None
    if eid in drop_ids:
        continue
    loc = item.get("location") if isinstance(item, dict) else None
    path = loc.get("path") if isinstance(loc, dict) else None
    pkg = pathlib.Path(path, "package.json") if isinstance(path, str) and path else None
    if pkg is not None and not pkg.is_file():
        continue
    kept.append(item)
catalog.write_text(json.dumps(kept, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
if removed:
    print("removed extension dirs: " + ", ".join(removed))
else:
    print("no extension dirs to remove")
print("synced " + str(catalog))
PY
  else
    die "missing python3 (needed to scrub extensions.json)"
  fi
}

echo "=== [1/4] Remove dsh plugin (dsh-review) ==="
if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile web remove dsh-review || true
else
  echo "dsh not on PATH; skip plugin remove"
fi
rm -f "$HOME/.dsh/profiles/web/.install-cache"/dsh-review-*.tgz
rm -rf "$HOME/.dsh/profiles/web/node_modules/dsh-review"
echo "cleared install-cache tarballs and leftover node_modules/dsh-review"

echo "=== [2/4] Remove VS Code extension ==="
if command -v code >/dev/null 2>&1; then
  code --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
  IFS=',' read -r -a _obsolete <<< "$EXT_OBSOLETE"
  for oid in "${_obsolete[@]}"; do
    code --uninstall-extension "$oid" >/dev/null 2>&1 || true
  done
else
  echo "code not on PATH; deleting extension folders only"
fi
purge_vscode_extension "$VSCODE_EXT_DIR"

echo "=== [3/4] Revert VS Code argv.json (enable-proposed-api) ==="
case "$(uname -s)" in
  Darwin)
    unmerge_argv "$HOME/Library/Application Support/Code/argv.json"
    if [ -d "$HOME/Library/Application Support/Code - Insiders" ]; then
      unmerge_argv "$HOME/Library/Application Support/Code - Insiders/argv.json"
    fi
    ;;
  Linux)
    unmerge_argv "${XDG_CONFIG_HOME:-$HOME/.config}/Code/argv.json"
    ;;
  *)
    echo "skip argv.json on this OS; use uninstall.ps1 on Windows"
    ;;
esac

echo "=== [4/4] Remove shadow store ==="
SHADOW="${DSH_HOME:-$HOME/.dsh}/review/shadow"
if [ -d "$SHADOW" ]; then
  rm -rf "$SHADOW"
  echo "removed $SHADOW"
else
  echo "no $SHADOW"
fi

echo "=== Done ==="
echo "1. Completely quit VS Code (Cmd+Q), then reopen."
echo "2. Restart dsh web if it is running."
echo "Cursor argv.json / extensions were not touched."
