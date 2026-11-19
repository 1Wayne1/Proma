---
name: cua-driver-cli
description: 用户要求查看或操作 Windows x64、macOS Apple Silicon 的外部应用窗口，或在会话中持续预览窗口时使用。需要当前会话提供 DesktopWindow 工具。
group: proma
version: "1.0.1"
---

# 桌面窗口

使用 `DesktopWindowObserve`，传入用户指定的应用名。用户在 Proma 中选择目标窗口。设置 `preview: true` 可在当前会话持续显示窗口，设置 `screenshot: true` 可把本次截图交给模型。预览卡片提供激活窗口、重试和停止控件。当前运行结束、取消或切换会话时，预览自动关闭。

用 `DesktopWindowAct` 传入最新观察返回的 `reference`。点击时传入 `"value": null`，填写时传入文本，空字符串表示清空。用户确认后执行，每个引用只可使用一次。操作超时、目标消失或会话切换时，重新观察目标并核实实际结果。

需要已安装的官方 Cua Driver `0.53.0`。若提示系统权限不足，请用户检查当前应用的辅助功能和屏幕录制授权。通过 Proma 已注册的工具执行窗口操作。
