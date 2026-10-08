# PLAN — dsh 后台 jobs → VSCode 只读终端(SSE + tee + 按 id 直杀)

构建(dsh 核心零改动,交付物只有两个插件):

1. **dsh-review(server 插件)**:新增 `jobs.js` 模块,在 `apply(ctx)` 里接线(幂等,可重复加载):
   - tee 包装 `ctx.jobs.read`:symbol 标志防重包;每次调用原样透传 (id, caller) 给原实现,返回的 delta 同时拷贝进按 jobId 的环形缓冲;异常原样抛出。agent 的读取与今天字节级一致 → 不丢、不重,`reported` 不受影响(pump 从不调用真实 read)。
   - 400ms pump 抽干环形缓冲 → SSE `output` 帧。
   - `ctx.jobs.onJobsChanged(owner)` + `list(owner)` diff → SSE `job` 帧(新 job / 状态变化),并记录 jobId→owner Agent(kill 要过 session 栅栏,U1)。
   - 路由用 `ctx.webServer.register`(U2):exact `GET /dsh-review/events`(SSE,保持响应打开);prefix `/dsh-review/jobs`(GET → JSON 列表,含 cwd = owner.session.header.cwd;POST `…/<id>/kill` → `jobs.kill(id, 记录的 ownerAgent)`)。

2. **dsh-review-vscode**:新增 `lib/dsh-jobs.js` + `extension.js` 小钩子:
   - 复用 dsh-auth-proxy.js 的 `mintCookie` 为 `127.0.0.1:dshPort()` 签 cookie(U5)。
   - node:http 开 SSE 连 `/dsh-review/events`(扩展宿主无 EventSource),断线退避重连。
   - `job` 帧(status=running 且 cwd === 当前 VSCode 工作区 folder)→ `vscode.window.createTerminal({name:'dsh '+id, pty})`,Pseudoterminal 只读(handleInput 空实现)。
   - `output` 帧 → pty.write;终态 `job` 帧 → 写 `[done: <status>]` 尾行。
   - 关终端 + 命令 `dshReview.killDshJob` → POST `/dsh-review/jobs/<id>/kill`。

3. 重装:跑 install.sh(npm pack → `dsh plugin --profile web add --force`;扩展拷进 ~/.vscode/extensions;U6);随后重启 dsh web、完全退出重开 VSCode。

QA 观察:QA agent 先用本会话 bash 工具(run_in_background)起一个活的后台 tick job,再跑 T1 `try_scripts/verify_jobs.js --port=3080 --job=<id> --seconds=10`(→ try_scripts/out/verify_jobs.txt;PASS = 列表含目标 + SSE 有输出 + kill 200 + 终态帧),随后 QA 自己对该 job 再调一次 `job_output` 确认 tee 无损(真实 delta 完整、无重复)。VSCode 终端弹标签/关标签杀 job 由用户目视确认(视觉部分)。

HOOK CONTRACT: dsh web server(127.0.0.1:3080)上的 dsh-review 插件暴露:
- `GET /dsh-review/jobs` → 200 JSON 数组 {id, kind, label, status, cwd, ...}
- `GET /dsh-review/events` → SSE:`event: job` data {id,kind,label,status,cwd,detail?};`event: output` data {id,text}
- `POST /dsh-review/jobs/<id>/kill` → 200 {ok:true, result:'requested'|'already-finished'}
- 认证 = browser session cookie(与 dsh-auth-proxy.js 同算法);stand-in 固件: try_scripts/mock_server.js。

已验证事实(全部 planner 只读快查,见 probes.json):U1 jobs API+栅栏;U2 webServer.register 支持 SSE;U3 web profile 插件 ctx 有 jobs+webServer;U4 插件形态;U5 扩展集成点+Pseudoterminal(engines ^1.85);U6 install.sh 流程;U7 snapshot 字段+cwd 路径。
