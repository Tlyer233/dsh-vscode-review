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
   | 日志 `openFile missing: X` | X 解析不到文件 | `:行号` 已剥、basename 截短标签已全库搜;仍没有 = 文件确实不存在,右下角已自动弹提示 |
   | 日志 `openFile failed: Binary contents are not supported` | 文本通道拒二进制 | 已有 `vscode.open` 兜底,正常不该再现;再现=兜底没走到,查 `openFileFromDsh` 分支 |
   | 日志 `openFile failed: <其他>` 且右下角弹"打开失败" | `vscode.open` 也开不了 = VS Code 没装能开该类型的编辑器(如 .psd/.excalidraw) | 属**编辑器生态问题**不是插件问题:装对应 VS Code 扩展即可;若需插件特殊处理某扩展名,在 `openFileFromDsh` 按扩展名加分支 |
   | **拖文件进侧栏**:overlay 闪一下就没 / 拖放无效 | VS Code ≥1.90 的 Shift 设计:拖文件未按 Shift 时 webview 被 `pointer-events:none`(#182449 / PR#209211),非插件回归 | **实测(0.1.20 后)**:拖到**输入框/附件条区域**可直接拖入——dsh 自己的 dropzone 在 dragenter 就 preventDefault,走了官方 defaultPrevented 逃生门,不需要 Shift;拖到面板其他区域才被遮罩(那时才需 Shift)。`code.dragAndDropItemFacilitator` 配方实测失败(0.1.61,灰层卡死,0.1.62 已撤销),别再试 |
   | **粘贴文件成空 chip**(访达 Cmd+C 复制文件→粘贴,chip 无内容) | 访达复制只放"文件引用"没有像素;webview 剪贴板桥给 0 字节占位,浏览器会实体化所以正常 | 0.1.63:客户端吞掉 0 字节 Files 粘贴 → 扩展读 `NSFilenamesPboardType` 真路径 → 走「发送到 dsh」原生引用通道插入;截图复制(有字节)不受影响。排查看扩展日志 `paste file-ref ... paths=N`(0=剪贴板没路径)与 `[paste] files[名:大小]` |
3. **改哪边装哪边,版本必须递增**(服务端按 rev 缓存合并 bundle,同版本号重装=下发旧代码):
   只改 `dsh-review/client.js` → webview 右键 Reload;改 `index.js` → 侧栏 Restart dsh;改扩展 `dsh-review-vscode/**` → **Cmd+Q** 整重启,并同步 `install.sh` 里写死的 `EXT_VER=`。装完重写 `~/.dsh/review/shadow/settings.json`(install.sh 会清空)。
4. **验证**:hover/点击类 bug **不要用 ego-browser 复现**(CDP 合成鼠标事件 relatedTarget 失真,0.1.56 曾误判),以真实 VS Code webview + 扩展日志为准。

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
