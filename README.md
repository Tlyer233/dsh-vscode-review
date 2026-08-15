# dsh-vscode-review

VS Code review 体验的 dsh 插件（monorepo，含两个可安装插件）：

| 插件 | 目录 | 作用 |
|---|---|---|
| `@dsn/dsh-review` | [packages/dsh-review](packages/dsh-review) | 记录 AI 每次 write/edit 的 before/after 快照 |
| `review-changes` | [packages/dsh-review-changes](packages/dsh-review-changes) | Web 输入框上方的 Review Changes 面板 + VSCode 桥（选区/tag/拖文件/批量 AC/RJ） |

## 一键安装（web profile）

```bash
dsh plugin --profile web add github:Tlyer233/dsh-vscode-review#dsh-review github:Tlyer233/dsh-vscode-review#dsh-review-changes
```

`dsh plugin` 会自动把带 `dsh.bundle` 的依赖加入 profile bundles，装完重启 dsh 即可。
profile 里之前用 `link:` 装的同名开发包会被上面的命令替换成 GitHub 版本。

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
下载 Release 的 `.vsix`，在 VSCode 扩展面板 “... → Install from VSIX” 安装。
