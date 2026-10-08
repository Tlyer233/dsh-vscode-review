# Changelog

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
