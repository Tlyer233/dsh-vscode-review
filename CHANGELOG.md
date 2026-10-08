# Changelog

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
