#!/usr/bin/env bash
# One-click install: dsh plugin + VS Code extension + editorInsets argv.json
# Idempotent: safe to re-run. Replaces the current dsh-review VS Code extension.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="dsn.dsh-review-vscode"
EXT_VER="0.1.11"
DSH_PLUGIN="$ROOT/dsh-review"
VSCODE_SRC="$ROOT/dsh-review-vscode"
VSCODE_EXT_DIR="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# Write EXT_ID into argv.json enable-proposed-api (keeps comments / other ids).
# No-op if already listed.
merge_argv() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  if [ ! -f "$file" ]; then
    printf '{\n\t"enable-proposed-api": ["%s"]\n}\n' "$EXT_ID" > "$file"
    echo "created $file"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    local st=0
    python3 - "$file" "$EXT_ID" <<'PY' || st=$?
import pathlib, re, json, sys
path = pathlib.Path(sys.argv[1])
ext_id = sys.argv[2]
text = path.read_text(encoding="utf-8")
m = re.search(r'"enable-proposed-api"\s*:\s*(\[[^\]]*\])', text)
if m:
    arr = json.loads(m.group(1))
    cleaned = []
    for item in arr:
        if item not in cleaned:
            cleaned.append(item)
    if ext_id not in cleaned:
        cleaned.append(ext_id)
    if cleaned != arr:
        text = text[: m.start(1)] + json.dumps(cleaned) + text[m.end(1) :]
        path.write_text(text, encoding="utf-8")
        sys.exit(0)
    sys.exit(3)
sys.exit(2)
PY
    if [ "$st" -eq 0 ]; then
      echo "updated $file"
      return
    fi
    if [ "$st" -eq 3 ]; then
      echo "already listed in $file"
      return
    fi
  fi

  if grep -Fq "$EXT_ID" "$file"; then
    echo "already listed in $file"
    return
  fi

  local tmp="${file}.tmp"
  if grep -q '"enable-proposed-api"' "$file"; then
    awk -v id="$EXT_ID" '
      BEGIN { done=0 }
      {
        if (!done && $0 ~ /"enable-proposed-api"[[:space:]]*:[[:space:]]*\[/) {
          if (index($0, "\"" id "\"") == 0) sub(/\[/, "[\"" id "\", ")
          done=1
        }
        print
      }
    ' "$file" > "$tmp"
  else
    awk -v id="$EXT_ID" '
      BEGIN { done=0 }
      {
        if (!done && index($0, "{") > 0) {
          print
          print "\t\"enable-proposed-api\": [\"" id "\"],"
          done=1
          next
        }
        print
      }
    ' "$file" > "$tmp"
  fi
  mv "$tmp" "$file"
  echo "updated $file"
}

# Keep extensions.json in sync with dsn.dsh-review-vscode.
# copy: replace other versions of EXT_ID. vsix: leave catalog rows that still exist.
sync_vscode_extension_catalog() {
  local ext_dir="$1"
  local mode="$2"
  mkdir -p "$ext_dir"
  python3 - "$ext_dir" "$EXT_ID" "$EXT_VER" "$mode" <<'PY'
import json, pathlib, shutil, sys, time

ext_dir = pathlib.Path(sys.argv[1])
ext_id = sys.argv[2]
ext_ver = sys.argv[3]
mode = sys.argv[4] if len(sys.argv) > 4 else "copy"
dest_name = f"{ext_id}-{ext_ver}"
dest = ext_dir / dest_name
catalog = ext_dir / "extensions.json"
drop_ids = set()
if mode == "copy":
    drop_ids.add(ext_id)

removed = []
for child in list(ext_dir.iterdir()):
    if not child.is_dir():
        continue
    name = child.name
    drop = False
    if mode == "copy" and name.startswith(ext_id + "-") and name != dest_name:
        drop = True
    if drop:
        shutil.rmtree(child, ignore_errors=True)
        removed.append(name)

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

if mode == "copy" and dest.joinpath("package.json").is_file():
    kept.append({
        "identifier": {"id": ext_id},
        "version": ext_ver,
        "location": {"$mid": 1, "path": str(dest), "scheme": "file"},
        "relativeLocation": dest_name,
        "metadata": {
            "installedTimestamp": int(time.time() * 1000),
            "pinned": True,
            "source": "vsix",
            "isPreReleaseVersion": False,
        },
    })

catalog.write_text(json.dumps(kept, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
if removed:
    print("removed old extension dirs: " + ", ".join(removed))
else:
    print("no old extension dirs to remove")
print("synced " + str(catalog))
PY
}

install_vscode_extension() {
  mkdir -p "$VSCODE_EXT_DIR"
  need python3

  VSIX="$(find "$VSCODE_SRC" -maxdepth 1 -name '*.vsix' | head -n 1 || true)"
  if [ -n "${VSIX:-}" ] && [ -f "$VSIX" ]; then
    need code
    code --install-extension "$VSIX" --force
    sync_vscode_extension_catalog "$VSCODE_EXT_DIR" vsix
  else
    echo "VSIX not found; copying source into $VSCODE_EXT_DIR"
    DEST="$VSCODE_EXT_DIR/${EXT_ID}-${EXT_VER}"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp "$VSCODE_SRC/extension.js" "$VSCODE_SRC/package.json" "$DEST/"
    cp -R "$VSCODE_SRC/lib" "$VSCODE_SRC/media" "$DEST/"
    [ -d "$VSCODE_SRC/scripts" ] && cp -R "$VSCODE_SRC/scripts" "$DEST/"
    [ -d "$VSCODE_SRC/node_modules" ] && cp -R "$VSCODE_SRC/node_modules" "$DEST/"
    sync_vscode_extension_catalog "$VSCODE_EXT_DIR" copy
  fi
}

install_dsh_plugin() {
  [ -d "$DSH_PLUGIN" ] || die "missing $DSH_PLUGIN"
  local cache="$HOME/.dsh/profiles/web/.install-cache"
  mkdir -p "$cache"
  # Durable tarball: pnpm records file:<tgz>; do not pack into /tmp.
  # Keep old tarballs until the new one is installed: pnpm re-resolves the
  # previously recorded file:<tgz> spec during add, and a missing file makes
  # the whole install fail with ENOENT.
  if command -v npm >/dev/null 2>&1; then
    (cd "$DSH_PLUGIN" && npm pack --pack-destination "$cache")
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$DSH_PLUGIN" && pnpm pack --pack-destination "$cache")
  else
    die "need npm or pnpm to pack dsh-review (adding the folder would link, not copy)"
  fi
  local tgz=""
  local f
  for f in "$cache"/dsh-review-*.tgz; do
    case "${f##*/}" in
      dsh-review-[0-9]*.tgz) tgz="$f" ;; # newest wins (glob is sorted)
    esac
  done
  [ -n "$tgz" ] || die "pack produced no tarball in $cache"
  echo "packed $tgz"
  echo "installing a copy into the web profile (not a source-tree link)"
  # --force: same version must still replace the previous tarball copy.
  dsh plugin --profile web add "$tgz" --force
  # Installed: drop stale tarballs, keep only the recorded one.
  local keep
  keep="$(basename "$tgz")"
  for f in "$cache"/dsh-review-*.tgz; do
    [ "${f##*/}" = "$keep" ] || rm -f "$f"
  done
}

# Drop leftover shadow commits + pending hashes (blob/commit mix breaks review).
# Matches dsh-review/shadow.js ensureShadowRepo identity.
reset_shadow_store() {
  local home="${DSH_HOME:-$HOME/.dsh}"
  local root="$home/review/shadow"
  local gitdir="$root/repo.git"
  local pend="$root/pending"
  need git
  mkdir -p "$pend"
  rm -rf "$gitdir"
  git init --bare --template= "$gitdir"
  git --git-dir="$gitdir" config commit.gpgSign false
  git --git-dir="$gitdir" config user.name dsh-shadow
  git --git-dir="$gitdir" config user.email shadow@localhost
  rm -f "$root"/.index-*
  local f
  shopt -s nullglob
  for f in "$pend"/*.json; do
    printf '[]\n' > "$f"
  done
  shopt -u nullglob
  echo "reset shadow git $gitdir"
  echo "emptied pending $pend/*.json"
}

echo "=== [1/4] Install dsh plugin (dsh-review) ==="
need dsh
install_dsh_plugin

echo "=== [2/4] Install VS Code extension ==="
[ -d "$VSCODE_SRC" ] || die "missing $VSCODE_SRC"
install_vscode_extension

echo "=== [3/4] Enable editorInsets in VS Code argv.json ==="
merge_argv "$HOME/.vscode/argv.json"
case "$(uname -s)" in
  Darwin)
    merge_argv "$HOME/Library/Application Support/Code/argv.json"
    if [ -d "$HOME/Library/Application Support/Code - Insiders" ]; then
      merge_argv "$HOME/Library/Application Support/Code - Insiders/argv.json"
    fi
    ;;
  Linux)
    merge_argv "${XDG_CONFIG_HOME:-$HOME/.config}/Code/argv.json"
    ;;
esac

echo "=== [4/4] Reset dsh-review shadow git ==="
reset_shadow_store

echo "=== Done ==="
echo "1. Completely quit VS Code (Cmd+Q), then reopen from Dock."
echo "2. Restart dsh web (or use the sidebar Restart button)."
echo "3. Shadow store was wiped (repo.git + pending/*.json). Unreviewed diffs are gone."
echo "editorInsets argv.json id: $EXT_ID"
echo "dsh-review is copied into ~/.dsh/profiles/web (source folder can be deleted)."
echo "Re-run this script to upgrade both the dsh plugin and the VS Code extension."
