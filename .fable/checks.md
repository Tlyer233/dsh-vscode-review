## BASELINE
1. `.fable/research.md` 存在且非空 | how: `ls -la .fable/research.md && wc -c .fable/research.md` | pass if: 文件存在且字节数 > 0
2. server 插件 `dsh-review/` 在位(index.js + package.json) | how: `ls dsh-review/index.js dsh-review/package.json` | pass if: 两文件均存在
3. VSCode 扩展 `dsh-review-vscode/` 在位(extension.js + package.json) | how: `ls dsh-review-vscode/extension.js dsh-review-vscode/package.json` | pass if: 两文件均存在
4. `install.sh`(npm pack + dsh plugin add 打包流程)存在 | how: `ls install.sh` | pass if: 存在
5. dsh 核心 checkout 完好且未被动(core 零改动) | how: `ls /Users/xi/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-jobs,dsh-host-webserver,dsh-client-ui-jobs}` 且 `find /Users/xi/.local/lib/node_modules/@deepseek-ai/dsh -newermt "$(date +%Y-%m-%d) 00:00" -type f | head -5` | pass if: 三个核心包目录在位,且当天无 core 文件 mtime 更新(checkout 无 git,mtime 是唯一信号)

## ROUND 1: 社区检索(5 主题 exa 搜索 → .fable/research.md)
1.1 `.fable/research.md` 存在且有真实内容 | how: `ls -la .fable/research.md && wc -c` | pass if: 存在且非空
1.2 含 5 个主题分节 | how: `grep -c '^## 主题' .fable/research.md` | pass if: 计数 = 5
1.3 每个主题分节至少 1 条带来源 URL 的结论 | how: awk 按 `^## 主题` 切段,逐段 `grep -c 'https\?://'` | pass if: 5 段 URL 计数均 ≥ 1
1.4 5 个 TASK 指定主题逐一覆盖:① Pseudoterminal 只读/Copilot 风格终端 ② 扩展宿主消费 SSE ③ 流 tee + 环形缓冲 ④ dsh 插件挂 HTTP/SSE 路由 ⑤ 大输出写入性能 | how: read research.md 分节标题 | pass if: 5 节标题与 5 个指定主题一一对应
1.5 来源 URL 有意义且真实(web_fetch 抽 3 条核对:vscode#108298、vercel/ai#16753、deepseek-harness web-server.md) | how: web_fetch 三条 URL | pass if: 三条均返回与所记结论相符的内容

## ROUND 2: server 插件 jobs 桥(jobs.js 新建 + index.js 接线)
2.1 `dsh-review/jobs.js` 存在且有真实内容 | how: `ls -la dsh-review/jobs.js && wc -c dsh-review/jobs.js` | pass if: 存在且字节 > 0
2.2 `dsh-review/index.js` 存在且有真实内容 | how: `ls -la dsh-review/index.js && wc -c dsh-review/index.js` | pass if: 存在且字节 > 0
2.3 `dsh-review/package.json` 存在、有真实内容且为合法 JSON | how: `node -e "JSON.parse(require('fs').readFileSync('dsh-review/package.json','utf8'))"` | pass if: exit 0
2.4 `node --check dsh-review/jobs.js && node --check dsh-review/index.js` 均 exit 0 | how: 原样运行该命令 | pass if: 无报错、exit 0
2.5 jobs.js 含三路由注册(SSE + 列表 + kill) | how: `grep -n "webServer.register\|/dsh-review/events\|/dsh-review/jobs\|/kill" dsh-review/jobs.js` | pass if: 覆盖 3 路由 — exact `GET /dsh-review/events`、`GET /dsh-review/jobs`、`POST /dsh-review/jobs/<id>/kill`
2.6 jobs.js 含 jobs.read 的 symbol 幂等标志 | how: `grep -n "Symbol.for\|TEE" dsh-review/jobs.js` | pass if: symbol 标志存在且用于 jobs.read 包装前防重包判断
2.7 jobs.js 含 400ms pump | how: `grep -n "PUMP_MS\|setInterval" dsh-review/jobs.js` | pass if: 常量 = 400 且有对应 setInterval pump
2.8 jobs.js 记录 jobId→ownerAgent | how: `grep -n "owners" dsh-review/jobs.js` | pass if: 存在 owners Map 且 onJobsChanged 回调与 read 兜底两处记录
2.9 index.js 的 apply(ctx) 含对 jobs 接线函数的调用 | how: `grep -n "installJobsBridge" dsh-review/index.js` + read apply() | pass if: apply() 体内调用 jobs.js 导出的接线函数
2.10 tee 透传:wrapped read 把 (id,caller) 原样传给原实现,异常原样 rethrow | how: read jobs.js wrapped read | pass if: 原实现调用不在 try/catch 内(异常自然向上传播),仅 delta 拷贝有保护
2.11 环形缓冲固定容量、满丢最旧 | how: `grep -n "RING_BYTES\|shift" dsh-review/jobs.js` + read makeRing | pass if: 有固定容量常量(建议 256KB)且超限丢最旧
2.12 pump 只抽干环形缓冲、绝不调用真实 read | how: read jobs.js pump setInterval 体 | pass if: 体仅 ring.drain + broadcast('output'),无 jobs.read 调用
2.13 job 帧字段齐 {id,kind,label,status,cwd,detail?} | how: `grep -n "frameOf" dsh-review/jobs.js` + read frameOf | pass if: id/kind/label/status 必有,cwd(owner.session.header.cwd)与 detail 可选
2.14 kill 路由用记录的 ownerAgent 调 jobs.kill 并回 200 {ok:true,result} | how: `grep -n "jobs.kill" dsh-review/jobs.js` + read POST handler | pass if: `jobs.kill(id, owners.get(id))` 且 200 `{ ok: true, result }`
2.15 SSE 路由保持连接打开且心跳 15-30s | how: `grep -n "HEARTBEAT_MS" dsh-review/jobs.js` + read events handler | pass if: 响应不 end(保持打开)且心跳间隔在 15000–30000ms

## ROUND 3: VSCode 扩展侧 jobs 只读终端(dsh-jobs.js 新建 + extension.js 接线 + package.json 命令)
3.1 `dsh-review-vscode/lib/dsh-jobs.js` 存在且有真实内容 | how: `ls -la dsh-review-vscode/lib/dsh-jobs.js && wc -c` | pass if: 存在且字节 > 0
3.2 `node --check dsh-review-vscode/lib/dsh-jobs.js && node --check dsh-review-vscode/extension.js` 均 exit 0 | how: 原样运行该命令 | pass if: 无报错、exit 0
3.3 `dsh-review-vscode/extension.js` 存在且有真实内容 | how: `ls -la dsh-review-vscode/extension.js && wc -c` | pass if: 存在且字节 > 0
3.4 `dsh-review-vscode/package.json` 合法 JSON 且含 killDshJob 命令 | how: `node -e "JSON.parse(...)"` + `grep -n killDshJob` | pass if: JSON 解析 exit 0 且含 "dshReview.killDshJob"
3.5 dsh-jobs.js 用 createTerminal 开 pty 终端 | how: `grep -n createTerminal dsh-jobs.js` + read | pass if: `createTerminal({name:'dsh '+id, pty})` 调用存在
3.6 dsh-jobs.js Pseudoterminal 只读(空 handleInput) | how: `grep -n handleInput dsh-jobs.js` + read | pass if: `handleInput` 为空实现 `() => { }`
3.7 dsh-jobs.js SSE 连 /dsh-review/events | how: `grep -n "/dsh-review/events" dsh-jobs.js` | pass if: 请求 path 精确为 `/dsh-review/events`
3.8 连接/重连时先 GET /dsh-review/jobs 补状态并按 jobId 去重 | how: `grep -n "/dsh-review/jobs" dsh-jobs.js` + read connect/reconcileJob/ensureTerminal | pass if: connect() 调 getJobs,且 reconcileJob→ensureTerminal 对已存在 jobId 去重
3.9 dsh-jobs.js POST /dsh-review/jobs/<id>/kill | how: `grep -n "/kill" dsh-jobs.js` + read kill() | pass if: method POST 且 path 为 `/dsh-review/jobs/<id>/kill`
3.10 extension.js 接线且不破坏既有集成 | how: `grep -n "connectDshJobs\|killDshJob\|dsh-process\|dsh-auth-proxy" extension.js` + read activate | pass if: require connectDshJobs + activate 内调用 + registerCommand('dshReview.killDshJob'),且 dsh-process/dsh-auth-proxy 集成仍保留
3.11 dsh-jobs.js 复用 mintCookie 为 127.0.0.1:dshPort() 签 cookie | how: `grep -n "mintCookie\|dshPort" dsh-jobs.js` + read authority() | pass if: authority = '127.0.0.1:'+dshPort() 且 kill/connect 两处以它 mintCookie
