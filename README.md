# dsh-review

dsh 插件 + VS Code 扩展：把 agent 的 write/edit 收成可逐 hunk 接受 / 撤回的行内审查。

## Features

![PixPin_2026-08-24_12-20-02.png](https://20040424.xyz/PicList/PixPin_2026-08-24_12-20-02.png)

- Shadow git 记录 write/edit（以及 shell `rm` 删除）
- VS Code 行内接受 / 撤回 hunk
- ipynb 选区指针含块号：`nb.ipynb C3 L1~L5`（跨块 `C2~C4`），普通文件仍为 `path L1~L2`
- 仅 VS Code iframe 内显示 dock；独立浏览器不改原生对话 UI

## Install
Mac:
```bash
./install.sh
```

Windows：

```cmd
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
需要重启dsh和vscode

## UnInstall

卸掉 dsh 插件 `dsh-review`、VS Code 扩展 `dsn.dsh-review-vscode`，并删除 shadow 目录。

Mac:

```bash
./uninstall.sh
```

Windows：

```cmd
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## Storage

```text
$DSH_HOME/review/shadow/
  repo.git/                 # shadow git位置
  pending/<wbHash>.json     # 记录文件的版本号
```

## License

MIT
