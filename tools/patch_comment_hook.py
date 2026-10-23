#!/usr/bin/env python3
"""
Patch VS Code's own browser element-comment flow so each comment is also POSTed to the
dsh-review extension (http://127.0.0.1:PORT/dsh-comment).

Why: the native comment box is rendered in a layer CDP cannot reach, so an extension
cannot read it. The only lever is a few bytes inside the shipped bundle — VS Code ships
out/ as a plain directory, so this is the same class of edit patch-copilot does.

Both bundles carry the byte-identical call site (workbench + sessions/agent host), and
we cannot tell from outside which one renders the user's tab, so we patch both; the
extension dedupes, so a double beacon is harmless.

  python3 tools/patch_comment_hook.py            # apply (idempotent)
  python3 tools/patch_comment_hook.py --revert    # restore from .dsh-bak
  python3 tools/patch_comment_hook.py --check     # report state
"""
import argparse
import json
import os
import shutil
import sys

APP = "/Applications/Visual Studio Code.app/Contents/Resources/app"
OUT = os.path.join(APP, "out")
FILES = [
    os.path.join(OUT, "vs/workbench/workbench.desktop.main.js"),
    os.path.join(OUT, "vs/sessions/sessions.desktop.main.js"),
]
PORT = 43167

# The success path of adding an element comment to a chat widget, verbatim from the
# shipped bundle (count must be exactly 1 per file).
ANCHOR = '!1;t.elementSelectionState.active?this._commentSessionsWithComments.add(t):v.focusInput()}'

BEACON = (
    '(function(){var q={ev:"dsh-native-comment",url:String((f&&f.url)||(t&&t.url)||(e&&e.url)||"").slice(0,400),'
    'name:String((f&&f.name)||"").slice(0,200),comment:String(e.comment||"").slice(0,8000),'
    'elementId:String(e.elementId||"").slice(0,80)};'
    # workbench CSP drops fetch/Image (measured: nothing ever reached the listener), so
    # also park it on globalThis — the extension reads that back over CDP.
    'try{(globalThis.__dshNativeComments=globalThis.__dshNativeComments||[]).push(q)}catch(_c){}'
    'var u="http://127.0.0.1:%d/dsh-comment?d="+encodeURIComponent(JSON.stringify(q));'
    'try{fetch(u,{mode:"no-cors"}).catch(function(){})}catch(_a){}'
    'try{(new Image()).src=u}catch(_b){}})();' % PORT
)

REPL = '!1;try{' + BEACON + '}catch(_dsh){}t.elementSelectionState.active?this._commentSessionsWithComments.add(t):v.focusInput()}'


def version():
    try:
        return json.load(open(os.path.join(APP, "package.json"), encoding="utf-8")).get("version", "unknown")
    except Exception:
        return "unknown"


def state(path):
    s = open(path, encoding="utf-8", errors="ignore").read()
    return {"patched": BEACON in s, "anchor": s.count(ANCHOR), "bak": os.path.exists(path + ".dsh-bak")}


def apply_one(path, log):
    if not os.path.exists(path):
        log("  skip (no such file): " + path)
        return False
    s = open(path, encoding="utf-8").read()
    if BEACON in s:
        log("  already patched: " + os.path.basename(path))
        return True
    if "dsh-native-comment" in s:
        # an older beacon version is in place: restore the pristine file first, then patch
        bak = path + ".dsh-bak"
        if os.path.exists(bak):
            shutil.copy2(bak, path)
            log("  upgraded: restored pristine copy before re-patching")
            s = open(path, encoding="utf-8").read()
    n = s.count(ANCHOR)
    if n != 1:
        log("  SKIP " + os.path.basename(path) + ": anchor found " + str(n) + " times (VS Code updated? re-locate the call site)")
        return False
    bak = path + ".dsh-bak"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        log("  backup: " + os.path.basename(bak))
    open(path, "w", encoding="utf-8").write(s.replace(ANCHOR, REPL))
    after = open(path, encoding="utf-8").read()
    ok = after.count(BEACON) == 1
    log(("  patched " if ok else "  VERIFY FAILED ") + os.path.basename(path) + " (port " + str(PORT) + ")")
    return ok


def revert_one(path, log):
    bak = path + ".dsh-bak"
    if not os.path.exists(bak):
        log("  no backup for " + os.path.basename(path))
        return False
    shutil.copy2(bak, path)
    log("  reverted " + os.path.basename(path))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    print("VS Code " + version() + " — comment hook on port " + str(PORT))
    results = []
    for p in FILES:
        if args.check:
            st = state(p)
            print("  " + os.path.basename(p) + ": patched=" + str(st["patched"]) + " anchor=" + str(st["anchor"]) + " backup=" + str(st["bak"]))
        elif args.revert:
            results.append(revert_one(p, print))
        else:
            results.append(apply_one(p, print))
    if args.revert:
        print("reverted; restart VS Code (Cmd+Q) to drop the hook")
    elif not args.check:
        print("done. restart VS Code (Cmd+Q); native comments will also arrive in dsh")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
