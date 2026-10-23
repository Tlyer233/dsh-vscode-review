# Changelog

## 维护指南:以后遇到"某种文件点了打不开 / 点不动"怎么处理(0.1.60 定稿,先查这页再动手)

排查顺序(日志先行,别猜):

1. **看扩展日志**(客户端拦截与扩展打开都会写这里):
   `ls -t ~/Library/Application\ Support/Code/logs/*/window*/exthost/output_logging_*/"2-dsh review  dsh.log" | head -1`
   ⚠ 文件名是**两个空格**;每次点击都会留一行 `openFile missing/failed/openFile <路径>`。
2. **按现象对号入座**:

   | 现象 | 结论 | 处理 |
   | --- | --- | --- |
   | 完全无日志(客户端没发 `dshOpenFile`) | 客户端拦截面没覆盖这个新表面 | 对照社区拦截表面表(dsh-artifact-viewer:工具行→textContent、chip/提及→title、md链接→href),在 client.js `fileOpenTargetPath` 加对应 DOM 特征;类名 token 两种 CSS-module 命名都要认(`_X_<hash>` 与 `<hash>_X`) |
   | 日志 `openFile missing: X` | X 解析不到文件 | `:行号` 已剥、basename 截短标签已全库搜;仍没有 = 文件确实不存在,右下角已自动弹提示。**例外(0.1.23 已修)**:X 以 `~` 开头(如 `~/dsh/skills/...`)时文件其实在家目录——`path.isAbsolute("~/…")` 为 false,曾按 `<工作区>/~/…` 解析且工作区搜不到家目录;现 `openFileFromDsh` 开头用 `os.homedir()` 展开行首 `~` 再判断。若再现 missing 且**不是** `~` 开头,先看 X 是否**纯文件名**(用户消息附件 chip):0.1.26/0.1.70 已双层修——客户端从 chip 的 React props/`img.src` 取绝对路径(`[chip] props …` 探针行),扩展 workspace 搜空后有界扫 `~/.dsh`+`/tmp`(深≤4、精确名、实测最坏 18ms,日志 `openFile fs-scan:`)。仍 missing = 真没了(**RustDesk/PixPin 类剪贴板中继会清 /tmp 旧图**,历史截图 chip 点开 missing 属正常) |
   | 日志 `openFile failed: Binary contents are not supported` | 文本通道拒二进制 | 已有 `vscode.open` 兜底,正常不该再现;再现=兜底没走到,查 `openFileFromDsh` 分支 |
   | 日志 `openFile failed: <其他>` 且右下角弹"打开失败" | `vscode.open` 也开不了 = VS Code 没装能开该类型的编辑器(如 .psd/.excalidraw) | 属**编辑器生态问题**不是插件问题:装对应 VS Code 扩展即可;若需插件特殊处理某扩展名,在 `openFileFromDsh` 按扩展名加分支 |
   | **拖文件进侧栏**:overlay 闪一下就没 / 拖放无效 | VS Code ≥1.90 的 Shift 设计:拖文件未按 Shift 时 webview 被 `pointer-events:none`(#182449 / PR#209211),非插件回归 | **实测(0.1.20 后)**:拖到**输入框/附件条区域**可直接拖入——dsh 自己的 dropzone 在 dragenter 就 preventDefault,走了官方 defaultPrevented 逃生门,不需要 Shift;拖到面板其他区域才被遮罩(那时才需 Shift)。`code.dragAndDropItemFacilitator` 配方实测失败(0.1.61,灰层卡死,0.1.62 已撤销),别再试 |
   | **粘贴文件成空 chip**(访达 Cmd+C 复制文件→粘贴,chip 无内容) | 访达复制只放"文件引用"没有像素;webview 剪贴板桥给 0 字节占位,浏览器会实体化所以正常 | 0.1.63:客户端吞掉 0 字节 Files 粘贴 → 扩展读 `NSFilenamesPboardType` 真路径 → 走「发送到 dsh」原生引用通道插入;截图复制(有字节)不受影响。排查看扩展日志 `paste file-ref ... paths=N`(0=剪贴板没路径)与 `[paste] files[名:大小]`。**1.142 起再看这条**:若日志出现 `clipboardFilePaths electron failed`/`n=0`,是扩展宿主已无 `electron.clipboard`,0.1.24 已改走 JXA/xclip/pwsh 兜底,按 `clipboardFilePaths <platform> n=` 判断兜底是否命中 |
   | **explorer 选中文件按快捷键全无反应**(右键可用) | 快捷键 when 永不成立:VS Code 1.142 资源管理器视图 ID 是 `workbench.explorer.fileView`,`focusedView == "explorer"` 失效;从 package.json 复制 when 还会多转义一层引号成 `focusedView == '"explorer"'` | 0.1.24:改用 `filesExplorerFocus`(不依赖视图 ID)并同时贡献 cmd+l + shift+cmd+l;install.sh 自动清理 keybindings.json 里这两类死行(先备份)。排查:命令面板跑 `dsh: 发送文件到 dsh`,日志出 `[sendFileToDsh] n=1` = 命令活着,只是键位没触发 |
   | **chip 插入后打字跑到那个文件里**(chip 不变、文件标签页自己弹出) | 不是光标问题:点 chip 被 0.1.58 拦截成"在 VS Code 打开",`showTextDocument` 不带 `preserveFocus` → 焦点进编辑器,后续按键全打进文件 | 0.1.24/0.1.68:普通点击打开文件**不抢焦点**(`openFile … (keepFocus)`);刚插完 chip 的 800ms 保护窗内点 chip 完全不打开(`[openfile] suppressed (insert-guard)`);要"打开并聚焦"用 **⌥/Alt+点击**。若日志里**没有**弹标签页却仍吞字,才轮到 dsh 0.2.1 `TextRefNode` 光标假设,看 `[caret]` 行 |
   | **plan 卡片「查看全文」只在 dsh 内部预览打开**(窄侧栏看不到) | 0.2.1 的 plan 是虚拟资源 `dsh-resource://plan[-review]/…`,不在盘上,`fileOpenTargetPath` 三种特征都认不到 | 0.1.68:认 `[data-plan-card]` 与 `*_reviewLink*` → fiber 取 `{callId, markdown, title}`(退资源 store / 预览 DOM)→ 扩展写 `~/.dsh/review/plans/plan-<sid>-<callId>.md` 并在编辑器聚焦打开;看 `[plan] kind=… tier=…` 与 `[planFile] wrote …` |
   | **plan 打开了但正文是乱的**(表格压成一行、`#`/代码块标记丢失) | 打开的是预览 `innerText`:待审 plan 正文在 fiber 里是 **`review.plan` 字符串**(ui-plan 用 `params.planReview.markdown = review.plan`),0.1.68 只认 `plan.markdown` 对象形 → 三级全空退 DOM。同屏还暴露 sid 为空(dsh ≥0.1.6 不再发布 `sessions.list.current`)与每次点击新建文件(Date.now 兜底) | 0.1.69/0.1.25:认字符串形 + `requestKey`;资源兜底按真实形态读 `source(addr).getSnapshot()`(只有 `status==="live"` 带 `value`);sid 三级(快照 `retainedBy.mainView` → 插入时挂的 `window.__dshrSessionId` → 路由);文件名改 `…-<标题 slug>-<sha1 前 8>` 内容寻址(重复点 = `[planFile] reused`);DOM 兜底在文件头声明"取自渲染文本"。排查:`[plan] … tier=dom` = 字段形没认到,`sid_src=` 说明 id 来源 |
   | **集成浏览器元素批注按 Shift+Enter 没进 dsh** | 评论框是 VS Code **注入到页面里**的(workbench bundle 里搜不到它的 DOM),扩展只能走 CDP;VS Code 不是 `--remote-debugging-port=9223` 启动就够不着 | 0.1.26:新模块 `lib/browser-comment.js` 按 target 池连每个浏览器 tab,页内捕 Shift+Enter。排查:`[browser-comment] cdp=absent` = 9223 没开（0.1.26 起 install.sh 已把 `remote-debugging-port` 写进 argv.json，Cmd+Q 一次即可，正常启动也生效）;`targets=0` = tab 没被认成 http(s) page;`comment label=… locate=label|size|smallest|near-label|no-label` = 元素靠哪一级反查;命令面板 `dsh: 元素批注状态 / 自检` 当场验 |
   | **升级后所有 `dshReview.*` 命令 not found、侧栏空白** | `activate()` 在半路抛异常 → 命令一个都没注册（0.1.26：`element-bridge.js` 里出现两个 `module.exports`，末尾那个覆盖前面的，`setBrowserCommentHandler` 变 undefined → watcher TypeError）。排查只看一处：`Code/logs/<时间戳>/window*/exthost/exthost.log` 搜 `Activating extension dsn.dsh-review-vscode failed` | 0.1.27：合并成单个 `module.exports`；`startElementContextWatcher`/`startCdpProbe` 各自 try/catch，侧功能崩了不吃命令。免重启复验法：node 里 stub `vscode`/`electron` 直接 require 已安装目录的 lib（见 0.1.27 节） |
3. **改哪边装哪边,版本必须递增**(服务端按 rev 缓存合并 bundle,同版本号重装=下发旧代码):
   只改 `dsh-review/client.js` → webview 右键 Reload;改 `index.js` → 侧栏 Restart dsh;改扩展 `dsh-review-vscode/**` → **Cmd+Q**(mac)/ **Ctrl+Q**(Linux)整重启,并 bump `dsh-review-vscode/package.json` 的 `version`——`install.sh` 的 `EXT_VER` 现在自动读它,不用再手改。装完重写 `~/.dsh/review/shadow/settings.json`(install.sh 会清空)。
4. **验证**:hover/点击类 bug **不要用 ego-browser 复现**(CDP 合成鼠标事件 relatedTarget 失真,0.1.56 曾误判),以真实 VS Code webview + 扩展日志为准。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.28 (2026-10-23, dsh 0.2.1-rc.2 / VS Code 1.141 Linux) — 工作区外文件 chip 点了打不开

### 现象(Ubuntu 实测,日志定罪)
- 点用户消息里的图片 chip(`PixPin_…png`,原件在 `/tmp/RustDesk-1000/cliprdr-server/`)→ toast「文件未找到」,日志只有 `[paste] fileOpen raw=<basename>` + `openFile missing: <basename>`
- 同 plan 卡片在 Linux 已验证全通(`[plan] tier=fiber`→`[planFile] wrote`→`openFile`),与 Mac 差异**不在 OS**,在文件位置

### 根因
1. 客户端 `fileOpenTargetPath` 对无 title 的 chip 落到 basename 规则,发出去的永远是**纯文件名**
2. 扩展 basename 兜底 = `workspace.findFiles`(**工作区内**),`/tmp` 与 `~/.dsh` 永远搜不到

### 修法(双层)
- client 0.1.71 `chipAbsPath(btn, want)`:chip 的 `<img src>`(file:// 或裸绝对路径,去 query/hash)→ fiber 上行 24 层扫 `memoizedProps` 字符串值,**要求 basename 精确等于标签**才认(防误抓 cwd 类路径);首次命中打 `[chip] props k=v …` 探针行。basename 规则与 Edited-折叠卡规则都先过它
- ext 0.1.28 `fsScanForBase`:workspace 搜空后**有界扫** `~/.dsh` + `/tmp`(精确名、深≤4、跳 node_modules/.git/Cache、访问上限 3 万,实测最坏 18ms);唯一命中直接开(`openFile fs-scan:`),多命中按标签尾段+最短择优(`fs-scan-multi n=`),仍无才 toast。单测:RustDesk 截图、`settings.json` 均命中
- **实测提醒**:RustDesk cliprdr 会清 `/tmp` 旧图(09-31 那张 09:36 已不在),历史 chip 点开 missing 属正常
- 版本说明:本修复与「元素批注」同日开发,原报 0.1.70/0.1.26 与批注功能撞号,rebase 后改号 0.1.71/0.1.28


## dsh-review 0.1.71 + dsh-review-vscode 0.1.46 (2026-10-23) — 定时基线把用户刚批的那条吞了（dsh 收到 0）

### 实测
`doc-open scheme=chatSessionInput base=input-0 len=0` → `chat 输入框基线：8 条旧引用（不送 dsh）` → `chatInput change len=147`，dsh 0 个方块。
0.1.44 加的两个 `setTimeout(seedBaseline, 1500 / 8000)` 会在用户已经批完之后才跑，把当时输入框里的内容（含刚批的那条）当基线登记 ⇒ 增量=0 ⇒ 什么都不送。

### 改法
- 基线**只立一次**（第一个快照），不再被定时器覆盖；`seedBaseline` 只在 composer 文档打开时调用（那时 len=0，是真·空基线）。
- 一次变更里新增引用数 > 3 判定为「会话恢复历史」，只更新基线不送 dsh（`MAX_DELTA=3`，日志会写数量），避免一开 Copilot 就灌一串 chip。
- 结果：正常一次 Enter = 1 条 delta = 1 个 chip；重启后第一条也不会被吞（composer 打开时基线是空的）。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.45 (2026-10-23) — 原生批注只需输入框变更：不点 chip、不开文件、不碰标签

### 上一版剩下的唯一毛病
`[comment] wrote … dsh ok=true`（**只有 1 条**，增量逻辑正确），但 `[element-context] close: save-to-tmp=false` ⇒ `doc.save(唯一临时文件)` **一直返回 false**（0.1.2x 起就没成功过，之前那句「机制上无弹框」是误判），于是 0.1.38 的规则「保存不成功就不关标签」生效 ⇒ 标签留着，用户手工关它就撞上 macOS 保存面板 = 老路。

### 结论：那个元素文档我们根本不需要
0.1.40（clickChips 关）那一版日志里就有 `[element-context] · chatInput change len=100`，输入框变更自己就是信号。所以 `clickChips` / `closeNativeDoc` 默认回到 **false**：不点 chip（不开文件）、也不去关 VS Code 自己打开的东西。`nativeToDsh` 仍 true，走 composer 增量。
代价（明说）：md 里的 `- URL:` 只有在曾经过元素文档时才有值，默认路径下为空（值来自元素文档正文 `URL:` 行，`lastElementUrl` 缓存）。要补上就从 CDP 已连接的浏览器页取当前 URL，一行改动，等用户要不要再说。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.43 (2026-10-23) — 一次原生批注送出 6 个 chip：改成「只送增量」

### 现象与根因
用户按一次 Enter 出现 6 个文件（`comment-20261023-110707-*.md`，同一时间戳），正文都是 `1321312`，标签分别是 `span#mv-gpu`/`span#state-detail`/`span#ms-gpu`/`span`…
根因不是重复触发，而是 **Copilot 输入框里留着历史引用**（之前几轮测试的 `@span#… 文字` 一直没清），我的扫描是「把文档里看得见的引用全送一遍」⇒ 每次变更都把历史重送。`seenNative` 只能挡完全相同的 `label+comment`，历史里那些彼此不同，全被当新的。

### 改法
- 基线化：`inputBaseline: Map<uri, Set(key)>`。第一次看见某篇 `chatSessionInput` 文档只记快照并**不送**（日志 `chat 输入框基线：N 条旧引用（不送 dsh）`）；之后每次只送 `prev` 里没有的 key ⇒ 一条原生批注 = 一个 chip。
- 顺带修 md 里 `- URL:` 空白：`lastElementUrl` 缓存元素文档 `URL:` 行，输入框变更路径也能带上页面地址。
- 元素文档打开但输入框没有新引用时记一行说明，方便区分「已抄走」和「没抄到」。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.42 (2026-10-23) — 原生批注直送 dsh 输入框（读 chat 输入框文档，不打补丁）

### 依据（用户跑 `dsh: 列出当前打开的文档` 实测出来的）
```
[element-context] · doc-open scheme=chatSessionInput base=input-0 len=0
[element-context] · chatInput change len=100
[element-context] doc chatSessionInput:input-0 len=115
```
⇒ **Copilot 的输入框是扩展可读的 text document**（`chatSessionInput:input-0`），原生批注会以行内引用 `@<元素> <文字>` 落进这篇文档。之前尝试的两条路（bundle 补丁的信标 / CDP 读 globalThis）都因为 agent host 那个 renderer 不在 9223 的 target 列表里而送不回来；这条路完全绕开它们。

### 实现（`element-context-watcher.js`）
- `scanNativeComments(hint, docText)`：取 `scheme==='chatSessionInput'` 的文档，正则 `/@([^\s@`\n]{3,120}?)\s+([^\n@]{2,400})/g` 提取 `标签 + 批注`（只有引用没有文字 = 0 命中，已单独验过），拼成 payload 走 `sendCommentToDsh` ⇒ `/tmp/dsh-comments/comment-…md` + dsh 一个文件 chip（不自动发送）。
- 触发点两处：元素文档打开时（`handleElementDoc` 里，顺带从文档正文 `URL:` 行取页面地址）+ `chatSessionInput` 文档变更时（覆盖后续连续批注）。去重 `seenNative`（`label␟comment`，200 条上限），所以 fetch/多次 change 不会重复插。
- 开关：`dshReview.elementContext.nativeToDsh`（默认 true）。同时把 `clickChips` 与 `closeNativeDoc` 默认恢复为 true：点 chip 会打开元素文档，这是「刚发生原生批注」的可靠信号兼 URL 来源，关标签走 0.1.38 修好的「唯一临时文件名」路径，**不会**再弹 macOS 保存面板。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.40 (2026-10-23) — 真凶：我们自己在点 chip，所以那个 untitled 文档才被打开

### 用户质疑成立
「为什么还是会打开这个文件, copilot原生就不会打开!!」——对。`lib/cdp-element-source.js` 里 `findElementChips()` 找 `.chat-attached-context-attachment`（aria-label 以 `Attached element` 开头），`clickChip()` 直接 `chip.el.click()`（`:79`）来触发老的「元素→源码」路径；**点这个 chip 就等于打开它的文档**，于是出现 `Attached Element Context from Integrated · Untitled-1`（带脏点）。原生 Copilot 不会去点，所以原生不会打开。日志对应：`[cdp] >>> NEW #3 (+3) span#state-detail [chat-attached-context-attachment show-file-icons]`。
（顺带解释 0.1.38 之前的保存面板：那个脏 untitled 文档一旦是我们点开/关掉的，就会碰到系统级保存面板。）

### 改法
`extension.js`：`cdp` 侧功能改为受 `dshReview.elementContext.clickChips` 控制，**默认 false**，关掉时只记一行说明；`element-context` / `native-comment` 仍在列表里（各自的开关也已默认关）。⇒ ⌥⌘C 现在完全等同原生 VS Code：Copilot 收到引用、不点 chip、不开文档、没有面板。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.38–0.1.39 (2026-10-23) — 保存面板真凶 + 用户决定：原生→dsh 这条链路整体停用

### 0.1.38 保存面板（那张 macOS「保存为 / 标签 / 位置 / Format: All Files」）
不是 VS Code 弹的，也不是「我们关标签」这个动作本身：`closeElementDoc` 把 untitled 存到**固定** `os.tmpdir()/dsh-element-context.txt`，第二次起文件已存在 ⇒ VS Code 用**原生**面板问「要不要覆盖」⇒ `doc.save()` 返回 false（日志 `close: save-to-tmp=false`）⇒ 文档仍脏 ⇒ `closeActiveEditor` 又把面板顶出来。我们的 dismissPrompt 只认 workbench DOM，所以日志写的是 `no-dialog` / 「tab 已关闭(无弹框)」——两句都不算谎，但用户看到的是原生面板。
改法：每次存唯一文件名 `dsh-element-context-<epoch>.txt`，存成功才关、关完 unlink；存不成功**就不关标签**（不再跟原生面板抢）。

### 0.1.39 链路按用户要求拆掉
- `python3 tools/patch_comment_hook.py --revert`：VS Code 两个 bundle 还原（`.dsh-bak`），「installation appears to be corrupt」弹窗从此不再出现。
- `dshReview.browserComment.nativeBridge` **默认 false**：不起 43167 监听、不 attach host、不轮询 globalThis。留着的理由只剩一个：将来 agent host 若能被 CDP 看见，打开开关 + 重打补丁就能立刻再试。
- `dshReview.elementContext.closeNativeDoc` **默认 false**：不再去关 VS Code 自己打开的 `Attached Element Context` 标签（那正是面板的来源），原生行为完全不动。
- `dshReview.elementContext.elementChain` 仍默认 false（0.1.35 起）：不插 element chip、不发 dsh。
⇒ 原生 ⌥⌘C 批注 = 纯原生（Copilot 拿到引用、VS Code 开自己的标签），dsh 侧的批注入口回到右下角 `dsh ✎` 那一套（图钉/展开改/删/文件 chip，0.1.33 起已实测可用）。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.36 (2026-10-23) — 原生批注改走 CDP 直取（CSP 拦掉了信标）

### 用户实测的两件事（都有日志/截图对应）
1. 「这个文件怎么还弹出来??? 你砍干净了吗?」—— 截图中弹出的是 `Attached Element Context from Integrated · Untitled-1`（带脏点），同一时刻 Copilot 输入框里已有 `+ Attached Element Context from Integrated ×` 和 `@span#mv-gpu 1321312`。日志只有我们的闸门行 `[element-context] · 老链路已关闭（0.1.35…）name=span#mv-gpu.st-metric__value`（两次），没有任何 `openFile` / `close(save-to-tmp)` ⇒ **这个 untitled 文档是 VS Code 1.142 自己打开的**，0.1.35 确实已经把我们的动作砍干净了。
2. 补丁的信标**一次都没到**：`[native-comment] listening` 在，但整个会话没有一条 `[native-comment] native comment`，也没有 `ping/no-comment` ⇒ workbench 的 CSP 把 `fetch` 和 `img` 都挡了（127.0.0.1 不在 connect-src/img-src）。

### 换递送方式（不动原生行为）
- 补丁在原地额外把 payload 塞进 `globalThis.__dshNativeComments`（`tools/patch_comment_hook.py` 的 BEACON；旧版补丁会被识别成 "upgraded"，先还原 `.dsh-bak` 再重打）。
- `lib/browser-comment.js` 现在除了浏览器页，还 attach **`vscode-file://…workbench.html`** 这个 CDP target（`isWorkbenchPage`，`attach(target, false)` = 不注入页内脚本，只轮询），每 900ms `Runtime.evaluate` 排空数组 ⇒ 走 `bridge.nativeCommentPayload` 进同一条 md + chip 管道。日志：`attached … [host: drain native comments]` / `native comment (cdp drain) label=… chars=…`。
- `element-bridge.nativeCommentPayload()`：两处投递（HTTP 与 CDP）共用一份映射，`nid` = `hash(url|name|elementId|text)`；watcher 里同 `nid` 的第二次到达**只重写文件、不再插 chip** ⇒ 双通道不会重复。
- 自检：`node -e` 验同 payload nid 相同 / 改文字后 nid 不同 / payload 形状正确；页内探针仍 22/22。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.35 (2026-10-23) — 砍掉旧「元素搬运」链路（用户实测的 7 步链条）

### 用户报告（原话压缩）
「回车 → 打开 Copilot → 跳回 dsh → VS Code 打开元素文件 → 提示是否保存(mac 级) → 我点不保存 → 文件关闭 → 这个 chip 插入」
日志逐段对上：`-> element ref: name=span#mv-gpu.st-metric__value` → `-> close(save-to-tmp) sequence, then send` → `-> sent to dsh: true` → `· doc-close scheme=untitled`。
根因：原生 Enter 已经自己把元素给 Copilot；我们 0.1.x 的 doc/jsonl 搬运工**又搬一次**，其中「打开 untitled 附件文档 + 关闭」就是那个 macOS 保存提示。同期还看到 `[cdp] dismiss-prompt: skip-not-ours: … installation appears to be corrupt`（补丁的已知副作用，弹窗要手点）。

### 改动
`element-context-watcher.js`：doc-open 入口 `handleElementDoc` 与 jsonl 扫描两处都加 `cfg('elementChain', false)` 闸门，关闭时只记一行 `老链路已关闭（0.1.35，元素走原生 + 补丁）`；新增设置 `dshReview.elementContext.elementChain`（默认 **false**，设回 true 可复活）。`sendElementToDsh` / `intercept` / `closeElementDoc` / dismissPrompt 机制保留不动，只是不再被触发。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.34 (2026-10-23) — 原生「Comment on Elements」接进 dsh（补丁路线 A 起步）

### 事实（先把「能不能改」查清楚）
- `Contents/Resources/app/out/` 是普通目录（只有 `node_modules.asar`）⇒ bundle 可直接编辑；workbench 20.7MB / sessions 21.8MB 都是明文 minified。
- 原生评论链路在 bundle 里可见：`_revealChatWidgetForAttachment` → `attachmentModel.addContext(...)` → `_insertElementCommentReference(v,t,f,ids,elementId,comment)` → `v.focusInput()`（这就是「跳到 Copilot」）；图钉/双向同步由 `inputEditor.onDidChangeModelContent` ↔ `browserViewService.setElementComments()` 驱动，VS Code 自己用 `browserViewCDPService` 往页面注入。
- 第三方扩展进不去：Marketplace 上 `codex-browser-bridge` 作者明说集成浏览器是内部 UI、无公开 API，只能自己开 Playwright 窗口。
- 探针实验：把 `F(10211,"Comment on Elements")` 的 original 改成 `⟨WBK⟩/⟨SES⟩`，用户实测菜单文字**没变** ⇒ 界面文字取自总表 `out/nls.messages.json`（该串只 1 份，两个 bundle 共用）⇒ 想靠文案区分渲染者不可行；好在**两个 bundle 的补丁锚点字节完全相同**，直接两处都打，扩展侧去重即可。

### 实现
- `tools/patch_comment_hook.py`：在锚点 `!1;t.elementSelectionState.active?this._commentSessionsWithComments.add(t):v.focusInput()}`（两文件各出现 1 次）后插一段 IIFE，把 `{url,name,comment,elementId}` 以 GET query 送到 `http://127.0.0.1:43167/dsh-comment`，`fetch(mode:no-cors)` 与 `new Image()` 双发（CSP 只允许 img 时也能通）；`.dsh-bak` 备份、锚点数≠1 就跳过并提示「VS Code 升级了，重新定位锚点」，`--check` / `--revert` 可查可撤。
- `lib/native-comment-server.js`：固定端口 43167 的 http 监听（补丁是静态文本，读不到设置，所以端口写死），4s 内同一 `(elementId|name|comment)` 去重（双发只算一条），再把 payload 灌进**已有**的批注管道 `bridge.deliverBrowserComment`（`ev:'comment'`, `locate:'native'`）⇒ 原生评论也会生成 `/tmp/dsh-comments/*.md` + dsh 一个文件 chip。
- `extension.js`：把 `native-comment` 加进那条逐个 try/catch 的启动列表（0.1.26 那次教训：一个启动失败不能吃光全部命令）。

### 验证
- 锚点唯一性：workbench / sessions 各 1 次（脚本先 `--check` 后 apply，apply 后 `patched=True anchor=0 backup=True`）。
- 服务自检（不依赖 VS Code）：连续三次 GET ⇒ 状态码 `204 204 204`、handler 只收到 **1** 次（去重生效）、未知路径 404、端口占用会记 `listen failed`。
- **待你实测**：原生 ⌥⌘C 批一条 → 日志 `[native-comment] native comment -> dsh ok=true` + dsh 出现文件 chip。没有这行 = CSP 把 fetch/img 都拦了，退路是改锚点写成 `postMessage`/`localStorage` 或换端口。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.33 (2026-10-23) — 提交时节点已被重渲染 → md 里尺寸 0x0、祖先链只剩一层

### 触发文件
用户问 `/tmp/dsh-comments/comment-20261023-101224-td-cx801.md` 是什么（= 他自己批的一条：`td.num` 内容 130.8，批注「666」）。文件里自相矛盾：标题 `td.num 98 × 50`，但 `- 尺寸: 0x0 @ (0, 0)`、`祖先链: tr` 只有一层。
根因和图钉被吃掉是同一个：从选中到按 Enter 之间 Strata 重渲染把那一格换掉，`elementBits(picked)` 是在**已脱离文档的旧节点**上取的（rect 0、parent 链断）。

### 修法（页内脚本 v6）
- `openFor()` 记下选中的 `pickedSel = selectorFor(el)`。
- `submit()` 取快照前：若 `!picked.isConnected` 或 rect 宽高为 0 且有 `pickedSel` ⇒ `document.querySelector(pickedSel)` 重新认新节点（认到就用它、并刷新 pill 文案），再 `elementBits(target)`；note 的 `el` 也换成新节点，图钉直接跟到新位置。
- 顺手修：`openFor()` 重置按钮文案时丢掉计数 → 现在保留 `dsh ✎ N`。
- 探针加 3 项（选中后把 `td` 换成新节点再 Enter：bounds 仍是 98x50、`innerText` 取到新值 131.4、祖先链 ≥2 层且 html 块是新内容、pill 跟着刷新）→ **22/22 通过**。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.32 (2026-10-23) — 图钉被 SPA 重渲染吃掉（"①怎么不见了"）

### 原因（不是用户点太快）
Strata 每秒刷新监控卡片的 span，`v4` 的 `positionPins()` 一见 `!el.isConnected` 就 `node.remove()` ⇒ 元素被重建 = 图钉消失（4 条批注都写进了 `/tmp/dsh-comments/comment-…-i4ii{1..4}.md`，命名带 nid 已生效，只是钉子活不过一次数据刷新）。

### 修法（页内脚本 v5）
- `placeAt()` 每次定位都把位置换算成**页面坐标**存进 `p.last`（`rect + scrollX/Y`）。
- 定位时元素已脱离文档 ⇒ 先用 `note.bits.selector`（`#mv-temp` 这类，`selectorFor()` 早就生成了）**重新认新节点**并 rebind（`p.el`/`note.el` 一起换）；认不到就退回 `p.last` 换算回视口坐标**原地停着**；只有连 `last` 都没有才删钉。
- `showCard()` 同样：节点脱离就用 `p.last` 定位卡片（否则点钉没反应）。
- 探针加 4 项（重渲染后钉还在并按新节点位置 493px、能 re-resolve、元素彻底没了停在原位、脱离态也能展开卡片）→ **19/19 通过**。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.31 (2026-10-23) — 批注：发完就收框 + 图钉可展开修改

### 用户两点
1. 「输入完为什么还在这里」→ 0.1.30 提交后我特意保留面板好连续批注，用户不接受：`submit()` 现在 **发完即 `closePanel()`**（元素留在图钉里，要再批就再点按钮）。
2. 「点击图钉, 为什么不会展开给我看, 或者修改」→ 图钉变成可点：展开就地卡片（标题 = `#N span#mv-temp…`，正文 textarea，按钮 **更新到同一文件 / 另存为新一条 / 删除 / 关闭**）。

### 协议（页内 v4）
每条批注带稳定 `nid = <页面 4 位 token><序号>`；文件名以 `-<nid>.md` 结尾。`ev:'comment'` 写新文件+插 chip；`ev:'update'` 用 `findCommentFile(nid)`（内存 Map，未命中再扫 commentDir）**重写同一个文件且不插 chip** ⇒ dsh 里那个 chip 自动读到新内容；`ev:'delete'` 删文件（页内同步移除图钉并把后面的编号重排）。元素载荷 `bits` 存在 note 上，所以「另存为新一条」不用重新选元素。`selftest()` 多出 `cardOpen`。
`element-bridge.deliverBrowserComment` 把 handler 返回 `false` 如实报成 `handler refused`（原来误报 `null-result`）。

### 验证
页内 jsdom 探针 **15/15**（发完即关框、nid 正确、卡片展开/文案/四个按钮、更新同 nid 重发、标题反映改后文字、另存生成新 nid 与第二钉、删除发 delete 且钉号重排）；对**已安装 0.1.31** 的管道测试 8/8（写文件命名含 nid → 更新只改同一文件不新增 → 日志 `updated … dsh 里的 chip 不变` → 未知 nid 被拒不产生文件 → 删除清掉文件）。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.30 (2026-10-23) — 批注「看不见」：加编号图钉 + 已送确认

### 现象与定性（日志先证明链路是通的）
`[browser-comment] injected` → `[browser-comment] comment label=span.st-metric__label 366 × 20 chars=14` → `[element-context] [comment] wrote /tmp/dsh-comments/comment-20261023-095049-span-6ip0.md -> dsh ok=true kind=file`，随后用户点 chip：`openFile fs-scan: …` + `openFile … (keepFocus) + open-guard 2500ms`（0.1.29 的 guard 也顺便验到了）。⇒ 批注确实进了 dsh；用户的抱怨「输入完就卡这里 / 内容也没有了 / 页面也没有标注」是**可见性**问题：提交后我们清空输入框，页面上没有任何留下物。

### 改动（只在页内脚本）
- 每条批注在元素左上角留一个**蓝色编号圆钉**（`.pin`，独立 `<style>`，hover/click 有 `title` 显示该条文字），`notes[]`/`pins[]` 记账；钉随 `scroll`(capture)/`resize`/`setInterval(1000)` 重算位置，元素被 SPA 换掉自动移除（`isConnected` 判定）。
- 提交后面板提示改成 `已送 dsh #N（内容已存文件，dsh 里是文件 chip）`，按钮文案带计数 `dsh ✎ N`。
- `selftest()` 增加 `notes` / `pins` 计数（命令面板 `dsh: 元素批注自检` 能当场看到）。
- 页内脚本版本 v2 → **v3**。探针加 5 项（钉存在/编号/title 文字/已送提示/按钮计数）→ **28/28 通过**。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.29 (2026-10-23) — 批注改成「自建就地浮层」+ 修「点文件 chip 反而冒出 element chip」
### 为什么推翻 0.1.26 的「拦 VS Code 评论框」（实测，不是猜）
用户开着评论框输入 `998877` 的 75 秒里，我把 9223 暴露的**全部 4 个 target**（Strata 页、workbench、2 个 iframe）每 1.5s 扫一遍（含 shadowRoot 与 contentDocument 递归）：没有任何 target 节点数变化（页面 505→505、workbench 1193 不变）、**没有任何 DOM 含 `998877`**；workbench 里对框所在坐标 `elementFromPoint` = `div.browser-placeholder-screenshot`，`Page.captureScreenshot` 里根本没有评论框；`/json/list` 与 `Target.getTargets` 都固定 7 条、框开着也不新增 target。
⇒ 集成浏览器内容与评论浮层都在 **agent host 侧的独立 native view**，CDP 只覆盖主窗口 ⇒ 拦不到按键也读不到文字；Copilot 输入框同层，一并读不到。磁盘上唯一的 browser 插件是老 `simple-browser`（7KB，只贡献 `simpleBrowser.show`），**没有可改的插件源码**。B 方案（发送后从 jsonl 镜像）被用户否决（必然先过 Copilot）→ 选 A：自建就地批注。

### 实现（用户在 AskUserQuestion 定的落点：/tmp 文件 + 一个文件 chip、不跳 Copilot）
1. `lib/browser-comment.js` **v2 重写页内脚本**：shadow-root host 挂 `<html>`（SPA 换 body 会自动重挂）→ 右下角 `dsh ✎` → pick 模式（`mouseover` 画 outline、`click` 定元素、点自己 UI 不误选）→ **就地**在元素右侧弹面板（放不下自动翻边/居中），pill 文案就是 VS Code 那种 `span#mv-vram.st-metric__value 366 × 32`，下接 textarea + `[+]` + 提示；**Enter 提交 / Shift+Enter 换行 / Esc 取消**；提交后保留元素清空文字以便连续批注。回传 `{text,label,url,title,size,tag,id,classes,attributes,ancestors,selector,innerText,outerHTML(≤4000),bounds}`；dsh 自己 GUI 的页面跳过注入。
2. `lib/element-context-watcher.js`：`commentMarkdown()`（标题=元素标签；URL/尺寸/CSS 定位/祖先链/元素文本；`## 批注` 正文；```html 块；属性行）+ `sendCommentToDsh()` 写 **`/tmp/dsh-comments/comment-<日期-时间>-<slug>-<4位随机>.md`** → `sendRefsToDsh([{kind:'file', path}])` → dsh 走**原生文件引用**（不再有 element chip、不开 untitled 文档、不弹保存）；写文件失败才退回 `kind:'element'`。
3. 设置：新增 `dshReview.browserComment.commentDir`（默认 `/tmp/dsh-comments`，`~` 展开；Linux 可指 `~/.dsh/review/comments`），`sendToDsh` 描述改为自建按钮，`includeOuterHTML` 保留。
4. **探针 23/23**（`/tmp/browser_comment_probe_v2.js`，jsdom 真 DOM，`getBoundingClientRect` 用 `__rect` 覆写补布局）：安装/幂等/换 body 重挂、pick→pill 文案与就地定位、Enter 提交 + payload 全字段、连续两条、Shift+Enter 不提交、Esc 取消、空文不提交、点自己 UI 不误选、`[+]` 同样提交、dsh GUI 跳过。**顺带抓到真 bug**：面板上 `stopPropagation` 用捕获阶段会先截走事件，textarea 自己的 Enter 永远不触发（现象=「`[+]` 能提交、Enter 不动」）→ 改冒泡阶段。

### 另一个 bug：点 dsh 文件 chip（文件确实打开了）反而插入 `element` chip
原因：我们从 dsh 打开文件后，VS Code 会**重新生成**聊天附件的 `Attached Element Context` 文档；`element-context-watcher` 的 doc-open 路径把它当成「用户在 Copilot 点了元素 chip」→ 反手往 dsh 插一个 element 引用。9223 关着时这条链不响，argv.json 打开 CDP 后就暴露了。
修：`element-bridge.js` 加 **open-guard**（`setOpenGuard/openGuarded`）；`dsh-browser.js` 的 `openFileFromDsh()` 每次打开后 `bridge.setOpenGuard(2500)` 并记 `+ open-guard 2500ms`；`handleElementDoc()` 在 guard 内忽略并记日志，另补 `alreadySent(name)` 180s 去重。排查：`[dsh] openFile … (keepFocus) + open-guard 2500ms` 后跟 `[element-context] · element doc ignored (open-guard, dsh 自己刚打开文件) name=…`。

### 待你实测（改了扩展，需 Cmd+Q 一次）
1. 浏览器页右下角出现 `dsh ✎` → 点它 → 高亮 → 点元素 → 就地弹框（pill=`span#… 366 × 32`）。2. 打字 → **Enter** → 日志 `[browser-comment] comment label=… chars=…` + `[element-context] [comment] wrote /tmp/dsh-comments/comment-….md -> dsh ok=true kind=file`，dsh 里只有**一个文件 chip**，Copilot 全程没动。3. 连两条 → 两行 chip，不自动发送。4. 点文件 chip → 文件在 VS Code 打开且**不再冒出 `element` chip**。5. 四处旧修复不回退（cmd+l/shift+cmd+l、chip 后打字、plan 查看全文、访达粘贴）。

## dsh-review 0.1.70 + dsh-review-vscode 0.1.26 (2026-10-23) — 集成浏览器「元素批注」→ dsh 输入框（本节 Shift+Enter 方案已被 0.1.29 替换，保留作链路记录）


### 需求（用户两轮回答定稿）
VS Code 内置浏览器（`workbench.action.browser.*`）的 **Comment on Elements**（⌥⌘C）里，**Enter 照旧进 Copilot**，**Shift+Enter 把「元素 + 评论」送进 dsh 输入框**（一个 element chip + 评论原文，不自动发送，可继续补总要求）。开关 `dshReview.browserComment.sendToDsh` **默认开**；关掉就完全不注入不监听，Shift+Enter 恢复 VS Code 原生行为。

### 链路（先查清再动手，出处都记下来）
- 命令：`workbench.action.browser.addElementCommentToChat`（1.142 bundle 内与 `BrowserViewCommandId.AddElementCommentToChat` 同时出现）。
- **评论框在页面里**，不在 workbench DOM：bundle 里搜不到任何评论 widget class，官方 issue #328518 也写 "persistent numbered pins **on the page**" ⇒ 扩展要读评论文本只能进那个页面。
- 元素结构 `IElementData`（`platform/browserView/common/browserView.ts`）：`{url, outerHTML, computedStyle, bounds, ancestors[], attributes{}, computedStyles{}, dimensions, innerText}`；提交后 Copilot 输入里变成 inline `@span#mv-pcie 1323` + `kind:'element'` 附件（用户截图实证），并写进 `chatSessions/*.jsonl`（插件 `getBaselineHint` 已在读）。
- **插件已有的两块地基直接复用**：`lib/cdp-element-source.js`（CDP 连 9223、`/json/list` 选 target、注入脚本 + `Runtime.consoleAPICalled` 前缀回传）与 `lib/element-context-watcher.js`（`sendRefsToDsh([{kind:'element',…}])` 把元素塞进 dsh）。

### 实现
1. **新增 `dsh-review-vscode/lib/browser-comment.js`**：2.5s 重扫 `/json/list`，把**每个 http(s) `page` target**（排除 workbench 自己）各连一条 WS 并注入页内脚本（幂等 `window.__dshBcc`）；捕 `keydown` capture 阶段的 **Shift+Enter**，`preventDefault + stopImmediatePropagation`（Enter 完全不碰）；用评论浮层里的 **`span#mv-pcie 304 × 32` 标签**同时做两件事——证明这是 VS Code 的框（而不是用户自己的输入框）+ 提供元素身份；反查元素四级：**unique → size(宽高对上) → smallest → near-label**，取不到只送 URL+评论。回传 `{text,label,locate,selector,tag,id,classes,attributes,ancestors,innerText,outerHTML(≤4000),bounds,url,title,size}`。命令面板：`dshReview.browserComment.status`、`dshReview.browserComment.selftest`（聚焦评论框后跑，直接告诉你检测到的 label/定位层级）。
2. **`lib/element-bridge.js`**：加 `setBrowserCommentHandler/deliverBrowserComment` 通道（CDP 模块不 import watcher，避免循环依赖；沿用 dismissPrompt 的写法）。
3. **`lib/element-context-watcher.js`**：`commentRef()` 把 payload 拼成 chip 正文（`[元素批注] label @ url (尺寸 定位=x)` + ```html 块 + 祖先链 + 元素文本），走现成 `sendRefsToDsh([ref], fallback, commentText)`；沿用 `elementContext.focusDshAfterCapture` 把焦点带回侧栏。
4. **`lib/dsh-browser.js`**：`sendRefsToDsh(refs, fallbackText, appendText)` 多一个 `appendText` 字段（老客户端忽略它，fallbackText 里已含全部信息，向后兼容）。
5. **`dsh-review/client.js` 0.1.70**：`dshInsertRefs` 支持 `appendText` —— chip 插入成功后 **330ms**（等 300ms 的 caret 强制落位完成）再 `insertComposerText(comment + "\n")`，评论文字就落在 chip 之后；`mode==="text"` 时不动（fallback 已带）。
6. **`extension.js`**：activate 里无条件 `startBrowserComment(...)`，开关由模块每轮 scan 自检 → **关掉开关不用重启**。
7. 设置：`dshReview.browserComment.sendToDsh`(default true)、`dshReview.browserComment.includeOuterHTML`(default true)。
8. **免启动参数**（用户明确拒绝每次 `code --remote-debugging-port=9223` 启动）：VS Code 1.142 的 argv.json schema 里有 `"remote-debugging-port": {type:"string"}`（workbench bundle 内与 `inspect`/`js-flags` 同段核实）→ install.sh 新增 `merge_cdp_port()` 写 `"remote-debugging-port": "9223"` 进 argv.json（首个 `{` 后插一行、**保留原注释**、写前备份 `.bak-<ts>`、已有则跳过）。效果：**Dock/图标正常启动就有 CDP**，只在装完那次 Cmd+Q。已在真实 `~/.vscode/argv.json` 副本上实测：插入位置正确、JSONC 仍可解析、二次运行幂等、备份 1 份。

### 探针（已做，13/13）
`/tmp/browser_comment_probe.js` 把页内脚本原文抽出来（含模板转义还原）在手写假 DOM 上跑：安装幂等、Shift+Enter 拦截、payload 文本/label/outerHTML/祖先链/URL+尺寸、**普通 Enter 放过**、**用户自己页面的输入框不被劫持**、同名多元素按宽高消歧、`selftest()` 输出。扩展侧 `sendCommentToDsh` 走的是已上线的 element ref 通道，未新写插入逻辑。

### 待你实测（只需一次 Cmd+Q，之后正常启动）
首版把 CDP 说成「每次都要 `code --remote-debugging-port=9223` 启动」，用户不接受（就要正常启动）→ 改成 argv.json 常驻。装完后：Cmd+Q 重启一次 → `curl -s http://127.0.0.1:9223/json/list` 应返回 target 列表 → 命令面板 `dsh: 元素批注状态` 显示 `connected≥1` → 集成浏览器里 ⌥⌘C 选元素写评论 → **Shift+Enter** → dsh 输入框出现 `element: span#…` chip + 评论一行；**Enter** 仍进 Copilot。日志前缀 `[browser-comment]`。若 curl 仍连不上（argv.json 不被该版本接受），备选是 jsonl 镜像（实测：未发送的评论**不落盘**，最近 30 分钟 workspaceStorage 里搜不到 `mv-pcie`，所以镜像只能在 Enter 发送后拿到，做不到按键即时）。

### 0.1.27 回归修复：升级后「所有 dsh 命令都 not found、侧栏空了」
`element-bridge.js` 我插了新 `module.exports`，但**文件末尾原有的** `module.exports = { setDismissPrompt, dismissPrompt }` 在后面覆盖了它 → `bridge.setBrowserCommentHandler` 是 undefined → `element-context-watcher.js:166` TypeError → `activate()` 直接死在注册命令之前 → `dshReview.sendTerminalSelectionToDsh` 等全部 not found、dsh 侧栏没了（exthost.log: `Activating extension dsn.dsh-review-vscode failed … at startElementContextWatcher … at activate`）。
修：只留一个 `module.exports`（四个导出）；**并且** `extension.js` 把 `startElementContextWatcher`/`startCdpProbe` 各自包 try/catch —— 侧功能再崩也不许吃掉全部命令。
复验（不用重启也能测）：拿 stub 的 `vscode`/`electron` 在 node 里加载**已安装目录**的三个模块 → `[cdp] observer installed`、`[browser-comment] attached … #monitor → injected`、`[element-context] v12 armed` 全部干净。

## dsh-review 0.1.69 + dsh-review-vscode 0.1.25 (2026-10-22, dsh 0.2.1-rc.2) — 待审 plan「查看全文」正文乱

### 现象(用户两张截图定案,不是猜)
- 已提交 plan 卡片(卡右侧「打开」,`[data-plan-card]`)→ 打开的 `.md` 是**源文 markdown**(标题 `##`、表格 `|`、代码块围栏都在)→ 正常。
- 待审弹窗右上角「查看全文 ›」(`*_reviewLink*`)→ 打开的文件里表格被压成一整行、`#`/围栏标记丢失 ⇒ 正文取自预览 **innerText**。
- 同屏第二个缺陷:文件名 `plan-session-179268235774.md` —— sid 退成字面量 `session`、key 退成 `Date.now()` ⇒ 待审 plan **每点一次新建一个文件**。

### 定位(源码级)
1. **正文字段形两种**:已提交 plan 是 `submittedPlan()` 造的 `{callId, markdown, title}`;待审 review 是 **`review.plan`——值本身就是 markdown 字符串**(dsh-client-ui-plan/lib/client.js:683-686 `params: { planReview: { markdown: review.plan, … } }`)。0.1.68 的 `planRecordOf()` 只认 `value.plan.markdown` 对象形 ⇒ 待审卡三级正文全空 ⇒ 落 DOM innerText。
2. **sid 恒空**:dsh ≥0.1.6 不再发布 `sessions.list.current`,当前会话由 `retainedBy.mainView > 0` 标识(本插件早有的 `currentSessionOf()` 就是这个逻辑),0.1.68 的 `currentSessionId()` 只读 `.current`。
3. **资源兜底形态错**:`ctx.resources.source(addr)` 返回 snapshot store 的 **source**(`{getSnapshot, subscribe}`,dsh-client-resources/lib/client.js:66-100),内容只在 `getSnapshot().status === "live"` 的 `value` 里(同文件 consume:145-154);0.1.68 直接找 `src.markdown` ⇒ 永远取不到。

### 修法
1. `planRecordOf()` 认字符串形(`typeof value.plan === "string" && length > 40` → 归一 `{markdown, callId, requestKey, title}`,title 取首个 `#` 行);fiber 上溯顺手抓 `requestKey`(待审身份是 `review:<requestKey>`,PlanReviewOpen:108)。
2. 改名 `planTextFromSource()`:读 `source(addr).getSnapshot()`,仅 `status === "live"` 时取 `value.markdown || value.plan || value`;地址两种(待审 `plan-review/<sid>/<requestKey>`、已提交 `plan/<sid>/<callId>`)。**不订阅**——订阅会 pin 记录并让点击变异步,fiber 命中已足够。
3. `currentSessionId()` 三级:`currentSessionOf(sessions.list.getSnapshot())` → `window.__dshrSessionId`(插入 chip 时从组件 `props.sessionId` 挂上,与 `window.__dshrFocusComposer` 同手法)→ `location.pathname` 路由段;日志加 `sid_src=store|insert|route|none`。
4. `openPlanFromDsh()` 文件名 `plan-<sid>-<callId|review+requestKey>-<标题 slug 前 24 字>-<sha1(markdown) 前 8 位>.md`:内容哈希 ⇒ 同一个 plan 重复点**复用**同一文件(日志 `[planFile] reused …`),正文变了才新建;sid 缺失退工作区目录名;新增 `node:crypto`。
5. DOM 兜底不再静默:文件头写 `> ⚠ 正文取自渲染文本，未能读取原始 markdown，排版可能与源文有出入。`

### 验证(用户侧一轮)
`Cmd+Q` 重启 VS Code(扩展 0.1.25)→ 点待审卡「查看全文」→ 期望 `[plan] kind=review tier=fiber rk=… sid=… sid_src=store` + `[planFile] wrote …-<slug>-<hash8>.md`,打开后表格仍是 `|` 源文;再点一次 → `[planFile] reused …`,目录文件数不变。

## dsh-review 0.1.68 + dsh-review-vscode 0.1.24 (2026-10-22, dsh 0.2.1-rc.2 / VS Code 1.142) — 快捷键 / chip 焦点 / plan 文件 / 访达粘贴

升级面:dsh 0.2.0-rc.2 → 0.2.1-rc.2。已核实 **rc.1 与 rc.2 的 `dsh-client-ui-conversation/lib/client.js` 字节相同**(774080),composer 侧的行为变更全部来自 rc.1;同期 VS Code 1.142(10-15 装的)也动了(视图 ID、扩展宿主 electron)。

### 修 1:资源管理器选中文件的快捷键全无反应(右键「发送到 dsh」正常)
- 定位:`contributes.keybindings` 里写的是 `focusedView == "explorer"`,而 1.142 的资源管理器视图 ID 是 `workbench.explorer.fileView`(已在 `workbench.desktop.main.js` 内核实,同时确认 `filesExplorerFocus`/`explorerViewletFocus`/`listFocus` 仍在导出)→ 条件永不成立。用户 keybindings.json 里手写的 shift+cmd+l 因从 package.json 复制 when 多转义了一层引号 → `focusedView == '"explorer"'`(字面量含引号)→ 同样永不成立;两条 `-dshReview.sendFileToDsh` 移除项也是死行。右键菜单 `explorer/context` 没有 when,所以照常可用 —— 这就是"只有右键能插入"的全部原因,**与 dsh 版本无关**。
- 修法:when 换成 `filesExplorerFocus && listFocus && !editorFocus && !terminalFocus && !inputFocus`,并**同时贡献 cmd+l(mac)/shift+cmd+l(mac)**(win/linux = ctrl+alt+l / ctrl+shift+l),用户不必改自己的文件;`commandPalette` 里该命令从 `when:"false"` 放开为 `filesExplorerFocus && listFocus`,命令面板可手动触发做回归。
- 已知限制(不算 bug):键盘触发时命令拿不到菜单注入的 uri,走 `copyFilePath` + 剪贴板兜底,只取**焦点那一个**条目;多选仍走右键。

### 修 2:插入文件 chip 后打不了字,敲的全进那个文件
- 现象核对(以用户回答为准):chip 不变、该文件的 VS Code 标签页自己弹出 → **焦点被抢**,不是光标落点问题。
- 定位:0.1.58 的 capture-click 拦截把点 chip 转成 `dshOpenFile`,扩展 `showTextDocument(doc, { preview: false })` 不带 `preserveFocus` → 焦点进编辑器 → 之后所有按键落进文件。0.2.1 把 chip 面改成整块可点(新样式 `._reference` + `cursor:pointer`,并新增 `TextRefNode` 纯文本引用面),"点 chip 后面放光标"更容易命中 chip,才把这个老毛病暴露出来。
- 修法(两层,不加新设置项):① 客户端插完 chip 设 **800ms 插入保护窗**,窗内点 chip 既不请求打开也不弹 dsh 预览,并把焦点交回输入框(日志 `[openfile] suppressed (insert-guard)`);② `dshOpenFile` 新增 `keepFocus` 字段,扩展默认 `preserveFocus:true`(日志 `openFile <路径> (keepFocus)`),**⌥/Alt+点击**恢复旧行为(打开并聚焦);二进制走 `vscode.open` 没有该选项,补一次 `focusDshSidebar()`。
- 保留假设:若焦点修好后打字仍被并入 chip 文件名,则是 0.2.1 新增的纯文本引用实体转换(`registerTextRefDecoration`/`TextRefNode`,注释 "Editing continues inside")叠加我们按 detect 坐标(1 个 chip 记 1 字符)强行落光标的老逻辑(`referenceSpan` 与 `spanAfterInsert` 坐标系互相矛盾)→ 已埋 `[caret]` 诊断行,按结果再改。

### 修 3:plan 卡片「查看全文」只在 dsh 右侧预览打开(窄侧栏看不到)
- 定位:0.2.1 的 plan 是**虚拟资源** `dsh-resource://plan/<sid>/<callId>`(已提交)与 `dsh-resource://plan-review/<sid>/<requestKey>`(待审),不落盘;dsh-client-ui-plan 的 DOM 特征是 `div[data-plan-artifacts] > button[data-plan-card="<callId>"]` 与 class `*_reviewLink*`(文案 `preview.full` = 查看全文 / View full plan),`fileOpenTargetPath` 的 title / `_fileLink_` / Edited 卡片三种特征一个都不认 → dsh 原生右侧预览接管。
- 修法:两种 plan 表面先于普通文件表面判定 → 三级取正文(逐级兜底):fiber 里的 `{callId, markdown, title}`(dsh 自己由 `submittedPlan()` 从 `exit_plan_mode` 的 tool/call 参数造)→ `ctx.resources.source(address)` → 已打开预览的 `_document` innerText。取到就 `preventDefault + stopImmediatePropagation` 吞掉点击,发 `dshOpenPlan`;扩展写 **`~/.dsh/review/plans/plan-<sid>-<callId>.md`**(插件自有目录,不进用户仓库、不产生 git 噪音)并用 `keepFocus:false` 在编辑器**聚焦**打开(点 plan 就是要读它)。三级都落空则不吞点击,dsh 原生预览照常。
- 验证:客户端日志 `[plan] kind=card|review tier=fiber|resource|dom chars=N`,扩展日志 `[planFile] wrote …`。

### 修 4:访达 Cmd+C 复制文件 → 粘贴进侧栏失效
- 定位:VS Code 1.142 扩展宿主里 `electron.clipboard` 已不存在(Electron ≥40 起 clipboard 属主进程且改异步 API),`readBuffer('NSFilenamesPboardType')` 抛 `Cannot read properties of undefined (reading 'readBuffer')`(今天日志实证)。
- 修法:`clipboardFilePaths()` 改三级:① 有 `electron.clipboard.readBuffer` 时照旧;② mac 用 JXA 读 pasteboard —— `ObjC.deepUnwrap(pb.propertyListForType("NSFilenamesPboardType"))`,退 `public.file-url`;③ Linux `wl-paste`/`xclip -t text/uri-list`,Windows `Get-Clipboard -Format FileDropList`。每级按路由打日志 `clipboardFilePaths electron|darwin|linux|win32 n=`。
- **JXA 实测坑**:`String(桥对象)` 得到 `[id __NSCFString]`;`ObjC.unwrap` 对 NSArray 只解一层(元素仍是桥对象)→ 必须 `ObjC.deepUnwrap` 并按 `typeof === "string"` 过滤,否则把占位符当路径插进 chip。
- 已实测:单文件 pasteboard 读回真路径 ✓(本机 JXA);**访达多文件**复制依赖 `NSFilenamesPboardType` 数组,与 0.1.63 同一解析路径,需真访达复制 2 个文件回归一次。

### install.sh:自动清理 keybindings.json 死行(用户选的方案)
- 新增 `prune_stale_dsh_keybindings()`(在 [2/4] 装扩展后调用):删「command 含 `dshReview.`(`-command` 移除形也认,先剥 `+/-` 前缀)且 when 是 `focusedView == "explorer"` 或 `focusedView == '"explorer"'`」的行;改前写 `keybindings.json.bak-<ts>`;存活条目**原文保留**(不改用户格式,前导 `//` 注释保留);JSONC 解析失败时只用保守正则,拿不准就不动。
- 已在真实文件实测:删 2 行、剩 67 行仍为合法 JSON;再跑一次输出 `no stale dsh rows`(幂等);合成用例里 `focusedView == "workbench.explorer.fileView"` 的自有条目与非 dsh 条目均保留。

## dsh-review-vscode 0.1.23 (2026-10-09, dsh 0.2.0-rc.2) — 仅扩展 / `~` 路径展开

### 修:卡片行标签 `~/xxx` 点开报「文件未找到」(用户截图:zotero8-dedup.md 明明存在)
- 定位:扩展日志回显的就是字面 `~/dsh/skills/...`;`path.isAbsolute("~/…")`=false → 按 `<cwd>/~/…` resolve 必然 miss → 兜底 `workspace.findFiles` 只搜工作区,家目录(`~/.dsh`、`~/dsh`)文件搜不到 → toast。
- 修法(用户确认「扩展端展开 ~ 为家目录」):`openFileFromDsh` 剥行号后、解析前,行首 `~`/`~/` 用 `os.homedir()` 展开(`node:os` 新增 require),展开后走原有绝对路径分支。mac/Linux 通用;Windows dsh 标签不带 `~`,无影响。客户端 0.1.66 未动(`~/` 标签本就通过匹配器)。
- 同批合入 ubuntu 远端:ext 0.1.22 Linux 剪贴板 PNG magic 修复 + install.sh `EXT_VER` 改自动读 package.json(远端曾写死 0.1.11 与包内 0.1.13 打架,mac 也受害)。
- ⚠ 部署备忘更新:今后只 bump `dsh-review-vscode/package.json` 的 version 即可,install.sh 自动跟随。


## dsh-review-vscode 0.1.22 (2026-10-09, dsh 0.2.0-rc.2) — 仅扩展 + install.sh / Ubuntu 首跑通

### 修: Linux 侧「从剪贴板贴图」把复制的文字当图片(坏附件)
- 现象(Ubuntu 24.04 / X11 / xclip 0.13): 剪贴板里只有文字时 `xclip -selection clipboard -t image/png -o` **不报错、rc=0**,把 UTF8 文本原样吐回来(实测 13 字节文本 → `buf.length > 8` 判成图片) → 侧栏收到一个坏 PNG 附件
- 修: `readLinuxClipboardImage` 两个分支(wl-paste / xclip)统一走 `isPngBuffer()`,校验 PNG magic `89 50 4E 47 0D 0A 1A 0A`
- 平台面: mac 走 `osascript`、win 走 `powershell.exe`,`readOsClipboardImage` 按 `process.platform` 分流,两者**不进这个函数** → Mac/Windows 零影响
- 验证: 文本 buffer ✗、`media/dsh.png` ✓、svg ✗(与预期一致)
- Linux 依赖(`install.sh` 不查,需自备): **pnpm**(`dsh plugin add` 走 pnpm,缺了直接 `dsh: pnpm was not found`)+ **xclip**(X11 贴图;Wayland 换 `wl-clipboard`,走 wl-paste 分支)

### 改: `install.sh` 的 `EXT_VER` 从 `dsh-review-vscode/package.json` 读
- 本次实测踩到: 仓库里 `install.sh` 写死 `EXT_VER="0.1.11"`,而包实际 `0.1.13` → copy 路径装出假版本目录,`extensions.json` 的 `location.path` / `relativeLocation` 跟着错。**Mac 同样受影响,不是 Linux 专属**
- 改成 `EXT_VER="$(node -p "require('$ROOT/dsh-review-vscode/package.json').version")"`;配合上一条 runbook,以后发版只需 bump `package.json` 的 `version`
- 前置: 脚本 `set -euo pipefail`,第 8 行就取版本 → 没 node 会在这里退出;实际不可能缺(`install_dsh_plugin` 本来就要 npm 或 pnpm)

## dsh-review 0.1.65–0.1.66 (2026-10-09, dsh 0.2.0-rc.2) — 仅客户端

### 补:折叠版单文件卡片(标题 "Edited CHANGELOG.md" + 副标题 "Preview in sidebar")点击仍无反应
- 日志证据:该卡片点击**没有任何 `fileOpen raw=` 行** → 根本没进拦截器:它不是 `button/a/[role=button]`,且文案 `Edited CHANGELOG.mdPreview in sidebar`(span 拼接无分隔)不匹配 0.1.64 判据
- 修:①matcher 加 `^Edited\s+<name.ext>` 前缀提取(允许后接任意副标题文本);②监听器加**祖先上溯**——closest 找不到可点元素或判据不中时,从 e.target 向上最多 6 层逐节点跑 `fileOpenTargetPath`(纯文本判据依旧严格,散文节点不会误触)
- 0.1.64 那种展开行(按钮形态)行为不变,日志同样 `[paste] fileOpen raw=...`
- **0.1.66**:同一卡片里行标签可能带**工作区相对路径**前缀(`dsh-review/client.js`),0.1.64 的 `indexOf("/")<0` 把它们全毙了(实测:纯 basename 行绿、带目录行红)。放开斜杠限制(仍拒 `\`、glob 字符、绝对路径开头);扩展端 `openFileFromDsh` 本来就按 cwd/workspace 根解相对路径,零改动。**用户实测:展开卡片全部行 ✓、单文件折叠卡片 ✓(0.1.65 的 `Edited X.ext` 前缀判据 + 祖先上溯生效)**


## dsh-review 0.1.64 (2026-10-09, dsh 0.2.0-rc.2) — 仅客户端

### 修:「Edited N files」汇总卡片的文件行点了打不开(实际是 dsh 原生预览打开又被宽度判定藏掉)
- 链条(用户复述确认):点行 → dsh 原生预览打开 → 侧栏窄,dsh 宽度判定把预览面板隐藏(看似没反应)→ 拉宽侧栏才显示 → 鼠标一移,侧栏自动隐藏机制回收整栏 → 预览跟着没了。修法方向(用户定):这类行**直接拦到 VS Code 打开真实文件**,原生预览不触发,不碰自动隐藏机制
- 改 1(matcher):这类行 DOM 无 title 路径、无 `_fileLink` 类 → 新判据=按钮整段文本是**单行带扩展名文件名**(先剥掉 `+7 −0` 统计后缀);散文按钮(全部接受/Skip/Next)不误触
- 改 2(根治双触发):dsh 自己的 click 监听也挂在 document **捕获**阶段、注册在插件之后——`stopPropagation` 不停**同节点**其他监听,所以此前拦截后 dsh 预览照开(VS Code 编辑器与隐藏预览同时发生)。改 `stopImmediatePropagation`,命中的点击完全归插件
- 审计日志:每次命中写 `[paste] fileOpen raw=<label>`,配合扩展 `openFile <abs>` 行对账;仅 VS Code 环境 + `openFilesInVscode` 开时生效,浏览器不受影响


## dsh-review 0.1.63 (2026-10-09, dsh 0.2.0-rc.2) — 仅扩展 0.1.21(杂物清理,无行为变化)

- **日志自动清理**:每个 VS Code 窗口会话都会留一个 `2-dsh review  dsh.log`(两个空格),永久堆积。扩展激活 5s 后 `pruneOldReviewLogs()`:扫 Code logs 树,删除 **14 天未改动**的本插件日志(活动文件在写、mtime 新,天然跳过;失败静默)
- 一次性清理已做:旧 keybindings `.bak*`(10-08 实验 5 个)已删;每窗口只留最新 dsh 日志(删 7 个)
- `test-sub-workspace/` 探针文件夹已不存在(mdfind+find 无结果),无需动作


## dsh-review 0.1.63 (2026-10-09, dsh 0.2.0-rc.2) — 仅扩展 0.1.20(粘贴二次修复,日志定案)

### 0.1.19 的 size==0 判据没打中:元凶是**插件自己的旧粘贴桥**
- 日志铁证(每行都有):`request paste via extension bridge` → `os clipboard image type=image/png bytes=42975` → `attach ok` —— 旧桥(0.1.5x 为截图设计)在每次粘贴时**主动读系统剪贴板图片**;访达复制文件时剪贴板本来就带**文件图标位图**(那些 42975/61011 字节就是 PNG/PDF 图标!)+ 文件名文本 → 于是出现"图标卡 + 文件名文本",即截图现象
- 而 webview iframe 里访达文件粘贴的 `clipboardData.files` 是**空的**(文件 promise 不物化)→ 0.1.19 客户端守卫根本没触发(日志无 `files[...]` 行)
- 修(仅扩展,零客户端改动):`dshPasteRequest` 分支**先查** `NSFilenamesPboardType` 文件路径:有 → `sendRefsToDsh` 原生引用 chips,跳过图标位图与文件名文本;没有(截图/拷贝图像)→ 原图片桥照旧。**日志新增 `paste: file-promise clipboard -> refs n=N`**
- 0.1.19 的客户端 size==0 守卫与 `dshPasteFileRef` 分支保留(若某环境把占位物化成 0 字节 File,双保险都收敛到 refs)


## dsh-review 0.1.63 (2026-10-09, dsh 0.2.0-rc.2) — 扩展 0.1.19

### 修:访达复制文件 → 粘贴进 VS Code 侧栏 dsh,chip 是空的(agent 拿不到图)
- 根因:macOS 访达 Cmd+C 只往剪贴板放**文件引用**(`NSFilenamesPboardType`,无像素,截图里的 PNG 图标就是占位);浏览器 Chromium 会把引用实体化成真 File,VS Code webview 的剪贴板桥只给 0 字节占位 → dsh 原生 rail 拿到空文件
- 修(exa 查实 dsh 原生通道后复用,不造新轮子):客户端 capture `paste`,Files 项**全部 0 字节** → preventDefault + 桥发 `dshPasteFileRef` → 扩展 `electron.clipboard.readBuffer('NSFilenamesPboardType')` 解析真路径 → 走现成 `sendRefsToDsh` → `dshInsertRefs` → `shell.insertReference` **原生文件引用气泡**插入输入框(dsh-drop-in 同一通道)
- 边界:截图/预览"拷贝图像"(真 bitmap,size>0)完全不拦,走 dsh 原生图片 rail;非 macOS 平台分支不触发;每次粘贴写扩展日志 `[paste] files[名:大小]` + `paste file-ref ... paths=N` 便于对账
- 拖入(0.1.61 的 facilitator)保持撤销状态,按用户决定不再修


## dsh-review 0.1.62 (2026-10-09, dsh 0.2.0-rc.2) — 扩展 0.1.18

### 撤销 0.1.61 的 facilitator 方案(实测失败,已回滚到 0.1.60 代码)
- 失败现象:拖文件时整个 webview 被灰色"拖到编辑器打开"反馈层盖住,松手后**永不消失**(webview 吃掉 drop,VS Code 收不到 drop/dragend → DropOverlay 卡死;20s 看门狗调 `...FacilitatorEnd` 也没解开)
- 机制终版(exa 读 VS Code 源码 `webview/browser/pre/index.html` + `webviewElement.ts` + `webviewWindowDragMonitor.ts`):
  1. webview 宿主页监听 dragenter:若 `e.defaultPrevented`(页面自己接管了拖放)→ 不发 'drag-start' → **不上锁**。dsh 的输入框 drop 区本来就 preventDefault → 老版本 VS Code 里拖文件进 dsh 直接可用(**这就是 0.1.6 时代能用的原因**)
  2. PR#209211(修 #182449,随 1.90/1.91 发布)新增:宿主页 dragover/drag **无条件** preventDefault 并向宿主派发合成 DragEvent;窗口级 monitor 收到非 Shift 的合成 dragover → `pointer-events:none` 重新上锁 → 该上锁路径**不看 defaultPrevented**,上面的逃生门被封死
  3. 解锁通道只剩:合成事件 `shiftKey=true`、宿主容器上的 mousedown/mousemove/drop、窗口 dragend —— 全在 VS Code 侧,**webview 侧无解**;`code.dragAndDropItemFacilitator` 只影响编辑器 DropOverlay,不影响这把锁 → 方案作废
- 结论:非 Shift 拖文件进 webview 在现 VS Code 是官方设计(灰层上就写着"Hold ⇧ to drop into editor"),插件层无法绕过,除非改 VS Code 设置 `editor.dropIntoEditor.enabled=false`(副作用:资源管理器拖文件到编辑器打开也失效)

## dsh-review 0.1.61 (2026-10-09, dsh 0.2.0-rc.2) — 扩展 0.1.17(已撤销,见 0.1.62)

### 尝试修:VS Code 侧栏拖入 PNG/文件,overlay 闪 0.5s 就没了 —— facilitator 方案,实测失败



## dsh-review 0.1.60 (2026-10-09, dsh 0.2.0-rc.2) — 仅扩展 0.1.16

### 修:图片(及一切二进制)点了弹"dsh: 打开失败" —— 用户要求"所有内容都可以打开"
- 原因:`openTextDocument` 对 PNG 等二进制抛 `Binary contents are not supported`(截图:/tmp/after_wu.png Read 行),当时 catch 直接落"打开失败"提示
- 修:文本打不开 → 回落 `vscode.commands.executeCommand('vscode.open', uri)`(VS Code 按类型路由:图片=内置图片查看器、pdf=注册的编辑器…任何可打开类型兜底);两者都失败才弹"打开失败"提示


## dsh-review 0.1.59 (2026-10-09, dsh 0.2.0-rc.2) — 扩展 0.1.15

### 修:工具行(Edit/Read 卡片)点了没反应;并加"文件未找到"右下角 1s 自动关闭提示(用户点名)
- 0.1.58 实测:行内提及(`title`=完整路径)✓;工具行 ✗。扩展日志实锤收到的 raw=**`index.js:363`** —— 工具行 `.fileLink` 根本没有 chip 那条 title 路,路径来源=**显示文本**(exa 命中的社区拦截表面表原文:工具行→textContent、chip/提及→title),且 dsh 把标签渲染成**截短 basename + `:行号`** 后缀(官方 decision note:basename 仅在"本轮唯一"时才可解析——工具行标签不保证唯一)
- 修(扩展):剥 `:行号`/`:行号-行号` 后缀(离线 5/5 用例;开文件不跳行,维持用户决定)→ 会话 cwd / 窗口工作区根解析 → 仍不中则 **workspace 全库 basename 搜索**(社区"先按已采集产物全路径匹配 basename"的等价物),候选里优先路径尾部与标签最匹配者、其次最短
- 客户端:`_fileLink` 类名 token 两种 CSS-module 命名(`_fileLink_<hash>` 前导名 与 `<hash>_fileLink` 前导 hash)都匹配(两种命名在 dsh 各包并存,0.1.56 portal hash 陷阱同款教训)
- 新提示:路径最终找不到(相对解析失败 / title 绝对路径已不存在 / 打开异常)→ **右下角 withProgress 通知 1s 自动关闭**(showInformationMessage 不会自动关,withProgress 是标准自动关闭姿势)+ 扩展日志照旧


## dsh-review 0.1.58 (2026-10-09, dsh 0.2.0-rc.2) — 扩展 0.1.14

### 新功能:点击对话里的文件 → 用 VS Code 编辑器打开(设置项默认开,可关回原生)
- 原生机制(exa 查官方 README/docs):`ui-deliverables` 产物 chips / 行内代码文件提及 / 工具行 `.fileLink` 按钮全部走 owner `openFile`,web 客户端里它把文件开成**右侧栏 document-preview tab**(`openResource(dsh-resource://file/...)` → `ui-sidebar-documentpreview`)——在 VS Code 工作区里这预览和编辑器重复
- 客户端:document **capture click** 拦截(社区先例 dsh-artifact-viewer/dsh-file-panel-left 同款拦截面)→ 目标= `button/a/[role=button]`,路径来源:chips/提及 `title`=完整路径(官方 README 保证);`.fileLink_` 按钮只有会话 cwd 相对显示文本 → 连同当前会话 cwd 一起 `postMessage dshOpenFile`
- 扩展 `dsh-browser.js`:绝对路径直开;相对路径先按会话 cwd、再按本窗口工作区文件夹解析(存在性检查,查不到只写日志不猜)→ `openTextDocument + showTextDocument(preview:false)`
- 门控:仅 VS Code 环境(iframe/bridge)且 `openFilesInVscode` 设置为 true(与其余开关同款 **settings-ready 门**——加载中不拦截,保已关用户);浏览器端完全不装,原生预览不变
- 用户确认过的三项决定:拦截全部入口 / 默认开 / 不支持跳行(只开文件)


## dsh-review 0.1.57 (2026-10-09, dsh 0.2.0-rc.2)

### 修:鼠标移到菜单项上 → 整个侧栏内容隐藏、只剩菜单悬浮(0.1.56 修好 keep-alive 后暴露的碰撞)
- 真凶=插件自己的 **rail auto-hide**(`installIframeRailAutoHide`):mousemove 用 `elementFromPoint` 判定"指针是否还在侧栏列子树内",不在 350ms 后隐藏整条 rail。而菜单弹层/HoverCard 是 portal 到 `document.body` 的,**不在侧栏列子树** → 指针移到菜单上 = 判定"离开侧栏" → 侧栏整体隐藏;菜单挂在 body 不受影响 → 恰好"侧栏消失、菜单残留",移出/关菜单即恢复(用户截图+两问答确认:头部整体消失、瞬时可逆)
- 修:`overRail` 豁免 `hit.closest('[role="menu"], [role="tooltip"]')` —— 行 "..." 菜单(role=menu)与 HoverCard 内容卡(role=tooltip,dsh rc.2 起卡片可悬停阅读)都算"仍在侧栏",auto-hide 不误火;真正移到侧栏外空白区仍照常隐藏
- 同版带上 `dshrMenuFit`:窄侧栏里固定定位的菜单弹层可能超出 webview 视口被裁字(截图:Unpin/Rename 文字截断)→ 打开后(等 fixedPos 落位的 250ms 延迟复查)把 left/top 夹回视口内
- 对 0.1.56 的更正:该条目"React 18 收不到 portal 事件"归因不准确——dsh 的 grace 设计依赖 React enter/leave 走 React tree(官方设计笔记),真实 webview 里 v1 补丁验证有效;ego-browser 复测失败是 **CDP 合成鼠标事件 relatedTarget 失真**,CDP 鼠标事件 ≠ 真实指针事件,勿再用于 hover 类验证


## dsh-review 0.1.56 (2026-10-09, dsh 0.2.0-rc.2)

### 修:侧栏会话行 "..." 菜单(Pin/Rename/Fork/Archive)鼠标一移进菜单就消失 —— dsh native bug,插件打补丁
- 根因(浏览器纯原生复现证实,插件无辜):`ui-primitives/Menu` `portal:true + closeOnPointerLeave:true`,指针离开触发 span 即起 **200ms** `usePointerGrace` 关闭倒计时;而菜单弹层 portal 挂在 `document.body`,**React 18 事件委托在根容器上,收不到指针进入 portal 的事件** → 倒计时永远无法被"进入菜单"取消 → 正常伸手进菜单必超时关闭
- 实测三组(ego-browser :3080,插件过滤不装载的浏览器端):瞬移入菜单中心=存活;斜穿列表移入=关;指针已在菜单内停留=仍关(菜单消失时刻指针还在行区域路上)
- 补丁:MutationObserver(body childList)发现 `[role=menu]` 且类名 token 以 `_portal_` 开头的弹层 → 原生 `pointerenter/pointermove` 监听 → 沿 React fiber 上溯找到 Menu 根 span 内的锚点按钮,派发合成 `pointerover`(bubbles+composed,150ms 节流)→ React 视为"指针进入 span" → `cancelClose` 取消关闭;指针真离开菜单后原生 pointerover 正常触发 leave,菜单按原生宽限关闭,行为还原生设计
- 范围:整个 dsh web client(浏览器 + VS Code 侧栏,native bug 全平台);与 workbench scope watchdog 同 effect 装载/拆除;无设置项(纯 bug 修复)
- 踩坑记录:portal 类名实际形态 `_portal_<hash>`(CSS module hash 在**尾部**),首版误写 `endsWith("_portal")` 永假;判定改为 `startsWith("_portal_")`
- 部署坑:服务端按 `rev` 缓存插件合并 bundle,**同版本号重复 install → rev 不变 → 继续下发旧代码**;改动代码必须递增版本号再装

## dsh-review 0.1.54 (2026-10-09, dsh 0.2.0-rc.2)

### 移除:@ 弹窗对话过滤器(0.1.51–0.1.53 实验)整体删除,设置③一并移除
- 三轮未修好的根因(搜索+源码定位):@ 菜单真主是 `dsh-client-ui-input-trigger/MenuView`,分组头类名 = **`groupTitle`**(0.1.51–53 的 DOM hack 一直选择器打空;MenuView 按 InputTriggerSource 分组渲染)
- 官方扩展正道 = 注册过滤版 `InputTriggerSource`(社区 dsh-at-mention 即此路线,只列同工作区会话);待用户定方向再实现
- 删除:client.js mention 过滤器全块/observer/tick 挂点/设置③复选框与存储链、index.js `mentionFilter` schema;client.js/index.js 与 0.1.50 提交版逐字节一致(净 diff 0)

## dsh-review 0.1.53 (2026-10-09, dsh 0.2.0-rc.2)

### 修:③ 仍不生效(0.1.52 也 0 行被处理)——遍历结构改为 menu 为中心 + 诊断日志
- 嫌疑锁定:0.1.51/0.1.52 的循环以 `sectionTitle` 为入口,`head.closest('[class$="_menu"]')` 兜底 parentElement —— 若分区头渲染在菜单容器**之外**(rc.2 未证实该包含关系),每轮 0 行处理、无报错、无隐藏,与截图症状一致
- 已证实事实(ego 探针 CHAIN):`BUTTON._item > DIV._viewport > DIV._menu` —— **行一定在 _menu 内**;新循环直接遍历 `[class$="_menu"]`,行处理与"分区头在哪"解耦:菜单内有标题 → 状态机只过滤会话组;标题在菜单外(菜单内无标题)→ 全行兜底(路径规则要求**精确等于已注册工作区路径**,文件行/命令行永不命中,不会误伤)
- 证据闭环:`postScopeDiag action=mention-run {rows,hidden,known,allowed}` 节流 5s 进 dsh.log —— rows=0 → 选择器结构问题;rows>0,hidden=0 → 判定问题;hidden>0 → 生效

## dsh-review 0.1.52 (2026-10-09, dsh 0.2.0-rc.2)

### 修:③ 开启后「有标题+路径」的对话行仍显示(用户截图:全是 /goal 标题行)
- 日志排查:window13 dsh.log scope 正确、shadow settings `mentionFilter:true` 已存 → 设置链路无恙,是判定缺口:0.1.51 只隐藏行文本含 `session-uuid` 的行,标题行全保留
- ego-browser 探针实证行结构:`_itemDescription` = `会话工作区路径 · 相对时间`;dsh 官方 README:**仅当会话工作区≠当前工作区才显示该路径** → 以 `/` 开头的描述就是可判定的外来提示
- 修复:三级判定 —— ①标签含 session-uuid → 按 id 集合;②描述以 `/` 开头 → 路径 ∉ 本窗口 workbench 工作区集合(knownPaths 中的已知路径才裁决,未知保留)→ 隐藏;③两者皆无 → 保留(不变)

## dsh-review 0.1.51 (2026-10-08, dsh 0.2.0-rc.2)

### 新功能:③「@ 弹窗只显示当前工作区的对话」(默认关)
- 机制检索(exa 官方 README/源码笔记 + rc.2 本地 bundle + ego-browser 实测 DOM):composer `@` 的「对话」组候选来自宿主 `sessionReferenceResolver/candidates`(全量会话、无 workspace 参数、按 cwd 亲和度排序、上限 50、无标题回退显示 session-uuid);行 DOM = `[class$="_item"]` 按钮,规范 `dsh-session:` mention 不落 DOM
- 设置:新开关 `mentionFilter` 默认关;开=VS Code 窗口内 @ 弹窗「对话」组只显示当前 workbench(含子工作区,与 ① 同一 matchingWorkspaces 判定)的会话;浏览器打开不受影响;两开关互相独立
- 判定:行文本含 `session-<uuid>` → 按工作区归属精确隐藏/保留;**有标题的行无法判定 → 保留**(宁可多显,绝不误藏);未知分组标题不动;文件组不受影响
- 触发:全局 MutationObserver(菜单异步渲染/虚拟重排)+ 看门狗 tick 兜底,150ms 防抖;开关关/设置未就绪 → 恢复所有本插件隐藏的行

## dsh-review 0.1.50 (2026-10-08, dsh 0.2.0-rc.2)

### 提速:首开落地不再固定睡 8 秒(实测等待 5~6s → ~3s)
- 依据(dsh 官方 contract/README 检索实证):sessions/workspaces 列表快照各有独立单调基线闸 `phase: 'pending' → 'ready'`;**empty-with-ready = 真的没有会话**;dsh 自身的"恢复上次会话"同样只等两个列表 ready 即动
- 改动:`openLatestOrNew` 水合等待改为**就绪即放行** —— sessions 列表 `phase==='ready'` 且无未解析 id 时直接继续(新建/复用空白会话),`HYDRATE_WAIT_MS(8s)` 退化为异常兜底上限;看门狗 tick 1500ms → 800ms

## dsh-review 0.1.49 (2026-10-08, dsh 0.2.0-rc.2)

### 修:子窗口首次打开不落地,必须手动 reload dsh 才进新会话
- 扩展日志实锤(window6 21:38):首开 dsh 恢复空白会话 97aaa110 → 看门狗判定 `current===目标` 置 `landDone=true` → dsh 随后丢弃该空白会话 → 主区回欢迎页,而 landDone 已锁死,之后每一拍都直接 return,永不重试
- 修复:`landRetryUsed` 一次性补落地 —— current 为空 + landDone 已锁 + 本窗口工作区内**没有任何非空白会话** 时解锁重落一次(经 openLatestOrNew → 复用/新建空白会话 → openSessionCompat 挂载),并打 `land-retry` 诊断
- 不影响普通窗口语义:父窗口必有真实会话 → 永不触发"手动关会话→留在 home"

## dsh-review 0.1.48 (2026-10-08, dsh 0.2.0-rc.2)

### 修:自动注册后主区卡「选择工作区」欢迎页(空白会话开不出来)
- 现场:子窗口 ② 开 → 工作区/侧栏组创建成功,但主区 10 分钟不落地新会话
- 根因(rc.2 bundle 实证):`ClientSessions` 门面(注入为 ctx.sessions)已无 `open()`(仅 retain/search/scope 等);connectNewSession 成功回调用 `sessions.open()` → TypeError 被 try/catch 吞 → 仍置 `landDone=true` → 永不重试;空白会话已在宿主创建(空白会话不显示在列表),主视图从未挂载
- 修复:落地改走既有 `openSessionCompat()`(首选 uiWorkspace.openSession,rc.2 公开 API);打开失败不再置 landDone,下一 tick 经 openLatestOrNew → openKnownSession 自动重试收敛

## dsh-review 0.1.47 (2026-10-08, dsh 0.2.0-rc.2)

### 修:关掉「自动为新文件夹创建工作区」后仍被自动注册(时序竞态)
- 实证:settings.json 写入 autoWorkspace:false 在 20:51:16,sub-sub-workspace 工作区 createdAt 20:51:43(晚 27s 仍被创建)
- 根因:webview 启动第一拍看门狗(1.5s)早于设置快照到达;`getReviewSettings()` 在 settings scope `status==='loading'`(value undefined)时返回内置默认 true → 抢跑注册
- 官方依据:dsh-client-runtime `SettingsScopeSnapshot.status: 'loading' | 'ready' | 'unavailable'`,value 在首个可读 section 接受前恒为 undefined;社区 dsh-web-ui 同样以 `status==='ready'` 为闸
- 修复:新增 `reviewSettingsReady()` 闸 —— 自动注册(②)、侧栏过滤(①)一律等设置就绪才动作;未就绪时每拍触发一次 settings reload,就绪后按真实值执行;`autoCreateBusy` 未就绪期间继续抑制 missing 提示

## dsh-review 0.1.46 (2026-10-08, dsh 0.2.0-rc.2)

### 设置页新增两个开关(默认都开,行为与 0.1.43/0.1.45 一致)
- 「侧栏只显示当前工作区的对话」(scopeFilter):关 → 会话列表过滤器即时卸载(1.5s 内全部行恢复可见),VS Code 侧栏显示全部对话;开 = 0.1.43 行为;浏览器始终全显示不受影响
- 「自动为新文件夹创建工作区」(autoWorkspace):关 → 不再自动注册 dsh 工作区,此类窗口回退为「返回 dsh 首页 + 尚未创建工作区」提示(0.1.45 的 clearMain 兜底);开 = 0.1.45 自动注册行为
- 设置卡描述同步更新;index.js schema/toJSON 增两键(host 端默认 true)

## dsh-review 0.1.45 (2026-10-08, dsh 0.2.0-rc.2 / 扩展 0.1.13)

### 子窗口(无 dsh 工作区)自动注册工作区 —— 不再串父会话
- 考古定位:dsh **0.1.7-rc.1**(commit b9b14dc05e)引入持久化 `dsh.sessions.current`,启动自动恢复上次会话 → 从此不进空欢迎页(发布说明未提及,git pickaxe 实证)
- 方案 B(用户选定):看门狗发现窗口文件夹无任何匹配 dsh 工作区 → `ctx.workspaces.create({path})`(官方、幂等,同 dsh-workspace-jump 用法)自动注册 → 下一拍既有流程在新工作区开空白新会话;侧栏只见本工作区空组
- 兜底 A:注册失败 → `goHome()` 实装 `uiWorkspace.clearMain()`(dsh 0.2.0 的正经 home API:释放 mainView + 清持久化 selection,下次刷新不再恢复);`dshScopeMissing` 提示在自动注册进行期间抑制,避免误报
- 成功注册 → VS Code 信息提示一条「已在 dsh 中为当前窗口文件夹创建工作区」(扩展 0.1.13 新消息 `dshWorkspaceCreated`,webview 白名单同步)
- 多根窗口:每个文件夹各注册一个;60s 重试节流;浏览器模式不受影响

## dsh-review 0.1.44 (2026-10-08, dsh 0.2.0-rc.2)

### 修:子文件夹窗口串显父工作区会话(0.1.43 放宽过头)
- 场景:VS Code 打开 `test-sub-workspace`(dsh 从未在此建工作区),侧栏却显示父工作区 dsh-review-plugin 的组+会话,还自动打开其中对话
- 根因:0.1.43 判定含「窗口文件夹的祖先也算」——父工作区(祖先)被放行
- 用户规则:「父可以显示子; 子不能显示父」→ scopePathAllowed 只留 **等于 或 在窗口文件夹之下**;父窗口照常看得到子目录工作区,子窗口看不到父(列表空+看门狗 missing-home 强制空开始页;dock 也不抢父待审,归父窗口)

## dsh-review 0.1.43 (2026-10-08, dsh 0.2.0-rc.2)

### VS Code 侧栏:会话列表只显示当前工作区的对话
- 新「工作区会话过滤器」(client.js,仅 VS Code iframe 安装,浏览器零介入):
  - 行归属查 dsh 原生 store(`ctx.workspaces`:workspaceId→path→sessionIds,含归档),DOM 行 `[data-row-key="session:/workspace:/overflow:"]` display:none;Ungrouped(未命名)组隐藏;整组无可见会话时组头/展开行一并隐藏
  - dsh 原生能力全保留:分组(按工作区/工作区树/单列表)、排序(手动/最近更新)、归档筛选(与归属过滤取交集——「仅显示已归档」只看得到当前工作区的归档)
  - 不再"点其他工作区会话被弹回":列表里根本看不到,反向看门狗成为纯保险
- 工作区判定从 STRICT 相等放宽为**包含关系**(scopePathAllowed):多根窗口取并集;会话工作区在窗口文件夹之下(子工作区)或为其祖先都算;边界安全(`/repo2` 不算 `/repo` 之下);dock 门槛/看门狗共用此判定
- 防抖实现(exa 搜索标准做法):MutationObserver 限定 body 根 + attributeFilter[data-row-key,class] + 120ms 合并 + 幂等 class 写入(自灭不循环);store subscribe 同步刷新
- 安装时机 = VS Code iframe 判定(bridgeActive/_dshRail 章/iframe)+ 作用域白名单已送达;Zotero 等 webview 无这些信号 → 不装

## dsh-review 0.1.42 (2026-10-08, dsh 0.2.0-rc.2)

### 修任务终端复选框排版
- 0.1.41 把勾选项塞进了 `dshr-stack`(其 CSS 规则 `.dshr-stack .dshr-field{flex-direction:column}` 会把复选框竖成孤行);挪出 stack,逐字照抄首个「启用代码审查」字段结构——勾选框与标签同行,说明文字在下方

## dsh-review 0.1.41 (2026-10-08, dsh 0.2.0-rc.2)

### 设置卡片:「在 VS Code 显示任务终端」开关(默认关)
- 新字段 `jobsTerminal`(宿主 schema 默认 false):关闭时 agent 后台 bash 任务**不再**在 VS Code 弹只读终端标签;任务本身照常运行
- 闸口打在宿主 jobs.js `trackFrame`:未跟踪的新任务不产生 `job` 帧、也不进 `GET /dsh-review/jobs` 列表——扩展重载不会复活终端;扩展端零改动
- 开关即时生效(宿主每帧查 settings),只影响之后的新任务;已打开的终端不受影响(关开关不追杀旧终端)
- client.js 卡片照 sidebarSide 同款链路:草稿/dirty/保存链,复选框落在「侧栏位置」下方

## dsh-review 0.1.40 (2026-10-08, dsh 0.2.0-rc.2)

### 剥离调试日志,只留关键项
- 删 client.js 里的排查期噪音:`[dbg]` 系列(pasteLog caretFix/focusComposer/insertRefs/chip/dragover/drop)、`[dsh-scope]` 逐条 console、每次挂载的「card seats injected」计数
- 保留真正的异常/回退信号:`native chip insert failed`、`remote.settings missing`、`seat skip`(注册真失败才报)、`VSCode bridge handshake ok`、paste/drop 失败回退等 `console.warn`
- 仅动 client.js 日志语句,功能逻辑零改动;`node --check` 通过

## dsh-review 0.1.39 / dsh-review-vscode 0.1.12 (2026-10-08, dsh 0.2.0-rc.2)

### 「review changes 一次都没显示」排查 + 两处修复(重点)
- 端到端探针实测:检测链路一直是通的(host 写 pending → 扩展挂载 startReview hunks=1),元凶是 **pending 条目被秒清**——风暴期(工具密集/ask 等待窗口)host 对同一文件反复 upsert,`updatedAt` 每 10 秒一跳,扩展 watcher 挂载/清除循环,dock 列表永远空
- Chrome/ego 浏览器实测无辜:90s+150s 监视,Chrome 开着对话时 pending 文件零干扰写入、条目停留、VS Code diff + 底栏 dock 都显示(第 3 轮探针验收)
- **修复 1(host pending.js):upsert 幂等**——before/after/operation 哈希未变不重写文件(不 bump updatedAt),从源头断掉 watcher 风暴
- **修复 2(扩展 session.js acceptAll):dock「全部接受」直达最新版**——链式 AI 编辑时(版本1 未接受→agent 又改版本2,新内容在磁盘上,缓冲区/会话可能停在版本1),接受前若缓冲区干净且与磁盘不一致,先采纳磁盘最新内容再 acceptAll(日志 `acceptAll adopt disk`);此前只会裁到版本1,得去编辑器右上角单独接受才到版本2

## dsh-review 0.1.38 (2026-10-08, dsh 0.2.0-rc.2)

### 设置卡片:侧栏位置(左/右)+ 修好「设置只读」(重点)
- 新增「侧栏位置」下拉(左侧/右侧),保存后 dsh 侧栏**立即**换边;0.1.31–0.1.38
- 卡片不显示根因三连(ego-browser + 语音输入/TTS 源码对照):
  1. rc.2 web profile 没有 `settings.plugin.item` 插槽,裸 `register` 抛 "slot is not declared"
  2. 正确姿势是 `slots.inject(name, () => register(...))`——等 owner(plugin-manager client)声明插槽再注册,官方语音输入/TTS 同款写法
  3. plugin-manager 已安装详情页的座位是 keyed `plugins.bundle.config`,key=包名(详情页 `data-plugin-config` 区)
- 设置灰掉不可改根因:rc.2 web profile 挂了 settings 服务但**没挂持久化 provider**,`remote.settings.describe()` 直接抛(`writable:false, namespaces:0`)——官方卡片(语音输入)也早就不用 settings 平面,全走自家后端(TTS:`/dsh-tts-api`;语音:`ctx.remote.speech.configure`)
- 照社区做法落自家通道:host 路由 `GET/POST /dsh-review/settings`(复用 jobs 桥同一套浏览器会话 cookie 鉴权)→ 存 `~/.dsh/review/shadow/settings.json`,启动时盖在 cordis 行配置上;**文件/代码段两个旧字段从此才真正存得进去**(此前 settings 平面一直是只读空转)
- 立即生效:保存成功回调直调换边函数(自家路由不发 `settings/document-updated` 事件);同步 localStorage + 扩展 globalState,iframe URL 盖章与设置同向不反向覆盖

### 删除 iframe 顶部小按钮
- 「侧栏改贴左/右」悬浮小按钮(28×14px,常被点到 dsh UI)删除,功能并入上方设置
- 按钮 id 加入热加载清理名单,旧残留自动移除

## dsh-review 0.1.30 / dsh-review-vscode 0.1.11 (2026-10-08, dsh 0.2.0-rc.2)

### 后台任务终端修复(0.1.27–0.1.28,重点)
- 现象:rc.2 升级后 agent 跑后台 bash,VSCode 只读终端不再弹出;扩展日志刷 `/events status 404`
- 根因:rc.2 `ctx.jobs` 服务契约改版——`onJobsChanged` 在 rc.2 运行时已移除(GitHub master 文档仍写九法契约,文档滞后于实现),桥的能力守卫短路,路由根本没注册(对照实验:`/api/*` 瞎写路径也返回 401,401≠路由存在)
- 0.1.27:桥改特性探测双路径(照 ds-harness-remote 先例)。rc.2 走 `jobs.events.subscribe({owners:'scope'})` + 非消费 `readAt(id, cursor, caller)`——消费游标还给 `job_output`,`reported` 不再可能被吞;旧 dsh 回退原 read-tee 路径;SSE/HTTP 协议不变,扩展零改动
- 0.1.28:rc.2 围栏 caller 是**纯 SessionId 字符串**(实现:`job.owner.id !== caller`),不是 Agent 对象——修 `readAt/kill` 全抛 "belongs to another session" 导致终端只剩标题行+完成行、零输出

### 终端显示美化(0.1.29–0.1.30)
- 真实 shell 提示符行(绿色):`(conda/venv) user@host dir % 命令`;环境前缀读 dsh 服务进程真实 env(`CONDA_DEFAULT_ENV`/`VIRTUAL_ENV`),真实环境没有就不显示,绝不硬编码 `(base)`
- 尾行 `[done: x]` → 纯白 `✔ completed · exit code: 0`(`✘ failed` / `■ killed`)
- 顺序修复:settled 事件先 drain 尾部输出、后广播终态帧——尾行永远在轮次最底

## dsh-review 0.1.26 / dsh-review-vscode 0.1.9 (2026-10-08, dsh 0.2.0-rc.2)

### 适配 dsh 0.2.0-rc.2
- 0.1.19:补 `remote.settings` shim(rc.2 移除 `settingsScope` 客户端服务,旧插件全部卡 "waiting for service: settingsScope")
- 插入引用不再光标错位:代码/终端插入统一走 detect-space 坐标 `insertText("",{start,end})` + `SessionInput.focus()`,光标落在 chip 后

### iframe 界面简化(0.1.23)
- 顶部悬浮按钮 3 → 1:只保留「侧栏左/右贴切换」;删除「顶栏收起/展开」「隐藏侧栏」按钮
- 顶栏永远展开(删掉插件的 `display:none` CSS;官方本就无隐藏顶栏的配置项)
- 热加载时自动清理旧版残留按钮

### 自动隐藏侧栏修复(0.1.26,重点)
- 现象:右贴靠下鼠标停在 rail 图标上也会 350ms 后自动收起;展开列表态靠运气才不收起
- 根因(经 0.1.24/0.1.25 远程日志定位,日志经扩展输出面板落盘):右贴靠(RTL/缩放)时侧栏列布局 rect 比视觉位置偏右约 73px,保持区矩形(678–734)整个在视口(661)外,`over` 永远 false
- 修复:弃 rect 并集,保持区改为 `elementFromPoint` 命中测试——命中元素属于侧栏轨道子树(rail 图标/悬停面板/齿轮)即保持显示;对左右贴、RTL、缩放免疫
- 保留最小状态日志:`ah-show edge` / `ah-fire-hide`

### VSCode 扩展 0.1.9
- webview 拖拽接收 + 幽灵提示;Explorer 拖入 webview 受 microsoft/vscode#182449 限制不可用,改右键菜单「发送到 dsh」+ 键盘命令 `dshReview.sendFileToDsh`(copyFilePath + 剪贴板兜底)
- keybinding `when` 建议:`listFocus && !editorFocus && !terminalFocus`(explorer 视图 id 是 `workbench.explorer.fileView`,manifest 里的 when 不可靠)

### 安装脚本
- install.sh/ps1:旧 tgz 清理改到 `dsh plugin add` 成功之后(修升级时 pnpm ENOENT);全程幂等,装/卸只走 install/uninstall
