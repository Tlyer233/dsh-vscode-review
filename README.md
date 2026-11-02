# dsh-review

dsh 插件 + VS Code 扩展：把 agent 的 write/edit 收成可逐 hunk 接受 / 撤回的行内审查。

## Features

![PixPin_2026-08-24_12-20-02.png](https://20040424.xyz/PicList/PixPin_2026-08-24_12-20-02.png)

- Shadow git 记录 write/edit（以及 shell `rm` 删除）
- VS Code 行内接受 / 撤回 hunk
- ipynb 选区指针含块号：`nb.ipynb C3 L1~L5`（跨块 `C2~C4`），普通文件仍为 `path L1~L2`
- 仅 VS Code iframe 内显示 dock；独立浏览器不改原生对话 UI

## Install

macOS / Linux(一行命令,走 gh-proxy 镜像,可去掉 `https://gh-proxy.com/` 前缀直连):

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Tlyer233/dsh-vscode-review/v2.1.1/install.sh | bash
```

Windows(PowerShell;`install.ps1` 自 v2.1.1 起与 install.sh 同规格,首次实跑请回传日志):

```powershell
irm https://gh-proxy.com/https://raw.githubusercontent.com/Tlyer233/dsh-vscode-review/v2.1.1/install.ps1 -UseBasicParsing | iex
```

装了之后:完全退出 VS Code(Cmd+Q / File>Exit)再开,并重启 dsh web。脚本干四件事:dsh 插件(web profile,拷贝制非链接)、VS Code 扩展(注册表同步)、argv.json(`enable-proposed-api` + `remote-debugging-port 9223`)、`remote.extensionKind=ui`(SSH 窗口必需);并重置 shadow git。离线物料在 [Releases](https://github.com/Tlyer233/dsh-vscode-review/releases) 页(vsix + tgz)。

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
