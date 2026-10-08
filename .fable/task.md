# TASK

### GOAL
执行参考会话(session-7e740cb6)中已获用户批准的计划:让 dsh 当前工作区的 agent 后台 bash 任务(jobs)在 VSCode 终端面板中以 Copilot 同款的只读终端弹出、实时可见输出,并且用户可以在 VSCode 里按 job id 直接杀掉它。交付物只有两个插件:dsh server 端插件(dsh-review)和 VSCode 扩展(dsh-review-vscode),dsh 核心零改动。
### CONSTRAINTS
- dsh 内置 bash 工具与 dsh 核心代码必须原样保留:不替换、不禁用、不改源码;产物只允许是 profile 插件,保证 dsh 升级后 hook 不受影响(用户在参考会话中明确拍板)。
- job 输出是单一消费游标,agent 的 job_output 正在消费它,不能旁路偷看。hook 方式 = server 插件运行时包装 ctx.jobs.read 做 tee(约 400ms pump 消费进环形缓冲;agent 的读取自动变成"真实 delta + 缓冲尾部"的并集,不丢不重)。hook 必须幂等、异常透传,全部放在我们自己的插件代码里。
- 终端必须只读:用公开 API vscode.window.createTerminal({pty}) 配合 Pseudoterminal 接口(handleInput 空实现)。注意:Copilot 没有"专用终端接口",它用的就是这个公开 API;走同一 API 即等同于"走 copilot 的终端",这是参考会话中已验证并向用户说明过的事实,不要再去找什么内部接口。
- kill 路径:VSCode 侧关终端/触发 kill 时,由插件直接 POST 到 server 插件注册的 HTTP 路由 → dsh 内置 jobs.kill(它自己走 SIGTERM→SIGKILL),不经过 agent、不回 hook。
- 作用域限定"当前工作区":只为当前 workspace 的 session/agent 的 jobs 弹终端。
- server 端挂路由用 ctx.webServer.register(),支持 SSE;/api 前缀已被 typert RPC 占用,但精确路由可共存且自带认证(参考会话已验证)。
- 用户强制要求:必须大量使用 exa 搜索 + 去 GitHub 等社区找相关解决方法(用户会实时查看搜索量;搜索内容必须有意义)。
- 最小实现,禁止过度设计(AGENTS.md 最高级约束)。
### SUCCESS
1. agent 在当前工作区启动一个后台 bash job 后,VSCode 终端面板自动弹出一个只读终端标签,实时滚动显示该 job 输出(类似 Copilot 的终端)。
2. 在 VSCode 对该 job 杀(关终端/kill 操作)后,dsh 侧该 job 被 jobs.kill 杀掉,终端关闭。
3. agent 自身的 job_output / job_list / 完成通知不受 tee 影响(不丢、不重、reported 完成标记不被 pump 误置)。
4. dsh 核心文件零改动;`dsh plugin` 重装插件即可生效,无 core patch。
### IN SCOPE
- dsh-review(server 插件):注册 HTTP 路由(SSE)推送 job 输出;包装 ctx.jobs.read 做 tee + 环形缓冲;提供按 jobId 的 kill 路由;只针对当前工作区的 session。
- dsh-review-vscode(VSCode 扩展):检测/接收 job 启动事件 → vscode.window.createTerminal({pty}) 开只读 Pseudoterminal 终端;接 kill;与现有 dsh-process / auth proxy 集成。
- 需要时按 install.sh 流程 npm pack + dsh plugin add 重装 server 插件、reload 扩展。
### OUT OF SCOPE
- 修改 dsh 核心/内置 bash 工具/工具注册表。
- 多工作区支持(参考会话已明确第一版只做当前工作区)。
- 浏览器 web 端 jobs UI 的改动。
- 寻找或使用 Copilot 内部私有接口(不存在;用公开 Pseudoterminal API 即可)。
### INPUTS
- 参考会话快照(已批准计划,完整对话在父会话上下文中,要点):
  - 插件结构:dsh-review-vscode 是 webview 侧栏 + auth proxy + dsh 进程管理(dsh-process.js / dsh-browser.js / dsh-auth-proxy.js);dsh-review 是 server 端 profile 插件(dsh-review/index.js)。
  - 已验证事实:jobs 是内存 registry(read/kill/list);bash 输出在内存 + spill 文件;dsh 无 job 输出/kill 的现成 HTTP 接口,所以必须加 server 端插件路由;ctx.webServer.register() 可挂路由且支持 SSE;scoped 工具注册会 shadow 全局(本方案不用);web 前端 jobs UI 在 dsh-client-ui-jobs/client.js(确认 web 端无输出无 kill)。
  - 方案结论:community 无现成轮子,自研;hook 点必须选在 jobs 层(单消费游标决定)。
- 代码路径:
  - /Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsh-review-plugin/dsh-review/ (server 插件: index.js client.js workbench.js pending.js shadow.js package.json)
  - /Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsh-review-plugin/dsh-review-vscode/ (VSCode 扩展: extension.js lib/ media/ scripts/ package.json)
  - /Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsh-review-plugin/install.sh (打包安装流程: npm pack + dsh plugin --profile web add --force)
- 只读参考(dsh 本体,禁止修改): /Users/xi/.local/lib/node_modules/@deepseek-ai/dsh/ 及其依赖包(dsh-jobs / dsh-jobs-local / dsh-bash-local / dsh-tool-jobs / dsh-api-session-controller / dsh-host-webserver / dsh-client-ui-jobs 等),用于确认 ctx.jobs 接口、webServer.register 签名、路由与认证形态。
### USER DECISIONS
none — 跳过提问,因为计划已在参考会话中经用户逐点确认并批准("Plan approved — plan mode exited"),且本次指令是明确的执行型 follow-up。
### RAW
执行它的计划! (指参考会话 session-7e740cb6-ac2b-4d8c-b227-99715105d69f 中已批准的计划:当前工作区 dsh agent 的后台 bash 任务,以 Copilot 同款只读 VSCode 终端实时可见 + 按 id 直杀;保留 dsh 内置 bash;插件 hook jobs.read tee;核心零改动。原会话在"建任务清单,读 install.sh + dsh-review/package.json 确认打包形态"处中断,进度为零。)
