# dsh-review

- **Host**: shadow git + pending under `$DSH_HOME/review/shadow` (default `~/.dsh/review/shadow`)
- **Client**: VS Code iframe bridge (chips / Shift-drag / clipboard / workbench scope)
- **Dock**: only when `inVSCodeIframe && workbenchMatch`; pending via VS Code watcher `postMessage` (no 500ms poll); mount reads once; no AC/RJ ALL

## Storage

```text
~/.dsh/review/shadow/
  repo.git/                    # one global bare shadow repo
  pending/<wbHash>.json        # per-workbench pending list
```

- Edits from a session go into that session's `pending/<wbHash>.json` (`workbench` = `session.header.cwd`)
- `filePath` may lie outside the workbench folder
- Git: bare `repo.git`; each snapshot only stores the touched file at `files/<sha1(absPath)>` (no full-tree `add -A`)

## Install

Pack then add (copy, not a source-tree link):

```bash
npm pack ./dsh-review
dsh plugin --profile web add ./dsh-review-0.1.0.tgz --force
```

Or from the repo root: `./install.sh` / `.\install.ps1`.

### Remove

```
dsh plugin --profile web remove dsh-review
```
