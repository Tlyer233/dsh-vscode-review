#!/usr/bin/env bash
# One-click install: dsh plugin + VS Code extension + editorInsets argv.json
# Idempotent: safe to re-run. Replaces the current dsh-review VS Code extension.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="dsn.dsh-review-vscode"
EXT_VER="$(node -p "require('$ROOT/dsh-review-vscode/package.json').version")"
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

# 0.1.24: drop keybindings.json rows that can never fire, so the extension's own
# cmd+l / shift+cmd+l contributions are not shadowed. Two stale shapes exist in
# the wild: `focusedView == "explorer"` (the pre-1.142 explorer view id — 1.142
# reports workbench.explorer.fileView) and `focusedView == '\"explorer\"'`
# (double-escaped when the when-clause was copied out of package.json, so the
# literal keeps its quote characters and never matches). Backs the file up and
# keeps the surviving rows verbatim, so the user's formatting is untouched.
prune_stale_dsh_keybindings() {
  local kb=""
  case "$(uname -s)" in
    Darwin) kb="$HOME/Library/Application Support/Code/User/keybindings.json" ;;
    Linux)  kb="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User/keybindings.json" ;;
    MING*|MSYS*|CYGWIN*) [ -n "${APPDATA:-}" ] && kb="$APPDATA/Code/User/keybindings.json" ;;
  esac
  if [ -z "$kb" ] || [ ! -f "$kb" ]; then
    echo "keybindings.json not found — no stale dsh rows to prune"
    return 0
  fi
  need python3
  python3 - "$kb" <<'PY'
import json, re, shutil, sys, time

path = sys.argv[1]
raw = open(path, encoding='utf-8').read()
start = raw.find('[')
if start < 0:
    print('keybindings.json: no JSON array — skipped'); raise SystemExit(0)


def close_index(text, open_ch, close_ch):
    """Index of the close_ch matching the open_ch at position 0 (string aware)."""
    depth, in_str, esc = 0, False, False
    for i, c in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return -1


end = close_index(raw[start:], '[', ']')
if end < 0:
    print('keybindings.json: array never closes — skipped'); raise SystemExit(0)
end += start
body = raw[start + 1:end]

# split the array body on top-level commas; each chunk keeps its own text
chunks, buf, depth, in_str, esc = [], [], 0, False, False
for c in body:
    if in_str:
        buf.append(c)
        if esc:
            esc = False
        elif c == '\\':
            esc = True
        elif c == '"':
            in_str = False
        continue
    if c == '"':
        in_str = True
        buf.append(c)
        continue
    if c in '[{':
        depth += 1
    elif c in ']}':
        depth -= 1
    if c == ',' and depth == 0:
        chunks.append(''.join(buf))
        buf = []
    else:
        buf.append(c)
if buf:
    chunks.append(''.join(buf))


def strip_line_comments(text):
    out, in_str, esc = [], False, False
    for line in text.split('\n'):
        s, has_str = [], in_str
        prev = ''
        for ch in line:
            if has_str:
                if esc:
                    esc = False
                elif ch == '\\':
                    esc = True
                elif ch == '"':
                    has_str = False
            elif ch == '/' and prev == '/':
                s = s[:-1]
                break
            s.append(ch)
            if ch == '"':
                has_str = True
            prev = ch
        out.append(''.join(s))
    return '\n'.join(out)


WHEN_RE = re.compile(r"""focusedView\s*==\s*(?:"([^"]*)"|'([^']*)')""")


def is_stale(chunk):
    if 'dshReview.' not in chunk or 'focusedView' not in chunk:
        return False
    txt = strip_line_comments(chunk).strip().rstrip(',').strip()
    obj = None
    try:
        obj = json.loads(txt)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        # "-command" removes a contribution, "+command" re-adds it — the name
        # itself follows the sign, so strip it before matching our extension.
        if not str(obj.get('command') or '').lstrip('+-').startswith('dshReview.'):
            return False
        m = WHEN_RE.search(str(obj.get('when') or ''))
        if not m:
            return False
        val = m.group(1) if m.group(1) is not None else m.group(2)
        return val == 'explorer' or val.startswith('"')
    # unparseable chunk: only touch the unmistakable double-escaped form
    return bool(re.search(r'focusedView\s*==\s*\\?"explorer\\?"', chunk))


removed = [c for c in chunks if is_stale(c)]
if not removed:
    print('keybindings.json: no stale dsh rows (%d row(s) kept)' % len(chunks))
    raise SystemExit(0)

kept = [c for c in chunks if not is_stale(c) and c.strip()]
bak = '%s.bak-%s' % (path, time.strftime('%Y%m%d%H%M%S'))
shutil.copy2(path, bak)
out = raw[:start] + '[' + ',\n'.join(kept) + ']' + raw[end + 1:]
open(path, 'w', encoding='utf-8').write(out)
print('keybindings.json: removed %d stale dsh row(s); backup %s' % (len(removed), bak))
for c in removed:
    print('  - ' + ' '.join(c.strip().split())[:150])
PY
}

echo "=== [1/4] Install dsh plugin (dsh-review) ==="
need dsh
install_dsh_plugin

echo "=== [2/4] Install VS Code extension ==="
[ -d "$VSCODE_SRC" ] || die "missing $VSCODE_SRC"
install_vscode_extension
prune_stale_dsh_keybindings

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
