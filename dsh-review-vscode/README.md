# dsh-review-vscode — 落地流程说明（shadow + pending）

面向：dsh / VS Code 插件 / git 都偏小白的读者。  
**状态：已按本文落地**（dsh 写 `shadow/` + `pending.json`；VS Code 启动读 + FileSystemWatcher；裁决滚动写入 pending；无 SSE）。

---

## 目标

- dsh 每次 `edit` / `write` 后，VS Code 能弹出行内 review（绿新增 / 红删除幽灵行 / 接受·撤回）。
- **重启 VS Code 或 dsh 后，未审完的文件仍能恢复**，不依赖 SSE。
- 不轮询 `git status`；用工程目录下的 `shadow/` 做唯一真相。

---

## 目录约定（第一版）

放在**当前 workbench 工程根**下（以后再挪到 `~/.dsh/...`）：

```text
<工程根>/
  shadow/
    .git/           # 影子仓（不是用户自己的项目 .git）
    pending.json    # 待审小纸条（dsh 主导写，vscode 审完才删）
```

影子仓通过 `core.worktree = <工程根>` 指向真实文件。  
操作形态（由插件执行，你不用手敲）：

```bash
git --git-dir=shadow/.git --work-tree=<工程根> add …
git --git-dir=shadow/.git --work-tree=<工程根> commit …
git --git-dir=shadow/.git --work-tree=<工程根> show <hash>:<相对路径>
```

---

## 角色分工

| 组件 | 职责 |
|------|------|
| **dsh 插件** | 钩住工具；打影子 commit；写/更新 `pending.json` |
| **VS Code 插件** | 启动读 pending；`FileSystemWatcher` 盯 pending；`git show` 取文；`startReview` 渲染；裁决；审完删 pending |
| **SSE** | 第一版**可不做**（改用 pending + watcher） |

---

## 端到端流程（举例）

文件 `ref/test.py` 原来只有：

```text
hello
```

### A. dsh 侧（一次 edit）

1. **`tools/pre-execute`（还没改磁盘）**  
   - 影子仓 `add` + `commit` → **p1**（照片：`hello`）  
   - 更新 `pending.json` 里该文件条目的 `before = p1`（可先 `after = null`）

2. **工具真正改完文件**，磁盘变成：

   ```text
   hello
   world
   ```

3. **`tools/result`**  
   - 再 `add` + `commit` → **p2**（照片：`hello` + `world`）  
   - **原子写** `pending.json`：同一 `filePath` **覆盖**为最新一对，例如：

   ```json
   [
     {
       "id": "…",
       "filePath": "/…/ref/test.py",
       "before": "<p1-hash>",
       "after": "<p2-hash>",
       "updatedAt": 1234567890
     }
   ]
   ```

4. 写 pending 时建议：`pending.json.tmp` → `rename` 成 `pending.json`，避免 VS Code 读到半截 JSON。

### B. VS Code 侧（发现待审）

1. **启动时**：读一次 `shadow/pending.json`。  
2. **之后**：`FileSystemWatcher` **只盯** `shadow/pending.json`（不要 watch 整个 `shadow/.git`）。  
3. pending 有变化 → 对每个条目：  
   - `oldText = git show before:相对路径`  
   - `newText = git show after:相对路径`（或读磁盘，刚改完时通常等于 after）  
   - `startReview({ uri, oldText, newText })` 渲染。

### C. 用户裁决

- **接受一块**：磁盘已是新内容 → **不改文件**；只推进插件内部「还剩哪些 hunk」。  
- **撤回一块**：把该块写回 old 对应内容 → **改磁盘并保存**。  
- **该文件所有 hunk 都处理完**：从 `pending.json` **删除该文件条目**（写回文件）。

---

## 问题 1：一块 AC/RJ 后关窗口，A_1 会不会丢？会不会又渲染出来？

### 若 pending **只**存整文件的 `before=p1`、`after=p2`，中途什么也不更新

会有问题：

1. 用户接受了 hunk **A_1**（例如留下 `world`），还没审完就关 VS Code。  
2. pending 仍是 `{ before: p1, after: p2 }`。  
3. 重启后再 `git show p1` / `git show p2` → 又是**完整** old vs new。  
4. **A_1 会再次出现在 UI 里**，等于「接受」丢了。

所以：**「文件没审完就不删 pending」只能保证「这个文件还要审」；不能单独保证「已经点过的那几块还算数」。**

### 正确做法（必须二选一，推荐 A）

**A. 每裁决一块，就把「当前还剩什么」写回 pending（推荐）**

pending 每条额外带上滚动状态，例如：

```json
{
  "filePath": "…/ref/test.py",
  "before": "<p1>",
  "after": "<p2>",
  "baselineText": "当前已接受后的基准全文",
  "documentText": "当前磁盘应展示的全文（含已撤回的还原）"
}
```

或等价地存 `ReviewCore` 的 `originalText` / `modifiedText`。

- 每 AC/RJ 一次 → vscode **更新**这条 pending（仍不删）。  
- 重启 → 用 `baselineText` vs `documentText`（或 core）渲染 → **只剩未裁决 hunk**，A_1 不会回来。  
- 文件彻底审完 → **删整条**。

**B. 每裁决一块就再打影子 commit，改写 before/after**

使 `git show before` vs `after` 的 diff **永远等于剩余 hunk**。  
实现更绕，第一版不优先。

### 小结

| 情况 | A_1 会不会再渲染 |
|------|------------------|
| 只存 p1/p2，中途不更新 pending | **会**，接受丢失 |
| 每块裁决后把滚动状态写入 pending | **不会** |
| 整文件审完并删除 pending 条目 | 正常结束，不再渲染 |

---

## dsh 插件要做的事（清单）

1. 确保工程根下存在 `shadow/`，初始化影子 git（`init`、`core.worktree`、首次底片 commit）。  
2. `tools/pre-execute`：对将改的文件打 **before commit**，更新 pending 的 `before`。  
3. `tools/result`：打 **after commit**，更新 pending 的 `after`（同路径覆盖）。  
4. 原子写 `pending.json`。  
5. 同一文件多次 edit：pending **只保留最新一轮** before/after；若 vscode 正在审旧一轮，需约定「以最新 pending 为准刷新 UI」（见注意点）。  
6. 第一版可不提供 SSE。

---

## VS Code 插件要做的事（清单）

1. **activate**：解析当前工作区根 → 读 `shadow/pending.json` → 恢复 review。  
2. **FileSystemWatcher**：只监控 `shadow/pending.json`；防抖 50–100ms；自己写入触发时要幂等（别死循环弹窗）。  
3. 用影子仓 `git show` 得到 old/new（或读 pending 里的滚动文本）→ `startReview`。  
4. 每块 AC/RJ 后：**写回 pending 的滚动状态**（见上节）。  
5. 该文件 hunk 清空后：从 pending **删除**该条目。

---

## 性能（为何不用轮询）

| 手段 | 空闲 | 每次 edit |
|------|------|-----------|
| 定时 `git status` / 扫目录 | 持续耗 | 差 |
| **只 watch `pending.json`** | 近乎 0 | 读小 JSON + 渲染 |
| watch 整个 `shadow/.git` | 易吵、易重 | **不要** |

---

## 必须注意的点

1. **真相在磁盘 `shadow/`**，不在 SSE，不在 vscode `workspaceState`。  
2. **pending 原子写**（tmp + rename）。  
3. **只 watch 一个 JSON**，不 watch `.git`。  
4. **部分裁决必须持久化滚动状态**，否则重启会重放已 AC/RJ 的块。  
5. **删 pending 的时机** = 该文件 review 彻底结束，不是每一块。  
6. **影子仓 ≠ 用户 git**：不要 `commit` 进项目 `.git`；`shadow/` 应进 `.gitignore`。  
7. **路径**：pending 里建议存绝对路径或「相对工程根」并在两端统一。  
8. **vscode 与 dsh 同时写 pending**：dsh 覆盖「最新 AI 轮次」；vscode 更新「滚动裁决状态」。同一条目建议字段分开（`before`/`after` 归 dsh；`baselineText`/`documentText` 归 vscode），避免互相抹掉。  
9. **AI 在审到一半又 edit 同一文件**：以 dsh 新写入的 before/after 为准刷新；旧的未完成裁决作废或合并策略要简单明确（第一版：直接换成最新一轮）。  
10. **多工作区**：第一版按「当前打开的文件夹根」下的 `shadow/`；多根 workspace 以后再说。

---

## 第一版明确不做

- SSE 推送（可后加，不能当唯一通道）  
- vscode workspace 便利贴当真相  
- 每块 RJ 后强制影子 `commit p3`（可选增强）  
- Cmd+Z 撤销裁决  
- 轮询 git  

---

## 验收用例（实现后按这个测）

1. dsh edit 一次 → 出现 `shadow/` 与 pending → VS Code 弹出 review。  
2. 只接受一块就重启 VS Code → **已接受的块不再出现**，未接受的还在。  
3. 全部审完 → pending 无该文件 → 再重启无 review。  
4. 关掉 VS Code 再让 dsh edit → 再开 VS Code → 能从 pending 恢复。  
5. 工程空闲时 CPU 不明显升高（watcher 未乱触发）。
