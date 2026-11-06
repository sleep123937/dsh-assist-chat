# dsh-assist-chat

[English](README.md) | 中文

DeepSeek Harness 的**右侧栏辅助对话**。

在右侧栏开一条**当前对话的分支**：它带着主对话到这一刻为止的完整历史（所以「上面那个报错」「刚才改的文件」它都懂），然后在自己的分支里继续跑，不改写、不打断主线。

面板不自己画聊天框——它挂载产品自带的 Conversation 界面，所以流式输出、markdown、工具卡片、审批、Stop、composer 全部与主对话一致。

对标 ZCode（`zai-org/ZCode`）的「辅助对话」：同样是右侧面板里的一个标签页，背后是与主任务并行的真实子会话。不是弹窗，也不占用主区域。

## 为什么需要它

干到一半想问点偏的：一个设计问题、一次 sanity check、一句「这报错到底什么意思」。单开一个窗口就丢了上下文；在主对话里问又会污染你正准备交付的 transcript。

辅助对话是第三种选择：fork 当前对话，它知道主对话知道的一切，并且和它并排跑。

## 特性

- **是分支，不是空白会话**——每次打开都 fork 主对话**此刻**的状态。
- **天然隔离**——独立 Session、独立 Agent、独立 transcript，这里说的一切都不会落进主线。
- **原生聊天界面**——消息、流式、工具调用、代码块、Stop、composer 全部继承，不重画。
- **按对话隔离**——A 的分支不会在你看 B 的时候冒出来。
- **标签生命周期 = 分支生命周期**——标签开着就是同一条分支（切标签、收起面板都不重建），关掉即结束。
- **不污染目录**——分支存活期间在左侧列表里被隐藏，关闭时归档。
- **一个快捷键**——`Ctrl+Shift+B`（macOS 为 `Cmd+Shift+B`）打开当前对话的辅助对话，已经打开时直接聚焦；Desktop 上是可改键的正常命令，Web 宿主已占用该组合键时由插件抢先消费。

## 路线图

只是方向，不承诺日期。

**0.2.0**

- **划词提问**——在主对话里选中一段文字，直接作为引用上下文发到辅助对话，不用再复制粘贴。
- **结论回流主线**——把辅助对话得出的结论作为一条引用消息插回主线，而不是把整段侧聊搬过去。
- **多开**——同一条对话可以同时保留多个分支，各自在自己的标签页里。
- **快照刷新**——不关闭标签也能重新 fork 主对话的最新状态。

**0.3.0 及以后**

- **嵌套侧聊**——在辅助对话里再开一条分支追问。
- **保存为正式会话**——想把分支留下时，把它提升为会话列表里的正式会话。
- **模型/权限继承选择**——fork 时可以选择分支继承哪个模型、哪种权限模式，而不是始终照搬主线。

## 安装

### 从插件市场

在**插件 → 发现**里搜 `dsh-assist-chat`，或添加索引源后安装。

### 从 npm

```sh
dsh plugin --profile desktop add dsh-assist-chat
```

### 从本地目录

```sh
dsh plugin --profile desktop add link:/本地绝对路径/dsh-assist-chat
```

包自带 `cordis.patch.yml`，loader 条目由包自己 insert，不用改 profile 的 patch 层。**装完重启 DeepSeek Harness。**

## 用法

1. 打开一个已有内容的会话；
2. 点会话 header 里的**辅助对话**（右侧栏引导页里也有同一个入口）；
3. 右栏出现该对话的分支，直接提问；
4. 用完关掉标签；下次再打开会重新 fork 当时最新的主对话。

不想点按钮也行：`Ctrl+Shift+B`（macOS 为 `Cmd+Shift+B`）随时打开/聚焦辅助对话，焦点在哪都生效。单实例是按主会话算的——不同主会话各有一条自己的右栏分支，同一主会话内再按只会聚焦已有标签，不会重复开。

## 实现要点

| 部件 | 注册方式 |
| --- | --- |
| 标签类型 | `ctx.sidebarRightTabs.register({ id, kind: "assistchat", keepMounted: true, guide })` |
| 标签正文 | `ctx.slots.register({ name: "sidebar.right.pane.tab", key: <id>, children })` |
| 聊天界面 | `renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView } })` |
| 入口 | `conversation.session.header.actions` —— 是 list 槽；`.corner` 是 single 且已被占用 |

### 会话生命周期

1. 取屏幕上的会话：`ctx.get("uiWorkspace").mainReference.sessionId`；
2. `ctx.get("sessions").fork({ sessionId, increaseTitle: true })` —— 子会话继承完整历史；父会话为空时回退 `create({ workspaceId })`；
3. `ctx.get("sessions").retain(id, { source, signal })` 拿 SessionReference；
4. 组件卸载（标签关闭）时先 release，再归档。

父会话 id 通过标签的导航参数传进去（`openTab(kind, { params: { parent } })`）。dock 布局本来就按 Session 存，分支身份也按同样的键存。

### 两个会咬人的地方

**别归档还在用的分支。** DSH 的 `archived-session-gate` 会 reject 归档会话的每一个 `agent/pre-step`：消息进了队列然后静默消失，一点报错都没有。只能在标签关闭**之后**归档。

**所以隐藏只能是显示层的。** 左侧目录每行都有稳定的 `data-row-key="session:<id>"`，插件可以给自己造的行走 `display: none`，会话本身完全可写；「展开其余 N 个会话」计数也会修正——被挤进折叠尾部、没有渲染出来的隐藏分支不再计入，剩余全是隐藏分支时计数按钮直接不显示，而不是给一个永远兑现不了的数字。代价：这套修正依赖目录的 `data-row-key` 约定（行 `session:<id>`、计数按钮 `overflow:<groupKey>`），并且是通过改本地化计数文案里的数字实现的。

## 兼容性

- DeepSeek Harness `>= 0.2.0`（`engines.dsh`）。
- 纯 Client 插件 API——没有 host 侧代码，也不修改 DSH 文件。
- 分支在标签打开期间会出现在会话目录里，关闭后归档。

## 开发

```sh
npm test        # 在 mock 宿主里加载 client.js，断言每个 seat 与渲染
npm run check   # 只查语法
```

`test/smoke.cjs` 用 `vm` + mock React + mock Cordis context 跑真实的 Client 模块，不需要开 GUI。

## 反馈

遇到问题、有想法、或者「在我机器上跑不起来」，都欢迎：

- [报告问题](https://github.com/sleep123937/dsh-assist-chat/issues/new?template=bug_report.yml)
- [提个建议](https://github.com/sleep123937/dsh-assist-chat/issues/new?template=feature_request.yml)
- [看看别人提了什么](https://github.com/sleep123937/dsh-assist-chat/issues)

不想用 GitHub 也行，直接发邮件到 **zousleep@163.com**。

## 许可

MIT