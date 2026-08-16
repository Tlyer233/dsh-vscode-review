# dsh-review-vscode

**dsh review 的 VS Code 扩展**：当 dsh 插件记下一次 AI 的 write/edit 时，**自动在当前 VS Code 里弹出该改动的『行内 diff』**（inline，不是左右并排），并提供一条命令撤回。全程不依赖 git。

## 它做什么

- 监听 dsh 插件的 change-manifest 存储（默认 `~/.dsh/review/changes/`）
- 新的 `<id>.json` 出现 → 立即用 `vscode.diff(before快照, 真实文件)` 打开 diff，并**自动切到行内模式**（`toggle.diff.renderSideBySide` 命令 / `diffEditor.renderSideBySide` 配置）
- 命令面板三条命令：
  - `dsh review: Show diff for active file` — 手动打开当前文件的最近一次改动 diff
  - `dsh review: Revert active file to before-state` — 把 before 快照写回文件（AI 新建的文件则删除），并同步把 manifest 标记为 `reverted`
  - `dsh review: Show change log` — 输出面板列出全部改动及 match/drifted/missing 校验

## 运行（开发模式，无需打包）

1. 确保 dsh web 已重启（使 `autoOpenDiff: false` 的 patch 生效，Trae 不再弹）
2. 启动 VS Code 扩展开发窗口：

```sh
cd "/Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsn plugins/dsh-review-vscode"
code --extensionDevelopmentPath=$PWD
```

   （在打开的 VS Code 窗口里，`查看 → 输出`，右上角选 `dsh review` 频道可看日志）

3. 让 dsh AI 改一个文件（或直接在这里改我是插件 dev 目录，我会触发一次测试写入）
4. VS Code 里应自动弹出该文件的行内 diff —— 左侧是改动前快照，右侧是当前文件

## 安装为正式扩展（可选，以后再说）

```sh
npm i -g @vscode/vsce && vsce package
code --install-extension dsh-review-vscode-0.1.0.vsix
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dshReview.storeDir` | 空 | dsh 插件 change-store 路径；空 = `$DSH_HOME/review/changes`（默认 `~/.dsh/review/changes`） |

扩展对 manifest 的读写与 dsh 插件共用同一文件（单一口径）：扩展撤回后写 `status: reverted`，dsh 侧的 `review_status` 同样可见。

## 已验证的接口（VS Code 1.133.0）

- `vscode.diff` 命令 ID（workbench bundle 内确认）
- `diffEditor.renderSideBySide` 配置（`type: boolean, default: true` → false 即行内）
- `toggle.diff.renderSideBySide` / `workbench.action.toggleDiffRenderSideBySide` 切换命令（按版本自动选择存在的那个）

## 测试

```sh
node test/node-test.mjs
```

覆盖：manifest 解析/排序/查找（绝对路径、basename、key: 前缀、change_id 固定）、before/after 快照路径、verify（match/drifted/missing）、revert（update 写回 / create 删除 / 已撤回拒绝 / 无快照拒绝）、storeDir 解析（DSH_HOME、~/、自定义）。

