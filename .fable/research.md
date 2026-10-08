# 社区检索 — dsh jobs → VSCode 只读终端(SSE + tee + 按 id 直杀)

方法:exa 网络搜索共 **13 次 / 12 组查询词**(主题④⑤各 2-3 组关键词),以下为按 5 主题分节的查询词、来源与结论。对实现有指导意义的要点在各节末尾标注。

---

## 主题① VSCode Pseudoterminal 只读终端 / Copilot 风格终端

**查询 1**:`vscode extension Pseudoterminal read-only terminal createTerminal pty handleInput empty implementation`
- https://github.com/microsoft/vscode-extension-samples/blob/main/extension-terminal-sample/src/extension.ts — 官方终端样本:Pseudoterminal 只有 `onDidWrite/open/close/handleInput` 四个成员,`handleInput` 做 echo。**结论:把 handleInput 写成空实现(或不提供)即得到只读终端,无额外 API 需求。**

**查询 2**:`vscode extension createTerminal Pseudoterminal example stream output into terminal tab like Copilot coding agent terminal`
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostTerminalService.ts — VSCode 源码确认:`ExtHostPseudoterminal.input()` 调 `this._pty.handleInput?.(data)`(可选链,handleInput 可省略);ext host 侧已有 `_bufferer.startBuffering(id, p.onProcessData)` 把数据事件缓冲后批量发 renderer。**结论:只读 pty 合法且是标准形态;ext host→renderer 的 IPC 已自带批量,扩展侧不必为 IPC 节流。**
- https://github.com/microsoft/vscode/issues/108298 — `open()` 之前 fire 的写会被丢弃,官方确认"by design: only write after open is called"。**结论:终端先 show、等 `open()` 回调后再写;job 启动帧早于 open 的输出要缓存到 open 再 flush。**
- https://github.com/vinhnx/vtcode/blob/d2c579d3/vscode-extension/src/agentTerminal.ts — 社区 agent 终端管理器:`createTerminal({name, iconPath, pty})` + 按 id 维护 Map(id→terminal)、`show(true)` 复用已存在标签。**结论:与我们的"按 jobId 开/复用终端标签"模式一致,可直接参照其 id→terminal 映射写法。**

**查询 3**:`vscode Pseudoterminal close called when user closes terminal tab onDidCloseTerminal event`(kill 路径)
- https://github.com/microsoft/vscode/blob/master/extensions/vscode-api-tests/src/singlefolder-tests/terminal.test.ts — 官方 API 测试:pty 终端 `dispose()`/关闭 → `onDidCloseTerminal` 触发;`close: () => {}` 是标配空实现。**结论:用户关标签会走到 `pty.close()`(API 文档:handle when the terminal is closed by an act of the user),用它作 kill 触发点成立。**
- https://github.com/microsoft/vscode/issues/130231 — 用户明确杀终端、关窗口都会调 `close()`,无 API 区分两者;官方建议按场景自行判断。**结论:关窗口也会触发 close() → kill 请求需幂等(jobs.kill 对已终态 job 返回 already-finished 即可)。**
- https://github.com/microsoft/vscode/issues/206735 — `onDidCloseTerminal` 在"把终端移到独立 pane 再关"等边界下可能不触发。**结论:kill 触发以 `pty.close()` 为主、`onDidCloseTerminal` 为备,双保险。**

**查询 4**:`Copilot VS Code agent terminal tab read-only output display "terminal"`
- https://github.com/microsoft/vscode-copilot-release/issues/12060 — Copilot 后台命令的终端创建日志:`isExtensionOwnedTerminal:true, name:"Copilot", hideFromUser:true`。**结论:Copilot 走的就是公开 `createTerminal` 扩展自有终端,不存在专用/私有终端接口;我们走同一 API 即"Copilot 同款"。**
- https://github.com/microsoft/vscode/pull/327067 — VSCode 内部:Copilot 把 shell 工具输出流进"output-only 终端通道"(只读输出源、detached xterm、不做面板终端)。**结论:确认"只读输出通道"是 VSCode 对 agent 输出的标准形态;面板标签用扩展自有 pty 终端是等价最小实现。**

**要点**:只读 = handleInput 省略/空;open() 后才写;id→terminal Map 复用标签;kill 用 pty.close() 且幂等。

---

## 主题② VSCode 扩展宿主消费 SSE(node:http vs fetch)

**查询 1**:`vscode extension host consume server-sent events SSE stream node http vs fetch EventSource not available`
- https://www.server-sent-events.com/frontend-consumption-client-patterns/fetch-based-sse-clients/ — 业界标准指南:EventSource 限制多(仅 GET、无自定义头、重连策略固定)→ 需要 auth 头/自定义退避时用 fetch 读流自解析。**结论:扩展宿主无 DOM EventSource,通行做法是 fetch/node:http 拿流 + 手工增量解析;必须用流式 UTF-8 解码(TextDecoder stream:true,防跨块切多字节字符)、按 CRLF/CR/LF 分行、空行派发事件、用索引增量解析(避免每块重新 split 造成 O(n²))。**
- https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/util/vs/base/common/sseParser.ts — Copilot 扩展自己就内嵌了一个 sseParser。**结论:扩展宿主内手搓 SSE 解析是 VSCode 生态既有实践,不是异类。**

**查询 2**:`SSE client node.js parse event stream incremental parser text/event-stream reconnection backoff`
- https://github.com/azure/fetch-event-source — @microsoft/fetch-event-source(fetch 系 SSE 客户端代表)。**结论:标准形态 = onopen 里校验状态码+content-type、onerror 决定重试/终止、AbortController 取消;我们自研 ~50 行即可对齐。**
- https://github.com/rexxars/eventsource-parser — 规范级流式解析器,`feed(chunk)` 增量喂、支持 onRetry、`maxBufferSize` 防无限缓冲。**结论:若不想手写解析,这是最薄的依赖(纯解析,无网络层);服务端 pump 与客户端共用同一套行/块语义。**
- https://github.com/sse-js/client-kit/blob/main/README.md — 基于 node:http 的零依赖 EventSource 实现(含 async generator 消费)。**结论:node:http 路线同样有现成参考,与"扩展宿主用 node:http 直连 127.0.0.1"最贴。**
- https://github.com/rexxars/eventsource-client — 现代 SSE 客户端(可配置重连策略、任意方法/头、async iterator)。**结论:重连策略可配置是其核心卖点;我们只需指数退避+上限,不必引库。**

**要点**:退避策略取社区共识值——健康连接即重置延迟、指数翻倍、加 30% 抖动、上限 30s(如 1s→2s→4s…→30s);onopen 校验 `content-type: text/event-stream`;解析用流式 TextDecoder + 增量行缓冲;单连接 AbortController 随扩展 deactivate 取消。

---

## 主题③ 流 tee + 环形缓冲(单消费游标旁路)

**查询 1**:`tee stream single consumer cursor bypass tap ring buffer keep tail drop old`
- https://github.com/vercel/ai/issues/16753 — 生产事故级结论:`ReadableStream.tee()` 对慢分支**无限缓冲**,96MiB 流直接 OOM,社区方案是加 single-consumer 旁路跳过 tee。**结论:不要用 tee();在"唯一真实读取点"(jobs.read)旁做有界拷贝,才是单游标流的正确 tee。**
- https://github.com/SlickQuant/slick-stream-buffer — SPMC 环形字节流:每个消费者独立单调游标、生产端永不阻塞、慢消费者被追上即丢旧(lossy overwrite)。**结论:与我们方案同语义——主消费者走真实游标,旁路读者取"缓冲尾部",满了丢旧不阻塞,是我们 hook 设计的直接对照。**
- https://discourse.gstreamer.org/t/how-to-prevent-one-branch-of-a-tee-from-blocking-the-other-branches/1369 — tee 的一个分支阻塞会拖死其他分支;标准解法 = leaky/drop-oldest 队列。**结论:旁路分支必须 drop-oldest,绝不能反向施压到主消费路径(agent 的 job_output 读取)。**
- https://github.com/google-ai-edge/LiteRT-LM/commit/def6b5ce1f0a05908c59a481124b1f91ee64a7cf — 自研 teeStream:每分支一个有界 RingBuffer + 背压(慢分支满则阻塞生产者)。**结论:这是"阻塞式 tee"对照样本;我们明确选非阻塞(旁路丢旧),因为 agent 读取路径不能被打断。**

**查询 2**:`javascript ring buffer implementation circular buffer keep newest discard oldest bounded buffer`
- https://github.com/isel-jao/ts-lib/blob/main/src/ring-buffer/README.md — 最小 TS 环形缓冲:预分配数组、head/tail/size 三变量、满时 push 覆盖最旧并**返回被驱逐元素**(可观测丢数据)、O(1) 无二次分配。**结论:~40 行实现即可满足"丢旧保尾";push 返回驱逐项便于计数 dropped。**
- https://stackoverflow.com/questions/1583123/circular-buffer-in-javascript — 经典 10 行 JS 环形缓冲(pointer + 定长数组,push 覆盖最旧)。**结论:最小实现参照,无需引依赖。**

**要点**:环形缓冲按 jobId 各一个,容量取"尾部窗口"(如 256KB 或 4000 行);tee = 原 read 透传 + delta 拷贝入环(满则丢旧、计数);400ms pump 抽干环发 SSE;主路径永不阻塞、不缓存额外全文(内存上界=环容量×活跃 job 数)。

---

## 主题④ dsh/cordis 插件挂 HTTP/SSE 路由的社区先例

**查询 1**:`deepseek dsh plugin webServer register HTTP SSE route agent`
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md — 官方文档:WebRoute.handler "Owns the full response lifecycle (**may hold the response open, e.g. SSE**)";匹配序 exact→最长 prefix→fallback;重复 (kind,path) 注册抛错。**结论:SSE 长连接是 webServer 的一等设计用途,`/dsh-review/*` 精确路由与 `/api` typert 路由可共存。**
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md(及 dsh.pub 插件页)— 同上的包级 README;另注意 disposal 用 `close()+closeAllConnections()`,因 SSE 连接不会自行结束。**结论:插件卸载/重启时 SSE 连接会被强断 → 客户端必须能重连(与主题②退避配合)。**
- https://github.com/EdgeTypE/dsh-better-deepseek — **直接先例**:dsh 插件在 `ctx.webServer` 注册 `/api/better-deepseek/*`,含 `GET /events`(SSE 实时流)+ POST session 端点 + ping。**结论:与我们的 `/dsh-review/events`(SSE)+ `/dsh-review/jobs`(GET/POST kill)同构,证明该形态在 dsh 生态可行。**
- https://github.com/litestartup-com/dsh-api-gateway — **直接先例**:dsh 插件把 harness 变 HTTP API,9 个端点、token 级 SSE 流(turn_end 关流)、`sseHeartbeatMs: 30000` 心跳、并发 session 上限。**结论:SSE 心跳(30s)防代理/空闲断连是 dsh 插件的通行做法,我们应在 /dsh-review/events 加注释心跳帧(如 `:hb` 每 15-30s)。**

**查询 2**:`claude code / codex / agent CLI expose background task output over local HTTP SSE endpoint extension`
- https://github.com/madebydia/pokeclaw — 社区方案:MCP(SSE 传输)控制 Codex/Claude 会话,每会话 **10000 行环形缓冲** + offset 分页读输出、SSE 连接数上限 + 空闲驱逐、kill = SIGTERM→5s→SIGKILL。**结论:与我们的"job 输出环形缓冲 + 按 id 直杀"模式逐项同构,容量/驱逐/kill 语义可直接对标。**
- https://github.com/wjcjttl/cli2agent — 把 agent CLI 包成 HTTP+SSE:task_start/tool_use/task_complete 事件帧;cancel = SIGTERM→SIGKILL(5s)。**结论:"任务事件帧 + 输出帧 + kill 端点"三件套是社区标准拆分,与 HOOK CONTRACT 一致。**
- https://github.com/mberg/agent-http — HTTP API + `GET /events` SSE 广播(message/status 帧)。**结论:命名事件 `event:` 帧(而非全 message)是通行做法,我们的 `job`/`output` 具名帧无兼容问题。**

**要点**:dsh 插件挂 SSE 有同生态先例(better-deepseek、api-gateway);加 15-30s 心跳帧;客户端处理"服务端重启导致 SSE 被 closeAllConnections 强断"的重连;kill 端点幂等。

---

## 主题⑤ Pseudoterminal 大输出性能(写入背压/节流)

**查询 1**:`vscode Pseudoterminal onDidWrite performance large output high frequency write throttle terminal slow`
- https://github.com/microsoft/vscode/issues/266048 — 大量输出事件(5 万条)导致 VSCode UI 长时间挂起,官方方向 = 输出相关更新要 batch/debounce。**结论:高频小写是 UI 卡顿主因;按 pump 周期(400ms)聚合后一次 fire 是正确节流粒度,而不是每收到一个 SSE 块就写。**
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalProcess.ts — VSCode 自身对 pty 大写入的处理:`WriteMaxChunkSize = 50` 字符 + `WriteInterval = 5ms` 定时队列,防大块写导致损坏/卡死。**结论:扩展侧写入应"定时批"(5-12ms 一拍)而非逐块;我们 400ms pump 天然满足。**
- https://github.com/microsoft/vscode/issues/48513(及 PR #82189)— ext host 对终端数据事件已做缓冲合并,减少发往 renderer 的消息数。**结论:IPC 层已有人管,扩展只需控制单次 fire 的总字节量。**

**查询 2**:`xterm.js performance large paste high volume output write batching terminal extension`
- https://github.com/xtermjs/xterm.js/blob/main/src/common/input/WriteBuffer.ts — xterm 写入核心参数:`WRITE_TIMEOUT_MS = 12`(每批最多处理 12ms,`setTimeout 0` 让渲染追赶)、`DISCARD_WATERMARK = 50MB`(超出直接抛错丢数据)、注释直言 **>500KB pending 时 xterm 就开始不可用**。**结论:扩展侧应把"待写 in-flight 字节"压在 500KB 以内;超过即丢最旧(用户只关心尾部),绝不无限排队。**
- https://github.com/xtermjs/xterm.js/issues/2077 — 背压问题专帖:`yes` 级别高速输出 3 分钟 writeBuffer 涨到 GB 级 OOM;需要 watermark + drain,或 drop-oldest。**结论:无背压的直写是 OOM 温床;我们泵出速率(SSE 400ms 批)远低于 `yes`,风险低,但仍加 in-flight 上限兜底。**
- https://github.com/shihuili1218/rssh/blob/main/src/lib/terminal/output-feeder.ts — 具体节流器实现:需求驱动——上一块 write 回调 fired(=已解析)才放下一块;内存上限超了丢最旧整块;空闲时直通零延迟。**结论:若实测卡顿,这是可移植的最小节流器形状;第一版可先只做"400ms 批 + 500KB in-flight 上限 + 丢旧"。**

**要点**:400ms 批写(与 server pump 同频);in-flight(已 fire 未解析)≤500KB,超则丢最旧;open() 前输出缓存、open 后首帧 flush;终态帧写 `[done]` 尾行即可,不做装饰/OSC 633(只读终端无需 shell integration)。

---

## 汇总:对实现有直接指导的 6 条

1. **只读终端**:createTerminal({pty}),handleInput 省略;open() 后才写(①)。
2. **kill**:pty.close() 为主触发 + onDidCloseTerminal 兜底;kill 请求必须幂等,关窗口也会触发 close()(①)。
3. **SSE 客户端**:node:http 直连 127.0.0.1 + 手写增量解析(流式 TextDecoder、空行派发);退避 1s 起、翻倍、30s 上限、健康即重置、带抖动(②)。
4. **tee**:不用 stream.tee();在 jobs.read 旁做"透传 + 拷贝入按 jobId 有界环(满丢旧)";主路径零阻塞(③)。
5. **SSE 服务端**:webServer 原生支持保持响应打开;加 15-30s 心跳帧;卸载时 closeAllConnections 会断连 → 客户端重连(④)。
6. **写入节流**:400ms 一批 pty.write;in-flight ≤500KB,超则丢最旧(⑤)。
