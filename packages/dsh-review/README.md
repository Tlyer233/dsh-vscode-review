# dsh-review

![banner](assets/banner.jpg)

## Features

![flow](assets/flow.png)

```text
dsh (write/edit) ─▶ review 插件 ─▶ 记录 before/after 快照 ($DSH_HOME/review/changes/)
                              └─▶ trae --diff <before快照> <当前文件> (自动打开 diff)
        ├─ review_status   列出改动并验证磁盘内容是否与写入一致 (match/drifted/missing)
        ├─ review_revert   用 before 快照还原（版本守卫，防覆盖新改动；新建文件则删除）
        └─ review_open     重新打开某个改动的 VSCODE diff
```

## Install

### 方式一：GitHub 分支安装（推荐）

```sh
dsh plugin --profile web add github:Tlyer233/dsh-vscode-review#dsh-review
```

安装后重启 dsh web 生效

### 方式二：源码目录安装

```sh
git clone https://github.com/Tlyer233/dsh-vscode-review.git
cd dsh-vscode-review
dsh plugin --profile web add ./packages/dsh-review
```

包会以 `link:` 指向本地源码目录，改代码后重启 dsh 即加载最新版。

### 配置覆盖

插件自带 `cordis.patch.yml`，插入的 row id 为 `review`。如需覆盖，在
`$DSH_HOME/profiles/web/cordis.patch.yml` 中按同一 id 覆盖该行的 config。

## Configuration

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoOpenDiff` | `true` | 每次 write/edit 成功后自动打开 Trae diff |
| `openOnRevert` | `true` | 撤回后打开 diff（左侧=改动前快照, 右侧=还原后文件） |
| `traeCommand` | `''` | 空=自动探测 Trae CLI；也可指向 `code --diff` 等同接口 |
| `reuseWindow` | `true` | 复用已打开的 Trae/VS Code 窗口 |
| `trackTools` | `['write','edit']` | 监听哪些工具 |
| `maxSnapshotBytes` | 10 MiB | before/after 快照上限；超出时 before 仅作预览、**不可撤回** |

## Tools

- `review_status`：参数 `file_path?` / `limit?` / `include_reverted?`。逐条返回
  `verified`（match=磁盘内容==写入内容；drifted=之后被人改过；missing=文件没了；reverted=已撤回），
  以及增删行数统计。
- `review_revert`：`file_path`（必填）+ `change_id?`（默认最新一条未撤回记录）。
  用 before 快照写回，附**版本守卫**：文件在 AI 写入之后又被改过则拒绝（`FS_STALE_VERSION`），
  避免覆盖手动修改。AI 新建的文件撤销 = 删除该文件。
- `review_open`：`file_path?` / `change_id?`，重新打开该改动的 Trae diff。

## Change manifest

存储根：`$DSH_HOME/review/changes/`（`DSH_HOME` 默认 `~/.dsh`），每次改动：

- `<id>.json` — 清单（**可变状态**，单一口径；字段见 `lib/review-journal.js` 头注释）
- `<id>.before` — 改动前全文（`beforeAvailable=true` 时完整且可撤回；`beforeTruncated=true` 时仅预览）
- `<id>.after` — 改动后全文

IDE 扩展只需监听该目录：新 `<id>.json` 出现即打开 diff；撤回按钮 = 把 `<id>.before` 写回真实文件。
配套的 VS Code / Trae 扩展见 [`vscode_dsh_plugin`](https://github.com/Tlyer233/vscode_dsh_plugin)。

## Design notes

- **零运行时依赖**：不 import 任何 `@deepseek-ai/*`，主模块可被 dsh 直接装载，也能独立冒烟测试。
- **挂载点**：`tools/pre-execute`（捕获 before 预览）、`fs/observed`（记录写入后版本）、
  `tools/result`（入账 + 打开 diff），均为 dsh 公开宿主事件。
- **`diffBasisMaxBytes`（默认 10 MiB）**：后端超限时不返回 before 全文 → 只记录预览、不可自动撤回。
- **本地路径**：Trae diff 右侧使用后端 `displayPath`（本地绝对路径）；远程/沙箱后端暂不支持。
- **删除非一等公民**：`ctx.fs` 无 delete 原语，新建文件的撤回由插件直接用 node fs 删除。

## Development

```sh
node test/smoke.mjs
```

## License

MIT
