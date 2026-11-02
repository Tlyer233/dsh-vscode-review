# Heap-Bridge:零 hover、零 click 直取 Copilot 附件全量内容

**日期:** 2026-11-02 · **状态:** 实测通(证据见 `docs/examples/`) · **代码:** `tools/deliver_chips.js`(主)/ `tools/live_bridge.js`(原型)

## 一句话

Copilot 输入框里每个附件 chip 的**全套官方内容**,在标注那一刻就已固化进 VS Code 工作台的 JS 堆;用 CDP **堆快照按属性检索 + 快照id→活对象桥**,可以在任意时刻、不点不悬停地把它们整份捞出。

## 源码依据(本机 bundle 定位)

```
electron-main(mainImpl.js @565900):
  CDP 五连采集 DOM.getBoxModel / CSS.getMatchedStylesForNode /
  CSS.getComputedStyleForNode / DOM.getOuterHTML + ancestors/attrs
      ↓ e (原始数据, pick 瞬间)
renderer(workbench.desktop.main.js @21454846):
  _attachElementDataToChat(e) → entry = { id:'element-<ts>', name, fullName,
      value: R8s(e)  ← 官方全串(Attached Element Context/Element/URL/
                        HTML Path/Outer HTML/Dimensions/CSS)
      imageData: captureScreenshot(pageRect)  ← pick 时的截图字节
      ancestors, attributes, computedStyles, dimensions, innerText,
      modelDescription, kind:'element', icon }
  attachmentModel.addContext(entry)   ← 正式东家
      ↓
  chip widget 构造时即建好 hover 卡 DOM(游离态);hover 只是挂载投影
```

结论:**hover 卡不是数据源,是投影**;母本=堆里的 entry。`kind:'image'`(区域/整页截图)等附件同构:`{id,name,kind,value=JPEG字节,mimeType}`。

## 方法(五步,已固化为 deliver_chips.js)

```
1. 读 DOM:  .chat-attached-context-attachment[aria^="Attached element,"]
            → 当前 chip 列表(名字序=模型序)
2. 清自己人的引用(window.__dshrCap=[]) + HeapProfiler.collectGarbage ×2
            → 排除探针自身造成的存活假象
3. HeapProfiler.takeHeapSnapshot(约 5s, 240MB)
   解析 nodes/edges/strings, 全堆找:
     kind 边→'element' 且 value 边→'Attached Element Context*'   (元素附件)
     kind 边→'image'                                            (截图附件)
4. HeapProfiler.getObjectByHeapObjectId(快照id) → 活对象 objectId
   (注意: 必须在同一 CDP session 内; 响应层级 g.result.result.objectId;
    参数名两版都传 {heapSnapshotObjectId, objectId})
5. Runtime.callFunctionOn 直读:
     entry.value                       ← 无截断全串(快照里的串截 1024B,
                                          所以必须桥回活对象)
     entry.imageData → Uint8Array      ← VSBuffer 取法: raw.buffer 若是
                                          ArrayBuffer 要按 byteOffset/byteLength
                                          重建 view, 否则拿到池子(全零/错位)
     image entry.value               → JPEG 原始字节
6. 配对: chip 名 vs entry 的 'Element:' 行 —— '#id' 段必须一致,
   裸 tag 必须配无 id 元素; 同名取 id 最新(堆里可能有历史批次残留,
   发送/清除后会被正常 GC, 不会累积)
```

## 实测战果(2026-11-02, 13:55-14:04)

| 输入框内容(实时) | 交付 |
|---|---|
| chip `th` | R8s 全文 1761B + jpeg ✓ |
| chips `span`/`span#ctx-pct`/`span#mv-vram` | 3 文件+3 截图,id 精确对撞 ✓ |
| chips `span#pill`/`button#unload-btn` + 2 截图附件 | 2 R8s + 2 元素截图 + **Browser Area Screenshot(15.6KB jpeg)** + **Browser Screenshot(148KB jpeg)** ✓ |
| 输入框清空后 | 0 chip → 0 文件(诚实,不拿堆里余货充数) |

样例存档:`docs/examples/chip_file-chip1.{txt,jpg}` `chip_file-chip2.{txt,jpg}` `chip_shot-shot1-*.jpg` `chip_shot-shot2-*.jpg`。

## 踩坑记录(都付过学费)

1. `getEventListeners()`/`[[Scopes]]` 闭包路:匿名 context 槽(idx329)里的 entry **CDP scope 代理枚举不到** → 闭包路只能当辅助
2. 堆快照字符串**截断到 1024B**(拼接串碎片也止于 1024) → 只靠快照拿不到全 value,必须第 4 步桥回活对象
3. `getObjectByHeapObjectId` 的 id **只在快照产生的同一 session 内有效**
4. imageData 是 VSBuffer:直接 `raw.buffer` 会拿到 64KB 池(开头 04 02 06),要 `new Uint8Array(buf, byteOffset, byteLength)`
5. DOM 合成 mouseout 杀不掉 hover 卡(只认真实指针事件)——但本方法根本不产生卡
6. 同名 chip 按 DOM 序号;陈旧 entry 按 id 时间戳+名字段精确匹配甄别

## 与现行管线(0.1.177)的关系

现行"发送时逐 chip 合成 hover 读卡"仍是已部署主管线;Heap-Bridge 是**更强的替代候选**:
- 优点:零 UI 副作用、不依赖面板展开状态、内容无 Show More 截断问题(直接拿 value 全串)、顺带通吃截图附件
- 待办:接入 extension(快照 ~5s + 解析 ~20s/次,需评估发送路径时延;可只在大附件时启用)、批注注释行(输入框 `@xxx 注释`)的活对象读取

输出目录约定:所有探针脚本写 `os.tmpdir()/dsh-probe/`(mac/linux/win 开机或系统清理自删),工作区不留垃圾。
