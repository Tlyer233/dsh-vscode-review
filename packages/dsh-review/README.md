# @dsn/dsh-review

dsh 的 **review 插件**：AI 每次用 `write` / `edit` 修改文件时，自动记录改动并打开 **Trae** 的双文件 diff 视图；提供三个工具让模型（和你）审查、验证、撤回改动——**全程不依赖 git**。

```
dsh (write/edit) ─▶ review 插件 ─▶ 记录 before/after 快照 ($DSH_HOME/review/changes/)
                              └─▶ trae --diff <before快照> <当前文件> (自动打开 diff)
        ├─ review_status   列出改动并验证磁盘内容是否与写入一致 (match/drifted/missing)
        ├─ review_revert   用 before 快照还原（版本守卫，防覆盖新改动；新建文件则删除）
        └─ review_open     重新打开某个改动的 Trae diff
```

## 安装（web profile）

```sh
cd "/Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsn plugins"
dsh plugin --profile web add "$PWD/dsh-review"     # pnpm add + 自动加入 bundles
dsh --profile web --dump-config | grep -A8 "id: review"   # 确认行已合成
# 重启 dsh web 生效（重启后恢复会话即可）
```

- 包通过 `link:` 指向源码目录，改代码即时生效（重启 dsh 后加载最新版）。
- 配置文件：插件自带 `cordis.patch.yml` insert `id: review`；如需覆盖，在
  `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖该行的 config。

## 配置项（row config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoOpenDiff` | `true` | 每次 write/edit 成功后自动打开 Trae diff |
| `openOnRevert` | `true` | 撤回后打开 diff（左侧=改动前快照, 右侧=还原后文件） |
| `traeCommand` | `''` | 空=自动探测 `/Applications/Trae.app/.../bin/trae` 等；也可指向 VS Code CLI（`code --diff` 同接口） |
| `reuseWindow` | `true` | 传 `--reuse-window` 复用已打开的 Trae 窗口 |
| `trackTools` | `['write','edit']` | 监听哪些工具 |
| `maxSnapshotBytes` | 10 MiB | before/after 快照上限；超出时 before 仅作预览、**不可撤回** |

## 三个工具

- `review_status`：参数 `file_path?` / `limit?` / `include_reverted?`。逐条返回
  `verified`（match=磁盘内容==写入内容；drifted=之后被人改过；missing=文件没了；reverted=已撤回），
  以及增删行数统计。
- `review_revert`：`file_path`（必填）+ `change_id?`（默认最新一条未撤回记录）。
  用 before 快照写回，附**版本守卫**：文件在 AI 写入之后又被改过则拒绝（`FS_STALE_VERSION`），
  避免覆盖你的手动修改。AI 新建的文件撤销 = 删除该文件。
- `review_open`：`file_path?` / `change_id?`，重新打开该改动的 Trae diff。

## Trae 侧的"撤回"

diff 编辑器左侧 = 改动前快照，右侧 = 当前文件。手动撤回：在 Trae diff 工具栏
**将左侧内容复制到右侧**（Copy Left Side to Right Side）并保存即可——同样不经过 git。
代码侧的 `review_revert` 与手工复制用的是同一份 before 快照，两端结果一致。

## change-manifest 协议（供未来的 Trae/VS Code 扩展读取）

存储根：`$DSH_HOME/review/changes/`（`DSH_HOME` 默认 `~/.dsh`），每次改动：

- `<id>.json`   — 清单（**可变状态**，单一口径；字段见 `lib/review-journal.js` 头注释）
- `<id>.before` — 改动前全文（`beforeAvailable=true` 时完整且可撤回；`beforeTruncated=true` 时仅预览）
- `<id>.after`  — 改动后全文

IDE 扩展只需：`createFileSystemWatcher` 监听该目录 → 新 `<id>.json` 出现即
`vscode.diff(beforeFile, 真实文件)` 打开；撤回按钮 = 把 `<id>.before` 写回真实文件。
同一扩展同时兼容 Trae（VS Code 分支）与 VS Code。

## 设计要点 / 限制

- **零运行时依赖**：插件不 import 任何 `@deepseek-ai/*`，主模块可被 dsh 直接按行装载，
  也能被独立冒烟测试直接 import。
- **挂载点**：`tools/pre-execute`（捕获 before 预览）、`fs/observed`（记录写入后版本）、
  `tools/result`（入账+开 diff）。都是 dsh 公开、稳定的宿主平面事件（无 scope 的监听器能收到所有 agent 的工具事件）。
- **`diffBasisMaxBytes`（默认 10MiB）**：后端超限时不返回 before 全文 → 该改动只记录预览、不可自动撤回。
- **本地路径**：Trae diff 右侧用的是后端 `displayPath`（本地绝对路径）；远程/沙箱后端暂不支持打开。
- **删除非一等公民**：`ctx.fs` 无 delete 原语，新建文件"撤回"由插件直接用 node fs 删除。

## 测试

```sh
node test/smoke.mjs        # 独立冒烟：入账/快照/trae 调用/review_status 校验/版本守卫撤回/新建删除
```

