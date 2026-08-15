# dsh-vscode-review

VS Code review 体验的两个 dsh 插件（一个仓库，两个分支）：

- **`@dsn/dsh-review`**（分支 `dsh-review`）：记录 AI 每次 write/edit 的 before/after 快照，写入 `$DSH_HOME/review/changes`。
- **`review-changes`**（分支 `dsh-review-changes`）：dsh web 输入框上方的 Review Changes 面板 + VSCode 侧栏桥（发送选区 / 拖文件 / tag / 批量 AC/RJ）。

## 一键安装（web profile）

```bash
dsh plugin --profile web add github:Tlyer233/dsh-vscode-review#dsh-review github:Tlyer233/dsh-vscode-review#dsh-review-changes
```

> `dsh plugin` 会自动把带 `dsh.bundle` 的依赖加进 profile 的 bundles，装完重启 dsh 即可。
> 如果 profile 里之前用 `link:` 装的同名开发包，上面命令会直接替换成 GitHub 版本。

## 升级

```bash
dsh plugin --profile web update @dsn/dsh-review review-changes
```

## 卸载

```bash
dsh plugin --profile web remove @dsn/dsh-review review-changes
```

## 配套 VSCode 扩展

仓库：https://github.com/Tlyer233/vscode_dsh_plugin
下载 Release 里的 `.vsix`，在 VSCode 扩展面板 “... → Install from VSIX” 安装。
