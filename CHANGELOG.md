## 2.0.50:busyEnter 改读 ctx.configForms + 3080 双进程 systemd 托管(2026-11-02)

- **busyEnter 误读真身**(exa 挖到上游 `deepseek-harness` 源码实锤):web profile 服务器端**没有 settings 持久 provider**,`remote.settings.describe()` 永远只见默认值 queue;GUI 的 ComposerSubmissionPolicy 实际 adopt 的是**页内 `ctx.configForms.get("ui-conversation")`**。annoPromptMode 改同源读 configForms(describe 降为二级兜底)。`session.prompt(content,'queue'|'steer')` 语义与类型声明(`readonly running: boolean`)均获上游证实。
- **3080 运维闭环**:`dsh-web.service` + `dsh-auth-proxy.service` systemd user units(`enable --now` + `Linger=yes`,开机自启免登录;unit 与 run 脚本副本存 `tools/systemd/`)。此前 ssh 侧栏 3082 口靠已删 0.1.107 老扩展 spawn 的孤儿进程,重启机器即失联;现已托管,`systemctl --user restart dsh-web` = 换 rev 一步到位。

## 2.0.51:busyEnter 读**实时 DOM 按钮文案**(真相层),文档读降级为兜底(2026-11-02)

用户双截图实锤矛盾:ssh 页面设置=Steer、原生 Enter 会插话,插件却读 queue → 排队。定罪:web profile 无 settings 持久 provider,**Steer 只活在页面内存 store**;configForms/describe 读的是持久文档=永远默认 queue。上游字典(`input.send.steer`=插话发送/Steer message,`input.send.queue`=排队发送/Queue message,仅在 running+纯文本草稿时渲染到发送钮 aria)给出零依赖真相源。优先级改为 **实时钮 aria > configForms > describe > queue**,日志带 `client 2.0.51` 指纹。

# Changelog

## 2.0.3:修 2.0.2 回归——dshState.log 是函数不是 channel(本机也卡的元凶)(2026-11-02)

2.0.2 门闩埋点写 `dshState.log.appendLine(...)`,而 `dshState.log` 是 setLog 注入的**函数** → annoSendSync 第一行即 TypeError → promise reject(日志只余 'consume failed: dshState.log.appendLine is not a function')→ 所有窗口(含本机)prepared 永不回 → 75s 卡。同款误用共 3 处,全改 `dshState.log(...)`。教训:**用 dshState 记日志前先 grep 该属性既有用法**。

## 2.0.2:SSH 窗口远程投递(workspace.fs 走现成 ssh 通道写 3080)+ 发送门闩日志(2026-11-02)

- 用户令:"local 照旧(重启即清的临时目录);ssh 就写过去(那边是 Linux)"。实现:`annoAuthority()` 取工作区 vscode-remote authority → annoPut 经 `workspace.fs` 写远程 `/tmp/dsh-trump/`(与 Mac tmp 同语义,重启自清);块里的路径即 Linux 真路径,agent 直接可读。写失败→Mac 本地副本+日志。三个写手同步化 await。2.0.1 另有 `[env] window=LOCAL|REMOTE` 打印。3080 老 dsh-annotate 与老扩展副本 0.1.107 已删。

## 2.1.0 扩展 + 2.0.49 客户端:粘贴文件远程上传 + slash 命令放行 + 发送模式跟随用户设置(2026-11-02)

- **粘贴远程上传(U 方案)**:ssh 窗口里从访达复制文件粘贴进 dsh → 经现成 ssh 通道上传到 3080 `/tmp/dsh-paste/<stamp>-<name>/`,引用改写为 Linux 路径;目录递归(≤200 文件/64MB);超限/失败保留 Mac 原路径+日志,粘贴绝不吞。本机窗口行为一字未动。新公共模块 `lib/remote-put.js`;dsh-browser 两个消费点异步分流。`sendFileToDsh` 目录判定改 `workspace.fs.stat`(远端感知)。
- **slash 命令放行(实拍:/plan 不被识别)**:markAnnoSend 门口——草稿以 `/` 开头 → 原生发送,零拦截零追加;pill 留架随下一条普通消息走。
- **发送模式跟随设置("我设置是 steer 插入,就要按设置来")**:`__dshrAnnoPrompt` 弃硬编码 queue;`annoPromptMode()` 镜像 GUI resolveSubmitMode:空闲=queue(=直发),生成中=`ui-conversation.busyEnter` 偏好;读不到设置面退 queue(零回归)。日志 `[paste] prompt mode=…(busyEnter=… running=…)`。


# v2.0.0(2026-11-02)— 堆桥全链路定版:扩展 2.0.0 / dsh 客户端 2.0.0

标注→dsh 主管线自 Heap-Bridge 起全面换脑,本次定版内容:

- **取数**:发送时对 workbench 内存堆快照,直读 Copilot 附件母本 map `{chip → 官方R8s全文(含全CSS) + imageData 截图}`,禁止 click/hover;hover 回退链整体退役(堆败=跳过不回头);单条桥失败/超时只丢该条,每次 CDP 调用带截止
- **携带**:①浏览器元素标注 ②浏览器/区域截图(+整页)两路自动附带;③文件④代码段⑤终端 = 只清不带(用户裁决,annoCarryMisc 已删)
- **清场铁律**:发送后 Copilot 内所有附件(含文件/终端 chip)一律 ✕ 清空——清≠带
- **多窗口**:每窗口独立扩展进程;CDP 按 webview 父链选窗,堆桥按标题消歧——实测双窗口零串扰
- **段落批注整编**:dsh-annotate 内化进 dsh-review 客户端,统一 Enter 总闸;pill 与草稿卡自校准(绝对几何,侧栏/浏览器边距差异通吃);发送后 pill 必清(空串 sid 修复)
- **进度条**:两段二次曲线(6s 轰鸣 66% → 54s 慢爬 96% → prepared 推顶),动画器带版本自证日志
- **运维定案**:client 改动必须重启 Dsh 换 rev 否则缓存旧包(已坑三次);改名/删行必须 grep 归零核验

## pill 行每敲一键右飘一格:padding-delta 累积病,改绝对几何(2026-11-02, 客户端 0.2.48)
## pill 行每敲一键右飘一格:padding-delta 累积病,改绝对几何(2026-11-02, 客户端 0.2.48)

遥测铁证(padL 791→799→807…每 commit +8;padR 涨到 18,641,400px,rowR 18,641,352px):0.2.46 的 `padding += 实测差值` 有两个必然后果——①padding 不移动盒子左边,delta 恒为 8,每次重渲染(每敲一键)再加一遍,无限累积=右飘一格;②flex 语境 padding 撑大 min-width,row 变宽→dr 变大→padding 再大,正反馈爆炸。v2 改**绝对几何**:行盒 width/marginLeft 直接钉成卡片盒的实测值(幂等,与 padding 无关),清掉两侧 padding 残留。教训:**每帧运行的布局补偿只能用绝对量,差值制在 DOM 里必累积**。

## 段落批注 pill 侧栏不对齐:渲染时实测自校准(2026-11-02, 客户端 0.2.46)
## 段落批注 pill 侧栏不对齐:渲染时实测自校准(2026-11-02, 客户端 0.2.46)

浏览器版对齐、VS Code 侧栏 pill 与草稿卡错位(用户提示与其调过的边距有关:侧栏 CSS 把 root padding/card-max-width/dock-inset 都改了,且核心类名哈希会漂移,选择器补偿脆)。放弃猜值,改** paint 时自校准**:chips 行 ref 回调里 rAF 测 `[data-composer-card]` 与本行 rect,把左右差值加进行内 padding(|Δ|<0.5px 不动,防抖标志位)。零上下文,边距怎么调都跟着对齐。

## 进度条终稿:6 秒轰鸣到 66%,之后 54 秒慢爬到 96(2026-11-02, 客户端 0.2.45)
## 进度条终稿:6 秒轰鸣到 66%,之后 54 秒慢爬到 96(2026-11-02, 客户端 0.2.45)

用户批注令:"直接30%太突兀, 应快速到66% 然后慢慢长"。两段二次(连续单调无跳变):phase1 `66×(1-(1-t/6s)²)`(1s 20 / 2s 37 / 4s 59 / 6s 66),phase2 `66+30×(1-(1-(t-6s)/54s)²)`(15s 75 / 30s 87 / 45s 94 / 60s 96),prepared 推最后 4%。

**同时定案"怎么重启都吃不到新代码":** combo 合并包的 URL 带 `rev=<服务器启动令牌>`,Dsh 不重启 rev 不变 → 浏览器对同一 rev 直接**缓存命中**(实测 transferSize=0),页面重载一万次也是旧包。规矩:**改 client 后必须 重启 Dsh(换 rev)→ 再重载页面**;验证只看扩展日志自证行(现为 `client 0.2.45, 66-then-crawl`)。此前几轮"没对齐/没变化"全部是拿 0.2.4x 旧包在测。

## 段落批注 pill 发完不消失:空串 sid 被 falsy 判据跳过 clear(2026-11-02, 客户端 0.2.44)
## 段落批注 pill 发完不消失:空串 sid 被 falsy 判据跳过 clear(2026-11-02, 客户端 0.2.44)

截图实证:消息已带 Quote/Comment 发出(全链日志绿:prepared 142chars→send 404),但 composer 上方 pill 仍挂着——"对齐"指的是**发送后 pill 没清**。根因:`markAnnoSend` 存 sid 用 `(para && para.sid) || null` 把**空串 sid 挤成 null**,prepared/timeout 两处 clear 又写 `if (p.sid && ...)`——dsha 的 sid 解析在批注创建/发送时都可能落到 `""`(onScreen() 找不到在屏行),于是 clear 被当"没有"跳过,pending 原封不动。三刀:存 sid 改 `para ? String(para.sid) : null`;两处判据改 `!== null`(空串也清)。pill 计数"11"= 用户批注文本笔误,非缺陷。

## 进度条粗暴档:开局瞬跳 30%(2026-11-02, 客户端 0.2.43)
## 进度条粗暴档:开局瞬跳 30%(2026-11-02, 客户端 0.2.43)

用户段落批注 Quote「开局直接跳 30%」Comment「你改下试试」(顺带证明:段落批注↔发送流对齐在工作,Copilot 空窗走 quiet 路也带上了段落块)。实现 `p = 30 + 64×(1-(1-t/45s)²)`:卡片出现瞬间 30%,2s 35.6 / 5s 43.4 / 10s 55.3 / 15s 65.6 / 30s 86.9 / 45s 94 封顶,prepared 推最后 ~6%。自证行更新为 `client 0.2.43, start30 quad T=45s`——日志没这行=页面没重开,别再拿旧 bundle 观感对账。

## 进度条体感修正:T=30s 封顶 94,起步轰鸣后段龟速(2026-11-02, 客户端 0.2.42)
## 进度条体感修正:T=30s 封顶 94,起步轰鸣后段龟速(2026-11-02, 客户端 0.2.42)

用户仍报"先慢后快"——体感即验收:真实抓取仅 20-40s,T=60/90 时用户永远只见曲线前段 + 结尾跳 100 的冲刺,观感反成加速。改 **T=30s、cap 94%**:1s 6.2% → 5s 27.9% → 10s 48.4% → 20s 81.3% → 30s 94%(此后贴顶龟速),prepared 只轻推最后 ~6% 收尾——首速 ~6%/s 且持续衰减,必感"快→慢"。启动自证行同步更新(client 0.2.42, quad T=30s cap94)。

## 进度动画器加版本自证日志(2026-11-02, 客户端 0.2.41)
## 进度动画器加版本自证日志(2026-11-02, 客户端 0.2.41)

用户"感觉没变化"。三层排查:盘上 T=60000 ✓、服务器 combo 实测含 `const T = 60000`(无 90000)✓、接线 annoAnimTo↔annoProgEls ✓ → 剩两解释:webview 在 Dsh 重启后只是 WS 重连**不重新拉 bundle**(须整体关闭重开/硬刷新);且堆抓通常 <30s 就"跳100",两条曲线该区间只差几个百分点肉眼难辨。修法:动画器启动即 post 一行 `[paste] prog animator start (client 0.2.41, quad T=60s)` 进扩展日志——版本从此可证;要更陡:T=45s 或开局 1s 内跳 10%。

## 进度条头段再提速:发射窗 90s→60s(2026-11-02, 客户端 0.2.40)
## 进度条头段再提速:发射窗 90s→60s(2026-11-02, 客户端 0.2.40)

用户"刚开始再快点, 要不开口向下的二次曲线?"——0.2.39 已是开口向下(减速)二次曲线,只是 T=90s 头段斜率不够。同族不变,发射窗缩到 60s:2s 6.3% → 5s 15.3% → 10s 28% → 30s 68% → 60s 封顶 96% 缓爬等 prepared(跳 100)。

## 进度条曲线方向修正:先快后慢(2026-11-02, 客户端 0.2.39)
## 进度条曲线方向修正:先快后慢(2026-11-02, 客户端 0.2.39)

0.2.38 按"开口向上"字面做了 t²(先慢后快),用户判"反了":要**刚开始快、后面慢**。改减速半支 `p=96×(1-(1-t/90s)²)`:2s 6.3% → 5s 10.3% → 10s 17% → 15s 29% → 30s 53% → 45s 72% → 60s 85% → 90s 96% → prepared 跳 100。单调不回退。

## 进度条改开口向上二次曲线(2026-11-02, 客户端 0.2.38)
## 进度条改开口向上二次曲线(2026-11-02, 客户端 0.2.38)

用户令"把进度条速度改为开口向上的二次曲线":分段线性 annoAnimTo(先快后匀速)整换为**单条时间二次** `p(t)=(t/T)²×96`(T=90s 预期封顶):5s 0.3% → 30s 10.7% → 60s 42.7% → 90s 96%,开始缓、加速冲顶、单调不回退;prepared 到达即跳 100%。stage 1/2/3 不再改目标(曲线全程)。

## 用户裁决:砍掉③④⑤,只留①浏览器标注+②图片,设置也删(2026-11-02, 扩展 0.1.187 / 客户端 0.2.37)
## 用户裁决:砍掉③④⑤,只留①浏览器标注+②图片,设置也删(2026-11-02, 扩展 0.1.187 / 客户端 0.2.37)

"还是不行, 这样吧不要文件那些了, 只有浏览器标注和图片 / 把设置删了"。misc(文件/代码段/终端)全链拆除:anno-heap 不再扫/桥/返回 misc(删 DUMP_MISC 等),extension 删 annoHeapMiscOn/annoHeapMisc/pairFill 写块/chips==0-misc-only 支/block 附加上下文节,client 删 annoCarryMisc 复选框全链(defaults/normalize/draft/live/shown/dirty/deps/reset/save/JSX),index.js 删 schema 两行。**只保留 element(标注)+image(截图)两类**,清全场规则(所有 chip 无论类型发送后一律 ✕ 清)不变。

顺带补上 0.2.36 **从未写盘**的两刀(仓库 grep=0 铁证,又一桩半套病):client `setAnnoDockChips` 存 kind + `annoComposeBatch` 只列 element——这解释了 15:17 轮为何还出现 `@Terminal Selection (待补)`(客户端 dock 自拼块把附件也列了)。anno-heap 桥加**失败可见日志**(`bridge entry skipped: ...`),不再静默。grep 归零核验:`annoCarryMisc/annoHeapMisc`=0。

## 桥"无响应"挂死全链 + dock 自拼块混列附件(2026-11-02, 扩展 0.1.186 / 客户端 0.2.36)
## 桥"无响应"挂死全链 + dock 自拼块混列附件(2026-11-02, 扩展 0.1.186 / 客户端 0.2.36)

15:12 测试轮日志时序定罪(行号即顺序):`PrepareReq(256) → captured 8 → scan 3e+2i bridging(268) → 发送739(269)`,**中间没有 heap paired / prepared posted / bridge failed**——`getObjectByHeapObjectId` 的响应永不到达(无 error 无 response,GC 竞速),promise 悬空 → annoSendSync 卡死 → prepared 永不回 → 第二次 Enter 走 busy 直发,内容是客户端 dock 自拼块:`@Terminal Selection 全文文件:(待补)`×4 混列、无截图/misc 节。两修:

1. **anno-heap 每个 CDP 调用带截止**(send 加 timeoutMs,默认 25s,快照 120s):超时 reject → 单条桥失败只丢该条;整体失败 → 堆败路(预留文件+无回退)照常收尾,annoSendBusy 必解锁
2. **kind 进 dock**:扩展 annoPushDockList 带 `kind`;客户端 setAnnoDockChips 存 kind;`annoComposeBatch` **只列 element**(busy 直发/超时自拼两条路都干净)——附件本来就归扩展块的截图节/misc 节管

## 组件配置又空了:删行 replace 拼出 livelive(2026-11-02, 客户端 0.2.35)
## 组件配置又空了:删行 replace 拼出 livelive(2026-11-02, 客户端 0.2.35)

0.2.34 删 hideHoverCard 时,deps 数组替换 `'liveHideHoverCard, '`→`'live'` 与后随 token 粘连成 `liveliveAnnoHeapBridge` → settings slot 渲染 ReferenceError → "暂无可配组件"。ego 抓错定罪,单 token 改正,回归:代码审查区+携带/堆两开关都在、旧行没了、console 零报错。教训升级:**replace 的 old/new 必须以完整 token 对齐边界(数组里删一项就删 `x, ` 整段含分隔符),装完必须 grep 拼写粘连模式**。

## hover 回退正式退役:堆败=跳过,不回头(2026-11-02, 扩展 0.1.185 / 客户端 0.2.34)
## hover 回退正式退役:堆败=跳过,不回头(2026-11-02, 扩展 0.1.185 / 客户端 0.2.34)

用户二次令:**"别兜底了不要兜底"**。14:57 轮实证堆路偶发 `getObjectByHeapObjectId: Object is not available`(快照与桥之间 GC 掉的死节点),当时按老逻辑回退 hover → 7 条全走 hover 占位(全文待补 + `(Delete)` 脏名)。四刀(代码在 `7fe85b5`,版本/记账补齐在此):

1. **annoSendSync 回退分支(52 行)整拆**:堆败 → `ctxs2` 直接用标注期预留文件,无预留=该行无全文;hover 链(copilotChipFullContexts 等)成死函数不再可达;`hideHoverCard` 设置行 + schema 键一并拆掉(截图里那行消失)
2. **anno-heap 桥加固**:单条 `getObjectByHeapObjectId` 失败(catch + g.error)只丢该条,不掀全批;`heap held no attachment entries` 只在真全军覆没时才响
3. **observer 名字修复**:anno-observer.js 是模板字符串(`observerSource()` 返回),单反斜杠被模板吃掉 → `(Delete)$` 永不匹配 → chip 名带 `(Delete)` + 前导空格。改双反斜杠 + `.trim()`,node 直调生成码实证 `Z_TEST… (Delete)` → `Z_TEST…` ✓
4. **annoResyncIfOn 补 kind 闸**:文件/终端不再被预占坑(14:57 日志 `[quiet] reserved` 混进 file/terminal 之源)

## annoCarryMisc 保存即弹回:宿主未注册键被归一化丢弃(2026-11-02, 客户端 0.2.33)
## annoCarryMisc 保存即弹回:宿主未注册键被归一化丢弃(2026-11-02, 客户端 0.2.33)

0.2.31 那批脚本在版本循环处崩掉,`index.js` 的两处注册(schema + normalize)实际没写进去;宿主 `set()` 走 `reviewConfigSchema` 归一化,**未注册键当场丢弃** → 用户勾选"发送时也携带…"保存后 settings.json 里根本没有该键 → UI 回弹 false。补 index.js 两刀后,ego 在生产实例上端到端回归:点勾→保存→勾选保持 true,磁盘 `annoCarryMisc=true` ✓。教训(与 0.2.32 同族):**多文件批次改动必须逐文件核验落盘,崩在半路=半套状态**;此后 install.sh 后附带 grep 证据已在做,补一条:python 批次里 assert 失败要打印已写/未写清单。

## 插件卡一点就消失:改名漏网引用砸崩设置区(2026-11-02, 客户端 0.2.32)
## 插件卡一点就消失:改名漏网引用砸崩设置区(2026-11-02, 客户端 0.2.32)

ego-browser 复现抓到现形:`ReferenceError: shownShowHoverCard is not defined` × N → `slot entry crashed in 'plugins.bundle.config'`。0.2.28 把 showHoverCard 极性改名成 hideHoverCard 时,JSX 里 **checked:/onChange 两行因缩进不同没被锚点命中**,声明已改名、引用还是旧名 → 点开"代码审查"设置区(重渲染)整个 section 崩没。修两行残留,0.2.32 部署后 ego 回归:点开后 section 常驻、三个新开关都在、console 零报错。教训入法:**改名必须 grep 全词计数归零,缩进敏感锚点先 sed -n l 验字节**。

## 附件全家族:清全场·带勾选(2026-11-02, 扩展 0.1.184 / 客户端 0.2.31)
## 附件全家族:清全场·带勾选(2026-11-02, 扩展 0.1.184 / 客户端 0.2.31)

堆全谱实证: Copilot 一切附件同族 `{id,kind,name,value}` — `element`(R8s+imageData)/`image`(JPEG)/`file`(URI;**代码段=file+range 行切片**)/`generic`(**终端选区/选中文本=value 即正文**,bundle 原文:`addContext({id:'terminal-selection-…',kind:'generic',value:selection})`)/`instruction`(title)。

用户双令:①设置加复选框 `annoCarryMisc` **默认关=只发①浏览器标注②浏览器截图**(③④⑤dsh 自有实现);②**防御规则:发送后只要 Copilot 有任何东西,无论勾选与否一律清空;勾选只决定带不带**。

- observer `readChips`:识别全部 aria 前缀(element/file/image/context/other),`kind` 随 chip 流转;Suggested 提示 chip 仍除外
- `annoChipKeys` 非 element 加 kind 前缀防串号;预留仅 element
- `anno-heap.js`:misc kinds 常扫;写手在扩展侧按 `annoHeapMiscOn()` 门控(文件读全文≤300KB/range 切行/generic 落文本,按 entry id 去重)
- `realDeleteMiscChips` 扫场:发送后 ✕-click **所有**非 element 附件 chip(找 remove/close/delete  affordance),在 `✕-deleted N` 后追加 `misc sweep N`
- block 三节:元素标注列表(不变)+ 截图附件节 + **附加上下文附件节**(勾选时列 misc 文件)
- 版本对账:0.1.183 的 req 撞车修复实际装在 182 目录里(label 跳过,代码为准);本次 182→184 一次带上

## 段落批注并入 dsh-review 客户端:统一 Enter 总闸(2026-11-02, 客户端 0.2.30)
## 刷新页面后连空白消息都卡 75s(2026-11-02, 扩展 0.1.183)

`annoPreparedPostedFor`(防重答复去重集)**只加不清**:客户端每次页面加载 req 重新从 1 计数,扩展进程却活着整个 session → 刷新后 req=1 被判"已答过",`annoPostPrepared` 静默吞掉,composer 空等到 75s 超时。0.2.27 起"空白也问扩展"让此雷必踩。修:`annoSendSync` 入口清集——去重只需覆盖单次发送的 主路径+finally 双答;跨代重复答客户端按未知 req 忽略,无害。

## 段落批注并入 dsh-review 客户端:统一 Enter 总闸(2026-11-02, 客户端 0.2.30)

dsh-annotate(选段落→批注→打包发送)原是同页第二个 client 插件,与 dsh-review 的 markAnnoSend **各挂各的 Enter**:它 document-capture 先手 stopPropagation,浏览器标注拦截被挤掉;抓取在飞时两边互锁 → "发不出去"。按用户令**整编内化**:

- 其 client.js **原样并入** `dsh-review/client.js`(剥 loader 壳成 IIFE,react 走我们 require;`apply` 串进我们 apply,inject 增补 locale/uiConversation)
- **一个总闸**:`window.__dshrWillTakeEnter()`(gate 开 && 无抓取在飞 = 我们接管;否则段落照旧自己发)
- **合并发送**:被接管的那次 Enter 里,段落批注经 `__dshaPeek` 拼进 draft,随浏览器 block 一起走;发成功 `__dshaClear`;抓取在飞时走 `__dshaFlushNow`(段落即刻经 composer 按钮发,不被扣)
- 独立插件已从 profiles/web **卸载**(防止双挂载复活)

## 抓取进行中的第二条消息不再被吞进队列(2026-11-02, 客户端 0.2.29)
## 抓取进行中的第二条消息不再被吞进队列(2026-11-02, 客户端 0.2.29)

日志还原:第一条(带标注)发送被扣住等堆路 15-40s,期间用户又按 Enter → 旧代码 `annoProgReq!==null → return true` 把它也扣下 → dsh 队列**合并**进那条长 prompt 一起发出,用户侧看两条消息挂着 ×"发不出去"。修:抓取在飞时的后续 Enter **立即走原生队列发送**(它不需要 block)。附带定调:拦截**不看**正文是否 @了 chip——标注永远自动随发(第一版误加"引用才拦"当场撤回)。

## 截图附件 0 字节副本覆盖真图(2026-11-02, 扩展 0.1.182)
## 截图附件 0 字节副本覆盖真图(2026-11-02, 扩展 0.1.182)

测试轮暴露:堆里每个截图附件有**多份 entry 节点**(输入模型+会话拷贝),其中一份 value 是 0 字节空壳;旧循环按节点逐个写同名文件 → 0B 后写 **把 163KB 真图覆盖**(磁盘实证 0B ×2),block 也重复列 4 行。修:按附件名取**字节最多的非空副本**只写一次。顺带核实:两条 mv-vram 是用户真标了两次(不同 entry id 461114/452340),配对无锅。本轮已发消息里的截图文件仍是 0B(历史),下轮起恢复。

## 进度环匀速化 + hover 设置极性反转(2026-11-02, 扩展 0.1.181 / 客户端 0.2.28)
## 进度环匀速化 + hover 设置极性反转(2026-11-02, 扩展 0.1.181 / 客户端 0.2.28)

用户两点:①"两段突然快,割裂" → 进度条改**时间驱动线性爬**:0→38% 快段(~1.7s, "收到感"),随后 38→88% 以 ~1.5%/s **匀速爬**覆盖堆快照+扫描的 15-40s(不再在 40 死等然后 70/90 连跳),stage2/3 到点再平滑推 93/97,prepared →100;②"去 dsh 把 hover 这个设置关了, 默认不修改 vscode hover 逻辑" → 设置改名反极性 `hideHoverCard` **默认关**:完全不碰 VS Code 自己的 hover(堆路主路本就不产生 hover;此项只在堆路失败回退 hover 抓取时有意义);勾选才启用临时 visibility:hidden。settings.json 里旧 `showHoverCard` 键已删。

## 无标注发送卡死 75s 根治(2026-11-02, 扩展 0.1.180)
## 无标注发送卡死 75s 根治(2026-11-02, 扩展 0.1.180)

0.2.27 把"问不问扩展"的决定权移给扩展后,潜伏的 **annoSendBusy 泄漏** 浮出水面:`annoSendSync` 四个早退(busy 忽略/无 driver/开关 off/**空标注**)都 `return`,其中空标注那条**答了但不清 busy** → 下一次发送撞 `during busy — ignored`(不回答) → 客户端握着进度环干等 75s。用户症状:"copilot 没有标注,直接卡死,发都发不出去"。

四处早退全部补齐两条铁律——**每个 req 必回答(空串也算)、每条 return 必清 busy**;busy 撞车时也秒答 ''(请求者永不被晾)。

## 开关重开后标注"没带上"根治(2026-11-02, 扩展 0.1.179 / 客户端 0.2.27)
## 开关重开后标注"没带上"根治(2026-11-02, 扩展 0.1.179 / 客户端 0.2.27)

日志铁证:标注发生在 `annotationToDsh=off` 窗口内 → `annoMirrorOnState` 的开关闸把预留+dock 推送整段跳过(日志 0 条 quiet capture),重开开关后 Copilot 状态无变化 → beacon 不再触发 → 客户端 dock 永远 chips=0 → `markAnnoSend` 提前放行原生发送。用户症状:"我标注了, copilot有, 但没有带上"。

- 客户端 0.2.27(**根治**):删掉 `annoDockChips.length===0 → return false` 早退——**dock 不是真值**,扩展手里有 beacon 实况(annoCurrentChips),真空时它秒答 ''(无闪、~100ms),有货就收。此类"陈旧 dock 漏发"永绝
- 扩展 0.1.179(加固):`annoResyncIfOn` 挂进 onState beacon(去重),开关重开后的**任何**一次 beacon 都会补预留+推 dock
- 用户裁定记录:"你 dsh 进度条渲染就行, 有进度条用户会接受" —— 堆路 15-40s 保持进度环, 不做加速特化


## Heap-Bridge 进插件:发送主管线换血(2026-11-02, 扩展 0.1.178 / 客户端 0.2.26)

用户裁定两枚:①Heap-Bridge=发送默认主路(hover 卡降兜底,一行不删);②heap 路 value **原样全写含全 CSS**(不再剥 KEY COMPUTED STYLES 节,那是 hover 截断时代的遗物)。

- 新增 `dsh-review-vscode/lib/anno-heap.js`:GC→`takeHeapSnapshot`(os.tmpdir,即用即删)→全堆扫 `kind:'element'/'image'`→`getObjectByHeapObjectId` **同 session** 桥回活对象→直读 `value` 全串+`imageData`(VSBuffer 按 byteOffset/byteLength 重建 view,池子坑已埋防)
- `annoSendSync`:`annoHeapOn()`(settings `annoHeapBridge`,默认开)→ 主路 `annoHeapCaptureNow()`+`annoHeapPairFill`(chip 名 vs `Element:` 行精确对撞:`#id` 段必须一致、裸 tag 只配无 id 元素、同名取最新 entry id);任何一步失败 catch→回落 177 hover 链;进度环 stage 语义不变
- **白拿**:输入框里的整页/区域截图附件(`kind:'image'`)同扫直落 `dsh-trump/*-shot-*.jpg`,并在 ③ block 尾部列 `截图文件:` 行
- 文件头新 `# entry id:` / `# via: dsh-review (heap-bridge, no hover)`;截图引用 `## SCREENSHOT (pick-time…)`
- 客户端 0.2.26:发送等待超时 15s→**75s**(快照+解析 15-40s);设置卡新增"发送时堆直读标注(免 hover)"开关(index.js schema/normalization 同步)
- 风险登记:扩展宿主 JSON.parse 240MB(V8 默认堆内实测可过,失败即回落);快照瞬间工作台短卡 ~5s

## ★ 大版本:Heap-Bridge——零 hover 零 click 直取 Copilot 附件全量(2026-11-02,方法论 v1.0)

**本轮没动插件一行代码,但找到了整条管线的"母本"。** 结论链(源码+堆双重实证):

- Copilot 每个附件 chip 背后是 JS 堆里的 entry 对象:`{id, name, kind:'element', value=官方 R8s 全文, imageData=pick 时截图字节, ancestors, attributes, computedStyles, dimensions, innerText, …}`;hover 卡只是它的投影(pick 一瞬固化,之后浏览器关掉也在)
- **取法五步**(tools/deliver_chips.js,全程无 click/hover):清探针自身引用→GC→`takeHeapSnapshot`→全堆按 `kind` 属性扫→`getObjectByHeapObjectId` 桥回活对象直读 `value`(快照串截 1024B,必须桥);截图附件同式(`kind:'image'`,value=JPEG)
- **配对**:chip 名 ↔ entry `Element:` 行精确对撞(`#id` 段一致/裸 tag 配无 id),同名取 id 最新;发送后旧 entry 正常 GC,无累积
- 实测四批全对(含 `button#unload-btn` 与 2 张整页/区域截图附件),样例在 `docs/examples/`,方法长文 `docs/heap-bridge.md`
- 工具持久化:14 个探针脚本收入 `tools/`,输出一律 `os.tmpdir()/dsh-probe/`(开机自清),工作区调试垃圾已全删
- 它是 0.1.177 "发送时 hover 卡"主管线的**替代候选**:内容更全(无 Show More 截断)、不吃面板展开、顺带通吃截图附件;接入前需评估快照 5s+解析 20s 的时延

## 卡文件写法收口为一个函数(2026-11-02, 扩展 0.1.177)

176 首轮(12:28, banner v0.1.176)统一 hover 成立:3 颗全 hover,填占位两条 `card shot`+`card text INNER TEXT:y` 完美;但第 3 颗(发送瞬间才标注,没赶上预留)走发送补写链 → 文件是**裸 hover 文本**(样式节没剥、无 png、无 SCREENSHOT 节)。177:抽 `annoWriteCardFile`(剥样式+存卡图 png+SCREENSHOT 引用+hover-card 头),填占位链与发送补写链共用;`via: hover-card` 从此唯一形态。

## 全线统一 hover 卡单一来源(2026-11-02, 扩展 0.1.176 / 客户端 0.2.25)

用户引句下令:"全部统一成 hover 卡, 你改这个试下"。176:
- 标注时刻: **所有** chip(含带 id)只预留路径占位, 零页面读取
- 发送时刻: `rebuildContextFromPage` 停用, 每颗 chip 一律 CDP 合成 hover 收卡(等渲染稳定, ≤4s/颗), 卡文本+卡内截图 png 覆盖写入预留文件(`via: hover-card`)
- 卡失败的回落: 带 id → 页面全量读(写同一路径, `page-fallback`); 裸 tag → 占位保持如实
- 客户端 0.2.25: 等待兜底 8s→**15s**(N 颗 × 4s 会撞旧限)

## 172 漏括号致死因 + 注释持久化(2026-11-02, 扩展 0.1.175)

12:23 轮(用户已重启, banner v0.1.174):3 个 id 元素 `full:+png` 完美;两个裸 tag 文件里赫然是 `<<eval-error: SyntaxError: Unexpected token ')>>`——**离线重建页面表达式复现**(python 拼串 + new Function):172 重写轮询时把 `if (h) {` 的收尾 `}` 弄丢(原行尾 `return; }` 整行被换掉),hover 读取 100% 崩——"抓的不全"的真凶不是时间。修复:补回 `}`;卡等待上限 2.5s→4s(用户允许加长);另修注释丢失(12:23 beacon lines 只带了 5 个 chip 里的 2 个注释):新增 `annoChipTexts`(key→最后非空注释, beacon 喂, 发送合并时补, fresh slate 清)。验证: 表达式离线编译 `EXPR_SYNTAX_OK len=1762`。

## 注册 key 去文本化 + 填坑条件放宽(2026-11-02, 扩展 0.1.173)

12:21 轮(172 首跑, banner `v0.1.172` 起效):mv-gpu 标注即 `full:+png`(9 块 2.4KB)完美;裸 span 仍是 257B 占位——**注释文本参与注册 key**:占位写于文本变更前('span||1'),发送时 key 变('span|idea|1')→填坑循环/注册表对不上号。三修:① `annoChipKeys`=name+出现序(文本彻底出局);② 填坑条件=有 cx.file 且(有 hover 文本 或 pending),不再单看 pending,且 '(reserved' 开头的占位文本不算内容;③ id 元素发送时 full 仍缺→**发送前二次尝试**(`annoIdSel`→full,失败才回落旧写法;原 forEach 改 async for)。

## 卡片渐进渲染等待 + 彻底去掉 KEY COMPUTED STYLES(2026-11-02, 扩展 0.1.172)

用户两令:① **KEY COMPUTED STYLES 不写不读**(page 全量文件删该节;hover 卡文件把该节替换为 '(computed styles omitted)');② 裸 tag 文件(920B)比 page 文件(14KB)抓得**不全**——根因:悬浮卡**渐进渲染**,轮询见标记就抢读,只拿到前 900B。修法:等到**最后节 INNER TEXT 出现 + 文本长度 240ms 稳定**才取,上限 2.5s(到点取当前, 标 partial);shot 提取随最终文本一起走。

## 裸 tag 终审:直读 hover 卡内容, 不再页面反找(2026-11-02, 扩展 0.1.171)

用户看图定案:悬浮卡内除 KEY COMPUTED STYLES(Show More 截断, 不点)外**全部块都可读**, 直读最准。裸 tag 发送填占位改为:卡 textContent 原样入文件(`via: hover-card`), 不再拿 rect 去页面反找节点(168-170 的 hover-path 实验作废);**卡里的 SCREENSHOT 图**顺手 canvas→dataURL 提出写同名 .png(`[trump] card shot:`), txt 顶部引用。带 id 元素仍走 NInfer 页 page 全量重建(170 的 annoPageEval 修好了目标页, 含全量 computed styles + 页面截图)。

## 全量抓取接错页面→改连 NInfer 目标(2026-11-02, 扩展 0.1.170)

169 的 activate 版本 banner + full-diag 立刻定罪(用户重启后日志第一行=v? 也暴露 banner 的 require 相对路径错, 顺手修 './package.json'):`full-diag: {"sel":"#ms-gpu"} -> node-not-found`——但 CDP 亲测 NInfer 页 `#ms-gpu` 存在。根因:**annoElementFullData/截图用了 `dshState.annoDriver`=Copilot workbench 页的连接**,标注元素长在 NInfer 页上(所以 rebuild 一直是另起 ws 按 host 连 NInfer);workbench 里既无 #ms-gpu 也无那些 rect → 双双 node-not-found。修复:新增 `annoPageTargets/annoPageEval/annoPageShot`(与 rebuild 同款:新鲜 ws 连第一个 http 页 target,排除 127.0.0.1:308x dsh 自身),full builder 与 Page.captureScreenshot 全走此路。

## 元素文件升级为全量 7 块 + 截图(2026-11-02, 扩展 0.1.168)

用户令:悬浮卡 7 块(含图片)全部要进文件,图片引用路径。新增 `FULL_CTX_BUILDER` 页面侧一次 eval:定位节点(**唯一名→#id 直查;裸 tag→用 hover 卡的 POSITION & SIZE rect 等值(±1.5px)+tag 定位**,即"补一刀"方案)后取 URL/outerHTML/attributes/innerText/rect+viewport+**getComputedStyle 全量 resolved**/匹配规则(author 原文≤150)/CSS 变量/HTML PATH。截图=CDP `Page.captureScreenshot{clip=元素rect±8px}` 写**同名 .png**,txt 里 `## SCREENSHOT 文件:` 引用。挂点:① 标注旁观(page 路径,标注即全量);② 发送填占位(hover-path 覆盖**同一预留路径**,消息里路径不失效)。失败逐级回落旧格式(悬停原文/重建文本),永不丢行。

## 设置项:发送读取时显示悬浮卡(2026-11-02, 扩展 0.1.167 / 客户端 0.2.24)

用户令:隐藏悬浮卡改为 dsh 设置卡开关,**默认显示**。新增 `showHoverCard`(默认 true):
- index.js:schema+toJSON 各加一项(存 shadow/settings.json, 走 reviewScope.set)
- client.js:设置卡新勾选行"发送读取时显示 Copilot 悬浮卡"(draft/shown/dirty/save 全链照抄 annotationToDsh 模式)
- extension.js:`annoHoverCardVisible()` 每事件读 settings.json;**只有开关=关才装隐藏观察器**(默认路径=166 之前行为, 悬浮卡照常弹);卸载仍无条件跑(幂等无害)

## 发送读取时隐藏 hover 悬浮卡(2026-11-02, 扩展 0.1.166, 用户批准破例)

用户问"能否 hover 但不显示那个框"→ 可行:我们读的是悬浮卡的 DOM 文本,画面可遮。`copilotChipFullContexts` 读取窗口内:装一个 MutationObserver,把 `.context-view/.monaco-hover/[role=tooltip]` 逐个打 `data-dshr-hidden=1` + **inline `visibility:hidden`**(保渲染, 我们的探测只看 display/offsetParent, 不受影响);finally 必断观察器+逐节点还原 inline 样式。Copilot 的样式表/规则零改动(用户点头的仅是这一次 inline 遮显)。

## 进度条改用 dsh 原生色(2026-11-02, 客户端 0.2.23)

用户:别用自定的蓝色,用 dsh 原生颜色。CDP 探了主题变量(共 30 个,**没有任何 accent 色变量**,主题前景=rgb(253,253,253)):改 `currentColor`(=输入卡自身前景色, 主题切换自动跟随)+ 原生 token:`--dsw-focus-ring-width`(粗细)、`--dsw-radius-md`(圆角)、`--ds-transition-duration/--ds-ease-in-out`(节奏)。环=原生 focus-ring 观感,进度填充=currentColor 16% 透明底。

## 发送进度条:输入框禁用 + 环绕进度(2026-11-02, 扩展 0.1.165 / 客户端 0.2.22)

用户:发送扣住期间界面"过于割裂"→ Enter/点发送后:① dsh 输入框禁用态(contenteditable=false+textarea/button disabled,透明度降),② 输入卡四周环绕进度条,进度满才发送。协议:扩展在 annoSendSync 里程碑发 `dshAnnoProg{req,stage}`(1=开始hover/2=抓取完/3=文件填完),host 白名单加 dshAnnoProg;客户端 stage→8/40/70/90%,`dshAnnoPrepared` 到 → 100% → 环消失恢复输入框 → **此刻提交**。顺手:等待期间再按 Enter/点发送被吞(`annoProgReq!==null` 直接 return true,修 11:08 双 req 双发)。

## 断链二:webview host 白名单缺 dshAnnoPrepared(2026-11-02, 扩展 0.1.164)

11:08 会话:anno mark → PrepareReq → 读全通(reserved filled×4, ③ block ready 6 rows)→ 但 dsh 没拼。定罪:扩展→webview host→iframe 的转发白名单(L771)**只有 dshAnnoDock,没有 dshAnnoPrepared** → 回块死在 host,客户端只能 8s 超时提交;且清理已把注册表推空 → batch="" → 裸发 ping(len=4,日志两条 `anno send: prompt=true len=4`=两个 req 的超时)。次因:annoPostPrepared 用 `dshState.log.appendLine`(log 实为函数)抛 TypeError 被 catch 吞 → posted 日志从未出现。修复:白名单加 dshAnnoPrepared/dshAnnoFocus;log 改 `dshState.log(...)`。

## 元凶:annoPrepSeq/annoPrepPending 未声明(2026-11-02, 客户端 0.2.21)

11:06 会话:决策日志首次立功——`anno mark: hint=1 toggle=1 chips=5 fwd=0` 打出后**戛然而止**。定罪:`annoPrepSeq`/`annoPrepPending` 在 0.2.15 拆旧 prepared 区时被连根删除,0.2.17/19 只补了**用法**没补**声明** → markAnnoSend 走到 `++annoPrepSeq` 抛 ReferenceError → 异常发生在 preventDefault 之前 → 监听器未捕获 → **Enter 原生裸发**,消息不带清单。node --check 查不出未声明变量。修复:模块作用域补 `let annoPrepSeq = 0; const annoPrepPending = new Map();`。

## 决策日志 + PrepareReq 补分支(2026-11-02, 扩展 0.1.163 / 客户端 0.2.20)

11:03 会话定罪:`annoDock recv 3` 后发送,扩展日志**零拦截痕迹**(无 consumed/anno send/③)。两处漏刀:① 扩展桥接层**没有 dshAnnoPrepareReq 分支**(162 只加了白名单,消息进来被丢弃);② 客户端 markAnnoSend 各闸(hint/toggle/chips/fwd)无日志,return false 原因不可见。修复:PrepareReq∪Consumed → annoDeleteAll(req);markAnnoSend 入口每次报一行 `[paste] anno mark: hint=… toggle=… chips=… fwd=…`。

## 发送协议定稿:每次都先读 Copilot,读完再发(2026-11-02, 扩展 0.1.162 / 客户端 0.2.19)

用户终审:"你就不能每次都先读 copilot 再发送吗?" —— **无条件读优先**,快路径(赌旧清单全有路径)废除。同时定位了 10:59 那轮的断链根因:`dshAnnoPrepareReq` **既不在 webview host 的类型白名单**(dsh-browser L781),**也没有 annoSendSync 钩子**(149 回退把 151 加的 PrepareReq 分支删了,consumed→`annoDeleteAll()` 又不带 req)→ 等待路径的回复**从来到不了客户端**,只剩 8s 超时兜底。

- **dsh-browser**:白名单加 `dshAnnoPrepareReq`;consumed 分支把 `msg.req` 递进 `annoDeleteAll(req)`
- **extension**:`annoDeleteAll = (req) => annoSendSync(req)`;`annoSendBusy` 防双驱动(busy 时后来的 req 直接忽略,由在跑的读统一回答);`annoLastBlock` 缓存
- **client 0.2.19**:`markAnnoSend` 单一路径 = 清单空→原生;非空→**只发 PrepareReq{req}**(不再发 Consumed,避免双触发)扣住发送;`dshAnnoPrepared{req,block}` 到达瞬间提交 draft+block;8s 超时用本地清单兜底

## ③ 顺序定稿:hover 完成 → 才发送(2026-11-02, 扩展 0.1.160 / 客户端 0.2.17)

159 的"占位先落盘、发送后补正文"被用户驳回:"都发送了还 hover 你妈呢——hover 完成再发送!"。定稿顺序:

- **标注时刻**:带 id 唯一元素→旁观 page 重建,秒完,面板不动;裸 tag→只**预留文件路径**(占位正文),不 hover(标注立刻回 dsh)。
- **发送时刻(客户端 0.2.17 两路)**:
  - 清单**行行有真实路径**(全唯一元素)→ **直发**(同 tick 拼+prompt,零等待)
  - 有"待补"→ **扣下这次发送**(`dshAnnoPrepareReq{req}`),扩展 flash→hover→**填完预留文件**→**立刻回块**(`dshAnnoPrepared`,在 ✕ 清理**之前**)→客户端此刻才 `prompt(draft+"\n\n"+block)`。8s 超时兜底直发;扩展任何早退/异常路径**必回**(`annoPostPrepared` + finally 兜底),发送永不挂死。
- 块文案不变(编号+注释+路径);`annoSendSync(req)` 恢复 req 通道,清理仍在回块之后进行。

## 启动清理补漏:等"迟到回显"的 chip 再裁决(2026-11-02, 扩展 0.1.157)

156 实测(10:31:53 会话)仍有残留:启动清理在**首信标**时看到 `chips=0` 就收工——但**未发送标注的模型回显晚于面板首次渲染**(0.1.115 已知竞态),~10s 后 3 个旧 span 才浮出,被 155 的旁观抓取当新标注登记 → 拼进消息且 2 个"待补"(hover 来不及)。修复:启动清理若首信标 0 chips,`waitForChipBeacon(2500)` **有界等待迟到回显**,来的 chip 一并 ✕ 删;删空后 baseline/注册表/dock 全归零。

## 每次启动/reload 强制清空 Copilot(2026-11-02, 扩展 0.1.156)

用户指出清单"待补/残留"的入口:上次标注未发送直接退出 → 重启后 chip/输入行残存。旧行为:启动清理被 `annotationToDsh` 开关闸住(off=完全不动)。新裁决:**每次 VS Code 打开/reload 无条件强制清空**。

- activation 启动块去掉 feature 闸(flash→渲染→清输入 必跑)
- `annoMirrorOnState`:一次性启动清理(✕删全部 chip + newChat + verify + baseline)挪到 **toggle-off 早退之前**——off 也清;清完才走"feature silent"分支
- 清理时同步 `annoCaptureFiles.clear()` + 推空 dock 清单(残留不进客户端拼接列表)
- 旁观抓取加 `!annoStartupCleanup` 竞态守卫(清理未完不抓, 防旧 chip 混入清单)

## ③ 终版:料在标注时备好,Enter 全程同步(2026-11-02, 扩展 0.1.155 / 客户端 0.2.15)

用户两条铁律:**标注时刻原生不动** + **发送必须同一条消息拼上**。此前失败根因=发送路径上有异步(扩展往返/按钮 disabled/占位没做)。0.1.0 不卡的秘密=它的 batch 在按下 Enter 的同 tick 本地可读(pending Map)。照此重造:

- **扩展 155(被动旁观)**:beacon 上报新 chip(非 baseline)→ `annoQuietCapture`:page 重建读页面 DOM(歧义名才 hover,零点击)+ `annoWriteFile` 写盘 + `annoChipKeys`(name|text|第几次出现,解决同名歧义 key)登记 → `sendAnnoDock` 推 `{name,text,file}` 清单给客户端(=它的 pending)。**不点不删不动面板**;chip 删除仍是发送后 149 清理(✕ 完清注册表)。
- **客户端 0.2.15(逐行对应 0.1.0)**:`markAnnoSend(event)`:consume 照发;清单空 → return false 完全原生;清单非空 → 同步 `annoComposeBatch`(文案同前)+ 读草稿剥零宽 + `text=draft+"\n\n"+batch` → **然后才** preventDefault/stopPropagation(L781-782 次序)→ `__dshrAnnoPrompt(text)`(=L851 `session.prompt(parts,'queue')`,生成中/空闲通用)→ 成功清草稿;prompt 缺失才回落 setDraft+按钮(L181-189)。`annoForwarding` 1s 防重入。
- dock 数据链:`setAnnoDockChips` 保留 `file` 字段并入去重比较;顺带清掉 0.2.14 遗留的残缺行(`functionhrAnnoPrepared`)。

## ③ 全线回退:扩展回 149,客户端拆掉拦截(2026-11-02, 扩展 0.1.149 / 客户端 0.2.14)

0.2.11-13 的拦截拼接实战不过关:Enter 被吃、要敲多次、仍没拼上(10:18 会话日志里连 prepare/consumed 事件都没有——新客户端没被加载,版本又钉错历史遗留)。用户令:**回退 149**。

- **扩展 0.1.149(行为+版本号都回到 149)**:删 `annoSendSync(req)`/prepared post/③ compose 块/dock push(152);`dsh-browser` 恢复只认 `dshAnnoConsumed`。抓取/全文/写文件/清理/回焦 = 149 原样。
- **客户端 0.2.14**:`markAnnoSend` 回**不拦截**语义——发送永远原生立即出去(fire-and-forget consume),Enter 绝不被吃。保留:dock UI 不渲染(0.2.9 令)、`dshAnnoFocus` 回焦、stop 按钮守卫。③ 搁置,拦截协议代码留档(不再触发)。
- EXA 检索归档(hermes-agent #39630 等):contentEditable 拦截 Enter 的通病=**React state 落后 DOM 一个 render** + IME composition 竞态——当年 dsh-annotate 用 `session.prompt` 公开门面正是绕开按钮/状态竞态;将来重做 ③ 时按此教训设计(不要 preventDefault 用户的 Enter,改用 dsh 队列 API 追消息)。

## ③ 收敛为 dsh-annotate 同款 prompt 发送;install.sh 字典序 bug 修(2026-11-02, 客户端 0.2.9→0.2.13)

用户裁决:**dock 框不抄,只抄拼接**。演进(全部有日志/探针证据):
- 0.2.9:composer 上方 chip 镜像 UI 移除(`return null`,数据保留)
- 0.2.10:发现 setDraft 异步 → 同帧点按钮 disabled → **消息被吞**;改轮询按钮
- 0.2.11:拦截判据从客户端 dock 改为**问扩展**(无标注 `block=''` 毫秒放行;`annoPrepPending.size>0` 吞连按;扩展 finally 兜底必回)
- 0.2.12:探针实锤生成中主按钮 = `aria "Stop generating"` → 点它=杀 agent
- **0.2.13(现行)**:照抄 dsh-annotate@0.1.0 的真发送——`ctx.sessions.sessionOf(scope).prompt([{type:"text",text:composed}], "queue")`(公开会话门面,生成中/空闲通用,零按钮零 Enter),发出后 `setDraft("")`;按钮轮询仅留作 fallback。拼接式与 0.1.0 一致:`clean_draft + "\n\n" + block`。
- **install.sh 大 bug**:"newest wins (glob is sorted)" 是**字典序**——`0.2.13.tgz` 排在 `0.2.9.tgz` 前,导致 0.2.10-13 每次都被降级安装成 0.2.9(记录也被钉死)。改为按 `package.json` 版本号精确定位 tarball;重装后记录=node_modules=**0.2.13** 实锤。

## ③ 落地:拦截发送,末尾拼"文件路径清单"(2026-11-02, 扩展 0.1.151 / 客户端 0.2.8)

**调研**(dsh-annotate@0.1.0 源码 `client/client.js`):拼接式 `text = draft + "\n\n" + batch`,`setDraft` 后**程序化点击发送按钮**提交(保留附件/清理);原文案 `以下是我对你上面回答的标注:` + 编号引用/标注行。

**用户拍板**:文案=推荐版(只拼路径不拼全文,agent 自己读文件);机制=**拦截拼接**。

- **客户端 0.2.8**:`markAnnoSend` 升级为拦截式——dock 有标注 chip 时 `preventDefault+stopPropagation` 扣下发送,post `dshAnnoPrepareReq{req}`;收 `dshAnnoPrepared{req,block}` → `__dshrAnnoGetDraft/ SetDraftFull`(新增导出)拼 `draft + \n\n + block` → `annoForwarding` 防重入 → 点发送。**6s 超时**自动放行原草稿(不阻塞用户)。无标注=零延迟老流程。Enter/按钮两入口都接。
- **扩展 0.1.151**:`annoSendSync(req)` 写文件后组块 `以下是我对浏览器元素的标注(全文见各文件):` + `N. @元素 注释: x` + `全文文件: <abs path>`;完成时 `postMessage({type:'dshAnnoPrepared', req, block})`;`dsh-browser` 分发 `dshAnnoPrepareReq`(兼容旧 `dshAnnoConsumed`)。日志 `[trump] ③ block:` / `③ prepared posted`。

## 150 弹窗关闭回焦:失败,回退 149(2026-11-02)

0.1.150 曾加 observer v3(检测弹窗编辑框 有→0 → `anno-ui-close` → 切 dsh+回焦)。用户实测:焦点仍抢不到 dsh——原生标注弹窗就是为**连续标注**设计的(焦点留在浏览器是特性不是 bug)。按用户令回退:observer 回 v2、anno-cdp 去 `onAnnoUiClosed`、extension 去钩子,版本号还原 **0.1.149** 重装。标注后焦点行为=原生(留浏览器);发送后回焦(148/149 链路)保留。

## 无标注不闪 + 焦点归还 dsh(2026-11-02, 扩展 0.1.148 / 客户端 0.2.7)

用户两案:①标注后与发送后焦点必须回 dsh 输入框;②只有"dsh 发送且有 Copilot 标注"才该闪——实测**空发送/暂停点击也在闪 copilot**(日志多次 `captured 0` + flash)。

- **扩展 148**:`annoSendSync` 入口新增静默闸——`annoCurrentChips` 为空(annotation 创建时 beacon 必经过、widget-gone 不清计数,空=确无待处理)→ 打日志 `stay quiet (no flash)`,**不 flash 不清理直接返回**;`annoReturnIfIdle` 每次回 dsh 后向 webview `postMessage({type:'dshAnnoFocus'})`(立即 + 350ms 补一发)。
- **客户端 0.2.7**:`onBridgeMessage` 处理 `dshAnnoFocus` → `window.__dshrFocusComposer()`(已有导出);发送按钮 click 判定加 **stop/pause 标签守卫**(生成中主按钮是停止,不算发送)。

## hide chat 实验终结:无幂等 hide 命令,用户令停(2026-11-02)

用户希望标注/发送返回 dsh 前自动 "hide chat"。CDP 实测(全部不动代码):标题栏 Chat 按钮= `workbench.action.chat.toggle`(合成点击无效);面板 Chat 标签的 view 无 `.focus` 之外的动态命令(`.hide` 不存在,源码无 `+".hide"` 注册);命令面板只有 **View: Toggle Panel Visibility**——能隐藏(chatVisible true→false, panelH 293→0 实证)但**切换语义**,再按会开回来;误选行还弹过两次 About。结论:这台 VS Code 没有幂等 hide。曾提议"状态感知 toggle",用户裁决"不行, 算了, 别实验了"——扩展侧维持 0.1.147 行为,不碰任何面板命令。

## hover 超时自动重试一次(2026-11-02, 扩展 0.1.146/0.1.147)

09:35 轮(还原 139 后首测):3 个裸 span,文件 1/2 = `<<timeout-1.5s>>` 占位(悬停被面板切标签拖慢),文件 3 = Generating 徽章全文正常。修复:检测到 timeout 即**重悬停+重等待一轮**(hoverIn(0)+300ms+hoverIn(-1)+同款 promise),日志 `[trump] hover retry @x -> ok|still timeout`;仍失败则文件如实保留 timeout 文案。146 改代码 147 部署(145=回退 aux 的版本号还原)。

## aux 干预全部删除,行为回到 139(2026-11-02, 扩展 0.1.145)

144 的"空则关闭"实测仍黑(判定疑被壳内杂元素骗过,且用户令"copilot 的任何 css/任何东西都不动")。AskUserQuestion 拍板"彻底不管(回退到 139)":删除 `annoHideAux` / `annoShowAuxDelayed` / `annoCloseAuxIfEmpty` 三个 helper 及全部调用点(四条冻结路径),语法过、装 0.1.145。aux 黑列被认定为 `chat.open` 原生命令强制拉开空壳所致(VS Code 行为,非扩展 CSS),用户接受该视觉现状。抓取/清理/交付链路不受影响。

## 真凶:空 auxiliary 黑列——chat.open 强制拉开(2026-11-02, 扩展 0.1.144)

143 回退 CSS 后用户仍见右栏黑(截图 09:30:56:红框=619px 空黑列)。定罪:Copilot 已搬到底部面板 Chat 标签后,auxiliary bar 是**空壳**,但 flash 用的 `workbench.action.chat.open` 会**强制打开 auxiliary**——空壳现形即黑。与我们的(已停用)cloak CSS 无关。修复:`annoCloseAuxIfEmpty()` 在四条冻结路径收尾时检测 auxiliary——**仅当空**(无 chat 输入/视图)才 `workbench.action.closeAuxiliaryBar`;右侧 Copilot 布局(occupied)不误关。

## 屏外 CSS 全部停用(2026-11-02, 扩展 0.1.140→0.1.143)

- **0.1.140**: 新增 `annoHideAux`(冻结期把 auxiliarybar 挪屏外)/`annoShowAuxDelayed`(延迟 350ms + freeze 防误撤),接进 annoSendSync/startup/startup-cleanup/late-chips 四条冻结路径
- **0.1.140 失效**: 用户仍见面板——CSS `#workbench.parts.auxiliarybar` 把带点的 id 当 class 解析,选择器没命中;141 改 `[id="…"]` 属性形式,探针实锤 x 1297→-99995→1297
- **0.1.141 副作用**: 发送时整片黑——`position:fixed` 把 aux 从布局抽走,邻区 resize → webview 黑闪
- **0.1.142**: 改 `transform:translateX(1400px)`(探针证明其他 parts rect 一像素不动),用户仍报"左边整个黑了"
- **0.1.143(现行)**: 用户令"先把黑的 css 回退"——`annoHideAux` 停用(保留调用点的清理,残留样式自愈)。新方向:把 Copilot 放底部面板 Chat 标签 + 隐藏标签读 DOM(免 open 免跳转),待用户摆好布局取证。

## 屏外 CSS 选择器修正(2026-11-02, 扩展 0.1.140→0.1.141)

0.1.140 用户实测"依旧能看到":CSS 里 `#workbench.parts.auxiliarybar` 被解析成 `id=workbench` + `.parts.auxiliarybar` 两个 class——而该元素 **id 字面含点**(`id="workbench.parts.auxiliarybar"`),`#` 语法无法命中。改属性选择器 `[id="workbench.parts.auxiliarybar"]`。**探针实锤**:注入前 x=1297 w=619 → 注入后 x=-99995 w=900 → 移除后 x=1297,收放干净无残留。

## Copilot 面板屏外闪(0.1.140, 2026-11-02)

用户诉求:发送时 Copilot 面板闪现占屏——能否放"隐蔽位置"或对 CSS 做手脚。实现:`annoHideAux()` 在所有冻结路径(annoSendSync / startup flash / startup cleanup / late-chips guard)注入 workbench 级样式 `#workbench.parts.auxiliarybar{position:fixed;left:-99999px;width:900px;height:100%}`(选择器实测存在,619×1044 static):面板**整块挪出视口**但内部布局照常(chip 排布/hover/读取/✕ 全部如旧),**用户全程只见 dsh,零闪现**。撤除延迟 350ms 且 freeze 防护(`annoShowAuxDelayed`:若下一轮已重新 cloaked 则跳过),防连发时样式被上一轮误撤。

## 同名 chip 张冠李戴:merge 按序号不按名字(2026-11-02, 扩展 0.1.139)

09:16 轮:用户标了**三个不同徽章**(Idle/Unloaded/Reading 类),交付文件三个全是 "Unloaded"。悬停本身没错——错在 0.1.131 的 merge:`ctxs.find(x => x.name === c.name)` 按名字配对,三个 chip 都叫 `span` → 全部配上第一个捕获。修复:①merge **按 index** 对齐(ctxs 与 chips 同为 DOM 序,构造性保证);②`copilotChipFullContexts(onlyIdx)` 只悬停歧义 chip,page 已重建的直接跳过占位 null——每轮省 3 次无谓悬停。

## 悬停时序回滚到宿主侧(2026-11-02, 扩展 0.1.136→0.1.138)

- **0.1.136**: 微移挪进页内 Promise(220ms setTimeout)+80ms 轮询+1.2s 封顶 → 09:14 轮裸 span `timeout-1.2s`
- **0.1.137**: 补 micro-move 漏发的 mouseover → 09:15 轮 3 个裸 span 仍全 `timeout-1.2s`
- **0.1.138(现行)**: 定罪——发送冻结期 workbench 渲染器繁忙,**页内 setTimeout 被拖晚**,悬停 arm 窗口错过;而 135 的微移由**扩展宿主** sleep(400ms)+eval 派发,不受渲染器负载影响 → 回滚到宿主侧时序(400 sleep + hoverIn(-1) + 1500ms 封顶),仅保留两个无害收益:轮询 100→80ms、最后一个 chip 免撤悬停。教训:与 monaco 交互的节拍器必须放宿主侧。

## 136 微移漏 mouseover 修复(2026-11-02, 扩展 0.1.137)

0.1.136 实测(09:14 轮):裸 span `timeout-1.2s`——220ms 处的页内微移只发了 pointerover+mousemove,**漏了 mouseover**(08:24 验证过的开悬停三件套),delayed-hover 没被喂到。137 补齐三件套,其余提速不变。

## 悬停单往返化(A 方案,2026-11-02, 扩展 0.1.136)

用户拍板:先 A(微优化),接受不了再上 B(堆内直取模型数据)。实现:每个歧义 chip 从「400ms 死等 + 第二次 hoverIn eval + 100ms 轮询 + 120ms 撤悬停」压缩为 **hoverIn 一次往返 + 页内 Promise 全包**(220ms 处自发微移续期、80ms 轮询、1.2s 封顶;末个 chip 免撤悬停)——省 ~150-250ms/chip,地板仍是 monaco ~300ms 延迟。

## 撤 cloak,悬停提速(2026-11-02, 扩展 0.1.133→0.1.135)

- **0.1.133/134(失败实验)**: 给 `.context-view` 加 `visibility:hidden`/`opacity:0` 想隐身 hover——实测 hover 管理器被可见性闸门**拒绝打开**,两个裸 span 全部 `timeout-4s`。用户判词:"只是隐藏了过程,并没有秒回;还不如不隐藏"。
- **0.1.135(现行)**: 撤 cloak(hover 如实可见),改为**真提速**:monaco delayed-hover ~300ms 开,单次 400ms 等待 + 一次 micro-move,轮询 200→100ms,超时 4s→1.5s——每歧义 chip ~0.5s(原 ~1s+)。带 id/class 元素仍 page 秒回(hover 只服务歧义回退)。

## 隐身悬停:歧义元素回退也不再可见(2026-11-02, 扩展 0.1.133)

**背景**: pin 消歧实测无望——预发送态页面只有空 `data-vscode-pick-host`(0 子节点),workbench 侧也无 pin(pin 仅在 Copilot 发送后挂出,我们不从 Copilot 发送)。裸 tag 回退 hover 仍肉眼可见("还是看到 hover 过程")。

**实现**: hover 只依赖面板**打开**,不依赖**可见**。`copilotChipFullContexts` 抓取期间注入 `#dsh-anno-hide-hover{.context-view{visibility:hidden!important}}`(保留布局:offsetParent/textContent 照读,用户肉眼零弹窗),finally 里移除。带 id/class 唯一元素仍走 page 秒回(本就不 hover);歧义元素 hover 拿摘要——全程无感。

## 文件头 via 如实标注来源(2026-11-02, 扩展 0.1.132)

0.1.131 实测(08:53 轮):2 个标注 0 hover,page 重建全文 135 行交付 ✓。唯一瑕疵:文件头 `# via:` 写死 "synthetic-hover capture",与真实来源不符 → 改为 `(' + cx.source + ')'`(page/hover 如实打印)。已知边界:裸同名 tag(两个 `span`)无法页面唯一定位,仍回退 hover(可见、慢一拍),后续可用页面 pin 序号消歧。

## 全文改页面侧重建:URL+OuterHTML+完整CSS,无 id 才回退 hover(2026-11-02, 扩展 0.1.131)

**问题**: 悬停面板是摘要——缺 URL、Outer HTML 正文、完整 CSS(Inherited/Resolved/变量被 "Show More" 截断),用户实测"感觉少东西"。且逐个 hover 肉眼可见,不够无感。

**实现**(用户拍板 ①重建 ②尽可能无感): `rebuildContextFromPage()` — 发送时对每个 chip 名(`tag#id`/`tag.class`/裸 tag,须**全页唯一**才用)开一条一次性 CDP 连到集成浏览器页 target,单发表达式取回 `{url, path, outer, own[], inherited[], resolved{}, vars{}, dims}`(实测 span#mv-vram:own 3 / inherited 32 / vars 62 / outerHTML 完整),拼成与 Untitled 文档同格式的全文。**零 hover、零点击、毫秒级**;仅当无法唯一定位(如两个裸 `span`)才回退合成悬停。merged 后统一写文件,日志 `[trump] ctx @x [page|hover]` 标注来源。修复过程:表达式曾漏一个 `}`(for-s 未闭合)导致 SyntaxError,已在真页面 eval 验证通过后才部署。

## 发送即交付:annoSendSync 自动写"一个标注一个文件"(2026-11-02, 扩展 0.1.130)

**需求**: "为什么还要你自己写? 发送时→写入文件" —— 交付不该等 agent 事后手抄。
**实现**: `annoSendSync` 在 ctx 抓完后按 chip 顺序逐个写 `/tmp/dsh-trump/<UTC-stamp>-<i>-<element>.txt`(头: element/comment/time/via,正文: 悬停全文原文),路径逐条打日志 `[trump] file: <abs path>`,grep 即得。发送→文件→清理,全自动,零人工。

## Show More 定罪 + 旧行复活双清(2026-11-02, 扩展 0.1.126/0.1.127)

**0.1.126 — 全文通道终稿**: 用户手动验证:**点悬停面板里的 "Show More..." 也会打开 Untitled-1 编辑器**(与点 chip 同罪)→ 一律不点,只收悬停原文。同时修两个 bug:① `driver.cdp.send` 返回的是 CRI 的**内层 result**(`{result:{type,value}}`),旧代码按 ws 全消息取 `r.result.result` → 永远 `<<no-value>>`(08:04/08:20 之谜);② 同名 chip(两个 'div')按 aria 相等定位会串 → 改**按序号**定位。实测(08:28 轮):3 个 chip 悬停全文全抓到(见 `/tmp/trump-ctx-0828.txt`)。

**0.1.127 — 旧行复活**: 08:28 轮 verify 显示 `@span#mv-temp 1 | @div 3 | @span#mv-disk 1` 三条**孤儿旧行**在"cleared:keyboard"后仍在——CDP 键盘事件对 Monaco 聊天输入不可靠(用户确认"这个问题一直在")。修复:`clearCopilotInput` 改**双保险**——页内 `execCommand(selectAll→delete)` 主清(打印 `before->after` 行数)+ CDP 键盘兜底。

**0.1.128 — 模型层终极清**: 08:37 轮 `exec 3->3`——execCommand 与键盘两条 DOM 路都没杀掉僵尸行。加第三条路:官方命令 `workbench.action.chat.open {query:' ', isPartialQuery:true}` → `chatWidget.setInput(' ')`(chatActions.ts 源码证实)在 **InputModel 层替换内容**,僵尸行从模型根上消失(重开也无法复活),再补一发 Backspace 清空格。日志:`input clear=cleared:exec 3->3 +setInput check:lines:3`。

## 抓全文定稿:纯合成事件悬停,零物理鼠标、零点击(2026-11-02, 扩展 0.1.124/0.1.125)

**禁区澄清(用户截图为证)**:点击 chip 会打开 "Attached Element Context from Integrated Browser" 的 **Untitled-1 未保存编辑器**——绝对禁止(它弹出/关闭都会触发保存)。之前用 `Input.dispatchMouseEvent` 移动的是**物理鼠标**,也会把那个原生弹窗顶到指针下。

**定稿方法(08:24 实测通过)**:JS `dispatchEvent(pointerover/mouseover/mousemove)` 打在 chip 上(ElementChatAttachmentWidget 的 delayed-hover 监听 DOM 事件)→ `.context-view` 悬停面板打开 → 读 textContent(span#mv-temp 全文 697 字符:SCREENSHOT/ELEMENT/KEY COMPUTED STYLES/HTML PATH/ATTRIBUTES/POSITION & SIZE/INNER TEXT)→ tooltip 内点 "Show More..." 展开完整 CSS(点 tooltip 内部,不点 chip)。物理鼠标全程不动,Untitled 永不出现。
- 0.1.124:Input 步进版(已被 125 取代);08:04 轮日志 `<<no-value from evaluate>>`。
- 0.1.125:`copilotChipFullContexts` 改合成事件版并部署。取证旁证:chip 节点自有属性/Symbol 为空(数据在闭包/`[[Scopes]]`,getEventListeners 的 handler 无 objectId,故不挖闭包,直接用悬停实现读渲染后的 `.context-view`)。

## ①抓全文:hover 取 chip 完整 Attached Element Context(含 Show More 展开)(2026-11-02, 扩展 0.1.123)

**背景**: 标注元素的全文(SCREENSHOT/ELEMENT/KEY COMPUTED STYLES/HTML PATH/ATTRIBUTES/POSITION & SIZE/INNER TEXT)只存在于 chip 的**悬停 tooltip**。**用户硬规则:绝不点击 chip**(点开是一个未保存文件);Show More 在 tooltip 内部,可点。已用 CDP 真鼠标验证抓通(span#mv-temp,697 字符)。

**实现**: 新增 `copilotChipFullContexts()`:对每个 `aria-label="Attached element, X (Delete)"` 的 chip——CDP `Input.dispatchMouseEvent mouseMoved` 分步进人(只有 moved,无 pressed)→ 页面内一次性有界等待(≤3s)`.context-view` 弹窗 → 命中 "Show More..." 就点(**tooltip 内部**)再读 → 移出关闭 → 下一个。挂入 ①(在 ✕ 删除前,chip DOM 还活着),日志 `[trump] ctx @X >>> …`。**③仍只打印**,未拼接进 dsh 草稿(调试契约:只做 ①②,③打 output)。

- `package.json`: 0.1.122 → 0.1.123;经 install.sh 部署。

## 清输入行:两处时机 + 清后验证 + 严格受开关控制(2026-11-02, 扩展 0.1.122 / 客户端 0.2.6)

**需求**(用户): 只在 **① dsh 发送** 和 **② reload VS Code** 两个时机清空 Copilot 输入框;**仅当设置卡「浏览器元素批注发给 dsh」开启时**,关闭则完全不碰。

**实现**:
- `extension.js` 0.1.122: 新增 `clearCopilotInputVerified(log, tag)` = `clearCopilotInput()`(CDP focus→Cmd+A→Backspace)+ 一次有界验证(读 `.view-line`,非空再清一次,只重试一次)。两处调用点全部换用:①`annoSendSync`(顶部 `annoFeatureOn()` gate,off 直接 return);②startup IIFE(reload 时,`annoFeatureOn()` off → `feature silent` 直接 return)。日志:`input clear=... verify=EMPTY`。
- `client.js` 0.2.6: 开关文案更新(去掉过时的"停顿 2.5 秒",写明"打开面板立刻送回 dsh""关闭后不抓取、不清理、不闪回、**不清输入行**")。
- 均经 `install.sh` 部署(dsh-review-0.2.6.tgz 记录进 profile package.json,服务器重启不再回退)。

## 修"后续只能标注1个":发送时清空 Copilot 输入行(2026-11-01, 扩展 0.1.121)

**症状**: 首次连标多个都行;之后每轮只能标 1 个(标第 2 个无声无息失败)。用户手动 `Cmd+A`+`Delete` 清空 Copilot 输入框后**连标恢复** → 坐实。

**根因(搜索为证)**: Copilot 标注机制是"chip + 输入框里一行 `@元素名 注释`";**同名 @行已存在时新标注被去重吞掉**。而 VS Code `newChat` 有官方 bug——draft 会带进新会话(上游 commit 6babfd1 于 2026-02 才修复,本机 1.144 未含),旧 @行堆每轮复活。日志里 `lines=[prefill,kv-bar,decode,count...]` 12 行反复还魂即此。官方命令清不了:`chat.open` 的 setInput('') 因空串 falsy 被跳过,`clearInputHistory` 只清历史。

**修复**: 发送路径 `annoSendSync` 在 ✕ 删 chip 之后、回 dsh 之前,调 **`clearCopilotInput()`**(CDP:focus textarea → Cmd+A → Backspace,即用户手动验证过的动作),把行堆清零。freeze 窗口内 ~50ms,不破坏 0s 闪回。日志:`[trump] clear: input=cleared:keyboard`。

- `package.json`: 0.1.120 → 0.1.121;经 install.sh 部署,目录+catalog 一致。

## 发送闪回也 0s:hot path 直读 beacon 载荷,newChat/迟到守卫放后台(2026-11-01, 扩展 0.1.120)

**需求**: 用户"发送的时候, 也要0.000000001s内从copilot闪回dsh"。

**改动**(`annoSendSync`):
- 热路径**去掉 120ms 固定等待和多余 eval**:flash 重开时,渲染 beacon 的载荷就是状态(`annoMirrorOnState` 在 DOM 变化瞬间已填好 `annoCurrentChips`),直接用它。
- ✕ 删完 → **立即 `annoReturnIfIdle()` 回 dsh**;`newChat` 与迟到-chip 守卫挪到**后台**——newChat 若把 Copilot 顶回来,open-beacon"打开即回"会瞬间再送回;守卫只在真有迟到 chip 时自带 freeze 短暂重开。
- Copilot 可见时长 ≈ 渲染 + 点✕(此前还叠 120ms+1s+1s)。

- `package.json`: 0.1.119 → 0.1.120;经 install.sh 部署,目录+catalog 一致。

## 打开 Copilot 即回(0.1.119)+ 改走官方 install.sh(0.1.118)(2026-11-01, 扩展 0.1.118/0.1.119)

**0.1.118 — 部署根因**: 之前全是手动 cp,从没跑过仓库的 **install.sh**,导致 ① `extensions.json` catalog 与实际目录脱节;② install.sh 第 4 步(reset shadow store / 清空 pending)从未执行——用户截图里 "Review Changes 13/15" 的**文件数**一直没归零,被当作"install 没生效"的证据。另外 dsh 服务器启动会按 package.json 记录的 `file:<tgz>` **重装覆盖** `node_modules/dsh-review`,手动拷进去的 client 会被打回(0.2.5 曾被复原 0.2.4)。从 0.1.118 起**一律 `bash install.sh` 部署**(npm pack → `dsh plugin add tgz --force` + 扩展 copy + catalog 同步 + shadow 重置)。

**0.1.119 — 打开即回**: 用户拍板"打开即回(0s)"。`onOpened` 不再 2.5s 防抖,直接 `annoReturnToDsh=true; annoReturnIfIdle()`;例外:annoSendSync 读取(freeze)或 ✕ 删除进行中时保持面板开着,否则读不到 chip。

- `package.json`: 0.1.117 → 0.1.118 → 0.1.119;两次均经 install.sh 部署,目录+catalog 一致。

## 打开 Copilot 即闪回 + 发现服务器缓存旧 client(2026-11-01, 扩展 0.1.117)

**症状**: 用户"还是可以自由打开 copilot"(打开面板不闪回);"显示13 说明 install 没起作用"。

**事实核查**:
- 0.1.116 确实在跑(日志出现新 `read 0 chips — waiting` 与 DOM dump)。**DOM dump 铁证**:发送时 Copilot DOM 里根本没有 element chip(仅 "Suggested browser context" 1 个)——标注当时不在面板里。
- "install 没起作用"对**客户端**成立:dsh 服务器把插件 combo bundle(`plugins/??...dsh-review/client.js&rev=...`)缓存在内存,VS Code 重启不刷新 → 设置的文案/逻辑还是 0.2.4。**需 `dshReview.restartDsh` 重启 dsh 服务器**才拉到 0.2.5。

**修复**: "打开 Copilot 就该闪回"——observer 在 container **无→有** 转换时发 `{ev:'widget-opened'}`(detach 时清 attachedCont 保证可再触发);anno-cdp 转 `onOpened`;extension 收到即 `scheduleReturnToDsh(2500)`(off 时忽略)。即:打开面板 2.5s 无操作自动回 dsh;标注每次真变化重置计时。

- `package.json`: 0.1.116 → 0.1.117;部署完成,旧 0.1.116 已删。

## 修"打开 Copilot 不闪回":重复 beacon 把防抖无限推迟(2026-11-01, 扩展 0.1.116)

**症状**: 0.1.115 里用户打开 Copilot(开关已开),视图不回 dsh。日志尾部 18 条一模一样的 `beacon chips=[] lines=[...]`。

**根因**: Monaco 重绘/容器重挂反复触发 scheduleBeacon,状态完全相同也照发;每条 beacon 都把 2.5s 闪回防抖清零 → **重复 beacon 风暴把闪回无限推迟**。

**修复**(两层去重,均事件驱动):
- `lib/anno-observer.js`: `doBeacon` 加状态键去重(chips+lines 全同则不发);widget-gone 时清空键,保证下次渲染必发(渲染探测不受影响)。
- `extension.js`: `annoMirrorOnState` 再加一层 belt——只有**真变化**的 beacon 才打日志并 `scheduleReturnToDsh`;重复 beacon 只刷 annoCurrentChips。

- `package.json`: 0.1.115 → 0.1.116;部署 `dsn.dsh-review-vscode-0.1.116/`,旧 0.1.115 已删。

## 修"标注了却读0":监听器补 document 级兜底 + 空窗期读0改等 beacon + 开关(2026-11-01, 扩展 0.1.115 / dsh 客户端 0.2.5)

**症状**: 用户标注 3 个(count/prefill/host-fill),dock 显示 3 个,但发送时 `[trump] captured 0 chip(s)`。用户诊断:"你监听的是 copilot,但你读的时候读的是 dsh"。

**根因(两层)**:
1. **读取空窗**: Copilot widget 是易碎 DOM——视图切回 dsh 时被销毁;发送时 flash 重开,**container 先渲染(空的),chip 从模型异步晚一拍才插入**。annoSendSync 在 120ms 窗口里读 → 0。
2. **监听器漏事件**: chipObserver 只绑在"第一次出现"的 container 节点上;VS Code 重渲染子树后 chip 插入发生在**新 container 实例**,旧 observer 看不见 → chip 到达时没有任何 beacon。

**修复**:
- `lib/anno-observer.js`(_version 2): document 级兜底——任何 DOM 变化时:live container ≠ 已绑 container → 重绑;live chip 数 > 上次 beacon 数 → 立即 beacon。事件驱动,无轮询。
- `extension.js`: annoSendSync 读到 0 chips → 有界一次性等"带 chip 的 beacon"(≤1.2s),到了就用 beacon 的 chips;清完后再等 ≤1s 防"清理后才冒出来的迟到 chip",一次有界复查 fresh DOM read → ✕补删。仍读 0 → **dump Copilot DOM 到日志**(用户要求)。
- **开关**(用户要求): dsh 设置卡 代码审查 →「浏览器元素批注发给 dsh」(`annotationToDsh`)。**扩展侧** 0.1.115 新增 `annoFeatureOn()`:在事件时读 `~/.dsh/review/shadow/settings.json`(无轮询),off = 完全静默(不发送同步/不清理/不闪回/无启动清理);**客户端 0.2.5**: `markAnnoSend()` 先查 `vscodeIframeHint()`(Chrome 里的 dsh 永不触发)+ `getReviewSettings().annotationToDsh`,dock chips off 时不渲染;开关文案改为描述现行设计。

- `package.json`: 0.1.114 → 0.1.115(扩展), 0.2.4 → 0.2.5(dsh 客户端);部署完成,旧 0.1.114 已删。

## 闪回 dsh 改防抖:标注不打断,标完自动回(2026-11-01, 扩展 0.1.114)

**症状**: 0.1.113 删掉了每次-beacon 的闪回,导致标注后停在 Copilot 不闪回 dsh。用户澄清要**闪回**(之前"先不回闪回"是打错),但同时"标注不上去"(闪回和标注竞态丢标注)。

**根因**: 每次 beacon 立即 `annoReturnIfIdle()` 隐藏 Copilot widget,标注中途被隐藏→竞态丢标注。0.1.113 全删→不闪回。两个需求矛盾。

**修复**: 改**防抖**——`scheduleReturnToDsh(2500)`:每次 beacon 重置计时器,2.5s 没有新标注才闪回 dsh。连续标注不打断(标注中 widget 保持可见),标完 2.5s 后自动回 dsh。发送(annoSendSync)/删除(realDeleteChip)/启动清理的闪回仍**立即**(用户接受的"闪一下")。

- `extension.js`: 新增 `scheduleReturnToDsh(delayMs)`(防抖计时器 `annoReturnDebounce`);`annoMirrorOnState()` 末尾改调 `scheduleReturnToDsh(2500)`。
- `package.json`: 0.1.113 → 0.1.114;部署 `~/.vscode/extensions/dsn.dsh-review-vscode-0.1.114/`,旧 0.1.113 已删。

## 修"标注不上去":删每次 beacon 的闪回 dsh(2026-11-01, 扩展 0.1.113)

**症状**: "有时候标注不上去"——用户连续标注多个元素时,有时标注丢失。

**根因**: `annoMirrorOnState()` 在**每次 beacon** 都 `annoReturnToDsh=true; annoReturnIfIdle()`,闪回 dsh(隐藏 Copilot widget)。用户标注中途,widget 被隐藏 → 标注竞态丢失。日志证据:一轮内 `return-to-dsh` 出现 17+ 次,每次 beacon 都闪。这个闪回是给**已废弃的 dock**用的(`sendAnnoDock` 定义了但从未被调用,dock 早就不更新了),现在纯有害。

**修复**: 删掉 `annoMirrorOnState()` 末尾的每次-beacon 闪回。chip 状态追踪(`annoCurrentChips`)保留(发送抓取仍需要)。闪回 dsh 现在只在**发送后**(`annoSendSync` finally)、**删除后**(`realDeleteChip` finally)、**启动清理后**发生——即用户接受的"闪一下"。标注过程中 widget 保持可见,可连续标注。

- `extension.js`: `annoMirrorOnState()` 删除 `annoReturnToDsh=true; annoReturnIfIdle()`。
- `package.json`: 0.1.112 → 0.1.113;部署 `~/.vscode/extensions/dsn.dsh-review-vscode-0.1.113/`,旧 0.1.112 已删。

## 发送清空改 ✕ 点删 + 修闪回 dsh(2026-11-01, 扩展 0.1.112)

修用户 e2e 两个 bug:

1. **闪回 dsh 失败**: `annoReturnIfIdle()` 用 `workbench.view.dsh` 切回 dsh,但**这个命令在本 VS Code 版本未注册**(日志反复 `command 'workbench.view.dsh' not found`),导致闪 Copilot 后回不来。改为 `dshState.dshView.show(true)`(reveal=true 激活 dsh 容器+显示视图)作主机制;`workbench.view.dsh` 降为 best-effort 且静默(不再刷屏)。

2. **newChat 清不掉元素标注 chip**: `clearCopilotSession()`(newChat)只重置会话 InputModel,但**元素标注是页面级**(不在会话里),newChat 后 chip 反复重渲染,清不干净,且状态混乱导致用户"标不上去"。改为**逐个 ✕ 点删**(`realDeleteChip` 真正从 Copilot 持久状态删标注+pin),newChat 降为兜底(清残余输入文本+起干净会话)。发送清空(②)与启动清理都改为此路径。

- `extension.js`: `annoReturnIfIdle()`(show(true) 主机制)、`annoSendSync()` ②清空(✕ 点删主 + newChat 兜底)、`annoMirrorOnState()` 启动清理(✕ 点删主 + newChat 兜底)。
- `package.json`: 0.1.111 → 0.1.112;部署目录 `~/.vscode/extensions/dsn.dsh-review-vscode-0.1.112/`,旧 0.1.111 目录已删。

## 手动清空 dsh 输入框不再误闪 Copilot(2026-11-01, dsh-review 0.2.4)

**症状**: 手动清空 dsh 输入框(Cmd+A 删除)也会闪 Copilot(发送消费被误触发)。

**根因**: 客户端旧触发器是"dsh draft 从非空→变空",这个条件在**发送**和**手动清空**时都成立,所以两者都触发 `dshAnnoConsumed`。

**修复**: 把触发器改成"真发送"——Enter(非 Shift、非输入法)在 composer 内,或 composer 发送按钮(`[data-composer-card] button[class*="primary"]`)点击。手动清空不碰 Enter 也不点按钮,不再触发。选择器与 dsh-annotate 的 `composerPrimary()`/`onComposerEnter()` 完全一致(经 EXA 验证的官方发送钩子路径)。

- `client.js`: 新增 `markAnnoSend()` + `installAnnoSendDetection()`(document 捕获阶段监听 Enter/发送按钮,200ms 去抖);删除旧的"draft 非空→空" `prevDraftRef` 效应。
- `package.json`: 0.2.3 → 0.2.4。

## dock chip 真删 + 侧栏刷新自动同步(2026-11-01, 扩展 0.1.111)

修用户 e2e 三问题,根因同一个:Copilot 聊天组件是**瞬态**的——用户在 dsh 侧栏时 `.chat-attachments-container` 不在 DOM 里,CDP `deleteChip` 返回 `no-container`,dock ✕ 与发送消费全失效。

- `lib/anno-cdp.js`: `AnnoDriver.eval(expr)` — 在 workbench 页求值并返回值。
- `extension.js`:
  - `flashCopilot()` — 依次尝试 `workbench.action.chat.open` / `workbench.view.sessions.chat` / `workbench.action.chat.openNewSessionSidebar.copilotcli`,把 Copilot 面板"闪"出来(用户接受的"闪一下")。
  - `copilotWidgetRendered()` — CDP 查容器是否在 DOM。
  - `annoResync()` — 侧栏 (re)load 时:容器在→直接 `getState()` 拉状态;不在→闪 Copilot,observer 重新 arm 时自动 beacon。两种路径都先清 `annoMirrored`/`annoInitialRecorded`,让 chip 全量重插(dock + 输入框内联),刷新后发送/消费链路完整。
  - `realDeleteChip(name, attempt, flashed)` — 首次 `no-container` 时先 `flashCopilot()` 再重试(有界 5×500ms,不轮询)。dock ✕ 与发送消费共用此路径。
  - 接线: `dshState.logChannel` / `annoResync` / `annoHasChips`。
  - **闪完自动跳回 dsh**: `annoReturnToDsh` 标志——闪 Copilot 时置位;state beacon 在 `annoMirrorOnState` 末尾消费它,调 `dshView.show(false)`(稳定 API)切回 dsh 视图。旧代码用的 `dshReview.dshWebview.focus` 命令从未注册,是静默 no-op,所以闪完不回来。
- `lib/dsh-browser.js`: `dshBridgeHello` 末尾——若 `annoHasChips()`(刷新而非干净启动)则 `annoResync()`。这就是"cmd+r 默认闪一下 copilot"。

### 0.1.111 修订:删除竞态 + Copilot→dsh 同步(同日)

用户 e2e 反馈两问题,日志定位根因:

1. **删除竞态(延迟大、时灵时不灵)**:旧逻辑在"组件出现"beacon 上就 `dshView.show()` 跳回 dsh,把刚渲染的 Copilot 组件**销毁**,导致后续 CDP 点击全部 `no-container`。修复:`annoDeletesInFlight` 计数门控返回——删除进行中(计数>0)不跳回;CDP 点击成功后先 `annoPullState()`(拉取新状态,同步 dock+内联)再跳回。闪烁后加 `waitForWidgetRendered(2500)` 有界等待组件真正渲染(事件触发、非轮询),再点删。
2. **Copilot 侧删 chip 后 dsh 残留**:新增 `annoFocusResync()`——用户在 dsh 侧栏活动(`dshViewActive`,上游 3s 节流)时重发当前 dock 状态(客户端同态 no-op)+ 组件在渲染时 `annoPullState()` 重同步。`lib/dsh-browser.js` 的 `dshViewActive` handler 调用它。

## 元素批注功能 — 整删,重新做(2026-11-01, dsh-review 0.2.1 / 扩展 0.1.108)

同日新增: dsh 插件面板「代码审查」卡加「浏览器元素批注发给 dsh」开关(`annotationToDsh`, 默认开)——开=批注走 dsh(新流程), 关=保持 VS Code 原生 Copilot 逻辑。设置走现有 settings 持久化, 扩展端可读 `~/.dsh/review/shadow/settings.json`。

用户决定:浏览器元素批注功能整体删除、重新实现。目标流程(用户复述确认):
原生 ⌥⌘C 标注 → 确认即自动在 dsh 输入框**光标处**出现 chip(一个标注一个 chip,不点发送)
→ 图钉**留在页面** → chip⇄图钉**双向删除同步**(删 chip 删图钉、删图钉删 chip)。
旧实现(0.1.49 起)是"抄送后立刻删图钉"的单向形态,与目标不符,故整删。

**删除的内容**:
- 整文件: `lib/browser-comment.js`、`lib/element-context-watcher.js`、`lib/element-bridge.js`、`lib/cdp-element-source.js`、`lib/native-comment-server.js`、`tools/patch_comment_hook.py`(tools/ 目录随之移除)
- `extension.js`: startElementContextWatcher / startNativeComment / startCdpProbe / startBrowserComment 全部接线
- `lib/dsh-browser.js`: bridge 引用、openGuard、focusComposerPending/pendingChipRemovals、`dshReview.removeDshChip` / `dshReview.focusDshComposer` 命令、dshDropReference / dshRemoveReferenceAck / dshRefsTracked 消息处理
- `package.json`: elementContext.* + browserComment.* 共 15 个设置、11 个命令及 8 个 commandPalette 项、`ws` 依赖
- `install.sh`: merge_cdp_port(remote-debugging-port=9223 写入 argv.json 的部分)

**保留不动**: 行内审查(流程1 全部)、dsh 侧栏 + auth proxy、代码/文件/终端→dsh、后台任务终端、dsh-review 插件宿主侧(index.js/shadow.js/pending.js/jobs.js)、`dsh-review/client.js` 里 inert 的 chip 删除绑定代码(trackInsertedRefs/sweepDroppedRefs,无扩展端 handler 后不触发,新实现会重新接上)、argv.json 的 editorInsets 部分。
备份分支: `backup/pre-annotation-redo-20261101`(删除前 main = ad8afbf 的完整快照)。

**安装侧残留清理(同日)**: `~/.vscode/extensions/dsn.dsh-review-vscode-0.1.107/`(删除 5 个旧批注 lib + 同步 extension.js / dsh-browser.js / package.json)、`~/.vscode/argv.json` 与 `~/Library/Application Support/Code/argv.json` 的 `"remote-debugging-port": "9223"`(已留 `.bak-pre-annotation-redo`)、`/tmp/dsh-comments/` 旧批注 md。需 Cmd+Q 重启 VS Code 后旧链路才完全失效;运行中会话里 dsh 输入框的旧批注 chip 与页面图钉需手动点删。

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


## dsh-review 0.1.71 + dsh-review-vscode 0.1.57 (2026-10-23) — 双向绑定：dsh 里删方块 → Copilot 那行删掉 → 页面图钉消失

### 前提（用户实测出来的）
用户在 Copilot 里点 `✕ span#mv-temp` 删掉引用 → 页面上 ① 号图钉跟着消失（两张截图对比）。后来把 `dshReview.elementContext.nativeClearCopilot` 打开，插件删那行 `@元素 文字` 也同样把图钉撤掉 ⇒ **改输入框文档就能控制图钉**，不用碰 VS Code 本体。

### 四处改动
1. `dsh-review/client.js`（dsh 侧客户端补丁）：插 chip 成功后用 `trackInsertedRefs(list)` 记住每条（key = 唯一 md 文件名，例如 `comment-20261023-122301-mv-temp-jqw6.md`），`sweepDroppedRefs()` 每 900ms + MutationObserver 触发，在 composer 子树（contenteditable 往上三层）里找这个名字；**名字没了而输入框还有内容** = 用户删了方块 ⇒ `postMessage({type:"dshDropReference", path, name})`。输入框整体清空视为「已发送」不当删除（这是已知边界，写在代码注释里）。
2. `element-bridge.js`：`setReferenceDroppedHandler / referenceDropped` 单向路由（文档归 watcher 管）。
3. `dsh-browser.js`：webview 收到 `dshDropReference` → `bridge.referenceDropped(msg)`，日志 `[ref-drop] comment-….md -> 已同步删 Copilot 那行（图钉应随之消失）`。
4. `element-context-watcher.js`：`dropCopilotLineForMd(file)` 读那篇 md（它是方块与 Copilot 行之间唯一持久的联系）：首行 `# 元素批注 — <label>` + `## 批注` 段取文字；Copilot 存的是 `@span#mv-temp 111` 而我们记录的是 `span#mv-temp.st-metric__label 366 × 20`，**只按 tag + id 匹配、并优先正文完全相同的那行**；用 `WorkspaceEdit` 删掉整行（含换行）。开关 `dshReview.elementContext.bindDshRemoval`（默认开）。

### 离线验证
md 解析 + 选行逻辑单独跑：`label → {tag:span, id:mv-temp, comment:按摄氏度显示}`，四条候选里精确选中 `@span#mv-temp 按摄氏度显示`；换成没有该元素的输入框时正确地「一行都不选」（不会误删别的批注）。

## dsh-review 0.1.71–0.1.73 + dsh-review-vscode 0.1.70–0.1.73 (2026-10-23) — 双向绑定实测做不到，用户定版：只保留单向抄送

### 实测边界（三轮 CDP 扫描 + 用户手工验证，不是猜测）
- Copilot 顶部那个**元素附件（带 ×）**不在任何可连目标里：workbench 页面（850 节点）里 `chat-attached-context` 命中 **0**，dsh 网页 iframe **0**，浏览器页面只有它自己的 `.attachments` ⇒ 在 agent host 的 renderer 里，外部点不到。
- 用户手工验证：**删掉那行文字，图钉不掉**；**点掉附件 ×，图钉才掉** ⇒ 「dsh 删方块 → 撤图钉」必须点到那个 ×，做不到（除非改 VS Code 本体）。
- 反方向「点图钉删除 → dsh 方块消失」代码链路是通的（日志闭环：`Copilot 那行没了 -> 请求删 dsh 方块 …` → `捎带删方块 … -> 已删`），但方块匹配反复出问题：dsh 把 chip 标签做**中间截断**（`comment-20261023-13…-xd4m.md`），完整文件名永远匹配不上；0.1.88 改成按尾部 token（`span-xd4m.md`）认，仍未由用户复测确认。
- 期间真实修掉的 bug（都有日志证据）：首快照吞掉实时批注（0.1.70 用「磁盘上有没有 md」判定新旧，不再吞）、扫描读错输入框文档（0.1.71 改用事件带来的那篇）、客户端登记早于 dsh 渲染导致**误判删除把图钉吃掉**（0.1.86 宽限 1.5s + 必须先见过节点）、`composerScope()` 找不到 contenteditable 导致整套绑定静默罢工（0.1.81 退回全文档）、插件客户端因 webview 缓存长期是旧版（0.1.63 代理 no-store + 报名号，最终确认加载正确）。

### 用户决定
「不同步，只保留单向抄送」⇒ `dshReview.elementContext.bindDshRemoval` 默认改为 **false**（代码留着，想试再开）。最终形态：`⌥⌘C` 批注 → dsh 一个文件方块（含 URL、尺寸、CSS 定位、祖先链、元素文本、outerHTML、21 项计算样式），不自动发送；页面图钉与 Copilot 附件保持原生行为，删除各自手动。

## dsh-review 0.1.89–0.1.99 + dsh-review-vscode 0.1.70–0.1.104 (2026-10-23) — 找到图钉的真身，撤图钉打通；顺带清掉全部轮询

### 图钉到底在哪（源码级 + 实测，推翻我此前两次结论）
- 画图钉的是 `out/vs/platform/browserView/electron-browser/preload-browserView.js`（49KB，注入进被标注页面）：`div[data-vscode-pick-host]` + **`attachShadow({mode:"closed"})`**，里面有 `.comment-layer` / `.comment-pin`(+`.comment-pin-number`) / `.comment-preview-remove`。
- 封闭 root ⇒ 页面 JS 和 `el.shadowRoot` 都看不到，CDP `Runtime.evaluate` 也看不到；但 **CDP 的 DOM 域能穿透**：`DOM.getFlattenedDocument(pierce:true)` 能列出 `.comment-pin`，`DOM.getBoxModel` 给坐标。
- 每个图钉**自带批注文字**：`title="<批注>"`、`aria-label="Element comment N: <批注>"` ⇒ 数量和每条内容都是实测，不再按顺序猜。
- 删除必须**真实输入**：`dispatchEvent(MouseEvent)` 会被忽略（我实测「clicked」但图钉还在）；`Input.dispatchMouseEvent` mouseMoved/Pressed/Released 打盒子中心才生效（自测：1 个图钉 → 点 `.comment-preview-remove` → 0 个 ✅）。

### 这一轮真修掉的 bug（都有日志证据）
1. `removeNativePinForFile` 曾被贴进投递闭包里 ⇒ 删除处理器调不到，`撤图钉` 一次都没执行（0.1.91 移出）。
2. 0×0 隐藏元素 VS Code 不画图钉，但我们照样建方块 ⇒ 「数量对不上」；现在探测到 0×0 就跳过（0.1.91）。
3. 客户端只登记「本轮插入」的方块 ⇒ 用户删老方块毫无反应；改成按结构登记全部：`button[data-ref-chip="file"][title="@路径"]`（0.1.92）。
4. 判定「方块还在不在」时兜底到 `document.body` ⇒ 已发送消息里的同款方块让它永远「还在」，退格删除永远看不见（0.1.96 限定在 `[contenteditable]`/`[class*="_input"]`，实测 `uV2eYG_input`）。
5. 输入框清空旧规则当成「发送不算删除」⇒ 你退格删干净后什么都不发生（0.1.97 反过来又误伤发送 ⇒ 0.1.99 用「文字是否出现在已发送消息里」区分发送与删除）。
6. 同名批注按「包含即命中」删错图钉 ⇒ 改成完全相等 + 按图钉自带编号取第 N 个（0.1.93）；多行批注被 VS Code 压平换行导致「没找到对应图钉」⇒ 两边都折叠空白再比（0.1.104）。
7. 一次批注冒出 8 条：Copilot 启动时把旧引用塞回输入框，被当成新 delta；先试「按文字防重」（元素标签会退化成 `@div`，不可靠）→ 最终改为启动 2.5 秒内清理一次输入框（0.1.97/0.1.98/0.1.100），并且**绝不在文档后开时清理**（那会吃掉用户刚写的批注 + 抢焦点）。
8. **轮询回归**：把 2.5s 重扫改成 `Target.setDiscoverTargets` 事件后发现——页面**重载不产生 target 事件**，第一次断连就永久失联（`页面没连上`、`元素详情没拿到`）。补：socket `close` 即重扫 + 每次新建执行上下文重新注入探针 + 撤图钉时按需补扫（0.1.101/0.1.102）。
9. 焦点被抢进 Copilot 的三个来源（编辑 Copilot 文档 / 关闭批注预览 / 启动清理），前两个补 200/700/1400ms 抢回，第三个限制在启动瞬间（0.1.94/0.1.103/0.1.100）。

### 轮询清零（用户的硬要求）
删除了：客户端 800ms 工作区轮询（改扩展主动推 `dshSetScope`）、扩展 2.5s CDP 目标重扫（改 target 事件 + socket close 重扫）、元素源 socket 5s 重连（改 close 事件）、方块判定 500ms 节流（80ms 防重入）。插件里只剩原有的 `dshBridgeHello` 握手 500ms，12 次后自动停。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.54 (2026-10-23) — 命令面板清理：24 条英文测试命令 → 7 条中文 + 上下文/隐藏

### 用户诉求
「vscode的Command好乱, 你清理干净, 然后tree列出有哪些, 分别控制什么的」

### 做法（只动 title / category / 面板可见性，**一个 command id 都没删**）
所以已有的快捷键、`tasks.json`、`settings.json` 引用全部继续有效。断言 `dropped ids` 还真抓到过我漏了 `dshReview.stopDsh`（第一次跑直接中止，什么都没写）。
- 全部加 `category: "dsh"`，标题去掉重复的 `dsh:` 前缀，改成中文短句。
- 面板可见 7 条：打开/切换 dsh 侧栏、重启 dsh、重启 dsh（走代理）、停止 dsh、停止 dsh 后台任务、元素批注：看页面连接状态、排障：列出当前打开的文档。
- 上下文 3 条（沿用原来的 when）：把选中的代码发给 dsh（有选区）、把终端选中的内容发给 dsh（终端有选中）、插入文件到 dsh 输入框（资源管理器聚焦）。
- 隐藏（`"when": "false"`，命令仍在，可从快捷键/JSON 调）：全部接受、全部撤回、重载 dsh 侧栏、重启 dsh（bili 环境）、探针自检、元素监听心跳、元素存储探测、CDP 元素 chip 快照、CDP 连通性、四个「自动关闭测试」。
- `dshReview.dumpDocs` 之前在 `contributes.commands` 里**注册了两次**（两个不同标题），合并成一条。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.51–0.1.52 (2026-10-23) — 重复文字的批注不再被吞；SVG 元素标签不再显示 [object

### 0.1.51 去重写错了（用户实测抓到）
`chat 快照 refs=14 delta=0` ⇒ 不送 dsh。用户这次打的文字是「测试」，而输入框里已有两条 `@span 测试`（早先测试留下的），我按「这个 label+文字 出现过没有」去重 ⇒ 新引用被判成旧的。改成**按出现次数**：基线是 `Map<key, 次数>`，某条引用的第 n 次出现 > 旧快照的次数 才算新（同一次扫描里还要加上已投递的份数）。离线重放三个场景：新元素重复文字 → delta 1；再来一条完全相同 → 1；没有改动 → 0。旧的 `seenNative` 集合删除。
用户复测（0.1.51）：两条批注都进 dsh，且 `元素详情已补齐 label=span#mv-speed.st-metric__value 106 × 20 html=75 css=21 anc=6` ⇒ 原生 ⌥⌘C → dsh 方块 + 全套元素细节成立。

### 0.1.52 显示错
第二条 label 是 SVG 里的 `path`，日志成了 `path.[object 377 × 28`：SVG 的 `className` 是 `SVGAnimatedString` 对象，`String(el.className)` = `[object SVGAnimatedString]`。页内脚本加 `clsOf(el)`（优先 `getAttribute('class')`），labelFor / selectorFor / classes / ancestors 全部走它。新增 jsdom 检查 4/4：SVG path 的 label 无 `[object`、classes 取到 `st-arc`/`fill`、祖先链干净、HTML 元素不受影响。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.49 (2026-10-23) — 删掉右下角 `dsh ✎` 整条路；页内只留「元素探针」，原生批注的 md 补全 HTML/CSS/尺寸/祖先链

### 用户决定
「要, 要全! 然后把右下角的 dsh ✎ 的相关功能删除, 那条路已经完全没有意义了」——原生 ⌥⌘C 已经能进 dsh（0.1.48 实测），自建浮层就是重复品。

### 改动
- `lib/browser-comment.js` **整文件重写**（712 → 约 300 行）：页内不再有按钮 / pick 模式 / 就地输入框 / 图钉 / 卡片，只注入 `window.__dshProbe = { version, ping, lookup(query) }`。`lookup` 支持三种找法：CSS 选择器 → 标签首段（`@span#x 文字` 里的 `span#x`）→ 全页按 `tag#id.cls W × H` 文案比对（上限 4000 节点）。返回 `{ok,label,tag,id,classes,attributes,ancestors,selector,innerText||textContent,outerHTML(≤4000+截断标记),bounds,computed(21 项计算样式),url,title}`。扩展侧 `probeElement(url, query)` 走 `Runtime.evaluate` 的 RPC（id 从 401 起，`pending` 表回收，3s 超时返回 null），并保留 `dsh: 元素批注状态` / `dsh: 元素批注自检`（后者现在探 `body`）。
- `element-bridge.js`：新增 `setElementProbe / probeElement`（单向桥，同 pageUrlProvider 套路，无循环依赖）。
- `element-context-watcher.js`：`scanNativeComments` 送出前先 `await bridge.probeElement(url, label)` 把 bits 合进 payload（label 用页内实算的），日志 `· 元素详情已补齐 label=… html=… css=… anc=…`，拿不到就记 `· 元素详情没拿到（探针没连上或元素已经变了）`；`commentMarkdown` 多一行 `- 计算样式: color=…; font-size=…`。
- 设置文案：`dshReview.browserComment.sendToDsh` 现在描述的是「连接页面做元素详情」，不再是自建浮层。

### 验证
- 页内脚本 jsdom 探针 **16/16**（安装/幂等/ping、按 `#id`、按标签文案、裸 `span`、缺失返回 ok:false、bounds 实测 366×20、标签格式 `span#mv-temp.st-metric__label 366 × 20`、祖先链/类名/文本、计算样式 ≥10 项、url+title、5000 字符 outerHTML 截断、**页面里没有遗留 UI 节点**）。
- 已安装 0.1.49 的文件管道 **8/8**（命名含 nid、update 只改同一文件、未知 nid 被拒、delete 删文件、日志三态）。
- 「详情补齐」这段只在 composer 真实路径上跑（本测试直接调 deliver 不经过它），判据在日志里：批一条后应出现 `· 元素详情已补齐 …`，md 里应能看到 `- 尺寸:` / `- 计算样式:` / ```html 块。

## dsh-review 0.1.71 + dsh-review-vscode 0.1.47–0.1.48 (2026-10-23) — 原生 ⌥⌘C 批注正式进 dsh（用户实测通过）

### 决定性证据（用户贴的日志）
```
· 输入框内容[chatSessionInput:input-0] = @span#mv-gpu 1321312 ⏎ @span#ms-gpu 312312 ⏎ @span 测试 ⏎ …
· chat 输入框基线：10 条旧引用（不送 dsh）
· 原生批注 -> dsh label=span#ms-gpu chars=6 (输入框变更)
[element-context] [comment] wrote /tmp/dsh-comments/comment-20261023-112028-ms-gpu-aj6g.md -> dsh ok=true kind=file chars=6
insert mode=chip count=1 source=selection
```
⇒ 原生评论在 `chatSessionInput` 文档里就是**一行一条 `@元素 文字`**，我的正则形状猜对；0.1.47 之所以成，是因为把扫描从 800ms 日志节流后面挪到前面（之前那次变更事件被节流吞了，看起来像「没匹配到」）。用户确认：dsh 输入框出现了，且不开文件、不弹保存、没给 VS Code 打补丁。

### 0.1.48 补掉最后一个缺口
md 里 `- URL:` 之前为空（不再打开元素文档就没人给 URL）。`element-bridge` 增加 `setPageUrlProvider / browserPageUrl`，`browser-comment` 用已 attach 的 CDP 页面注册提供者，watcher 取 `lastElementUrl || bridge.browserPageUrl()` ⇒ 原生批注的 md 也带页面地址，且不需要开任何文档。

### 已知行为（不是 bug，写清楚）
- 首次快照（含 Copilot 里留下的旧引用）只登记基线，不送 dsh；一次变更冒出 >3 条新引用按「会话恢复」处理，只更新基线。
- 用户自己在 Copilot 里手打 `@xx 文字` 也会被当成一条批注抄进 dsh（同 key 去重）。
- 批注文字事后在 Copilot 里改动 = 新 key ⇒ 会再抄一条。

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
