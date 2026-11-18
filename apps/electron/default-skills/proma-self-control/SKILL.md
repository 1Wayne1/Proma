---
name: proma-self-control
description: 用户明确要求观察或操作 Proma 自己的主窗口，例如打开 Todo 或日程、操作 Proma 文件搜索、滚动项目或会话文件区、交付 Proma 脱敏截图时使用。需要当前对话提供 PromaSelf 工具。
group: proma
version: "1.0.0"
---

# 操作 Proma 界面

在用户明确请求时使用当前会话提供的 `PromaSelf*` 工具。若工具不可用，请说明当前会话无法操控 Proma 界面并结束操作。

1. 用 `PromaSelfObserve` 枚举当前可操作控件，或用 `PromaSelfFind` 按固定 ID、标签查找。将同一结果里的 `generation` 和 `reference` 传给动作工具，并确认 `actions` 包含相应动作。
2. 用 `PromaSelfClick` 打开 Todo 或日程。文件搜索支持 `PromaSelfFill` 和 `PromaSelfPress`，按键为 `ArrowUp`、`ArrowDown`、`Escape`。文件区支持 `PromaSelfScroll`。
3. 动作会消耗引用。操作下一项前重新观察。若控件尚未出现，可以用 `PromaSelfWaitFor` 等待固定控件，最长 10 秒。
4. 需要交付截图时调用 `PromaSelfScreenshot`，PNG 会显示在当前会话。截图只绘制固定标签和控件轮廓。截图也会使已有引用失效。若下一步会离开当前 Agent 标签，先交付所需截图，再执行导航。

遇到会话切换、取消、审批或受保护控件，请停止操作。禁止用其他工具绕过这项授权、响应审批、读取敏感界面内容或发起新的 Agent 请求。
