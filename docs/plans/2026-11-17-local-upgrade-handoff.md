# Proma 非云功能改造交接

更新日期为 2026-11-19（Asia/Shanghai），交接记录版本为 1.0.17。

## 接手先看

1. 在当前 `dev/new-version-features` 工作区修改工程。2026-11-18 的续作目录是 macOS 的 `/Users/weibo/projects/Proma`，下文的 Windows 路径为此前实施和证据位置。
2. 先读根目录 [AGENTS.md](../../AGENTS.md)，再读 [spec.md](../../spec.md) 第 2、3、10、13、15、26—35 节及本文。运行 `git status` 核对当前工作区。
3. **macOS arm64 已通过 S6 窗口主流程和 S7 新装、覆盖升级、Automation、Collaboration 实机验收。** 当前桌面应用 `0.19.83` 使用 Pi `1.5.2`。升级前可回退基线为 `10b98fb7`。多屏 DPI、正式发布和 Windows 完整验收待完成。
4. 用户明确排除 Proma 云服务。沿用 Pi、本地 JSON/JSONL、Bun、Jotai 和已有权限边界。参考安装版提供功能证据，不是要求复制其云端架构。
5. 工程命令使用 Bun。此前的 Node/REA 卸载记录适用于 Windows。当前 Mac 上的 REA 已按用户要求安装，只有需要确认安装版差异时才使用。

## 2026-11-18 交付记录

| 阶段 | 交付内容 | 基线 |
| --- | --- | --- |
| S6-01 | Windows x64 与 macOS arm64 桌面窗口工具，固定驱动版本、窗口选择与单次动作授权 | `68e1fb5e` · Electron `0.19.77` |
| S6-02 | 窗口预览、低频回退、激活、重试、停止与 `cua-driver-cli` | `755dbc1b` · Electron `0.19.78`、shared `0.1.81` |
| S7 兼容 | 更新记忆、浏览器与 Chat 工具的默认 Skills，新增本地应用构建 Skill。旧 Chat 可读取局部损坏的历史，重复导入同一 Agent 会话只补新增消息。Agent 索引保留迁移前备份，Chat 工具保留旧开关、凭据和扩展字段。 | Electron `0.19.79` · 规格第 31 节 |

S7 提交前复跑了会话管理、记忆服务与集成、权限服务三组 Bun 测试，共 58 项通过。另有 1 项 POSIX 目录权限测试按条件在 Windows 跳过。开发期间六个工作区类型检查和 Windows Electron 构建通过。

2026-11-19 已补齐 macOS Apple Silicon 系统授权、真实窗口预览、逐次确认及停止和切换会话清理。实际 Responses 验收、修复内容和 711 项 Bun 回归见规格第 32 节。

2026-11-19 从 `0.19.81` 本地 arm64 DMG 新装成功，并通过从 `0.19.78` 同位置覆盖升级及重启检查。已验证旧 Chat 和 Agent 会话、工作区、工具配置与默认 Skill 迁移，修正安装版 macOS 图标路径。详细证据见规格第 33 节。

同日使用 `0.19.82` macOS arm64 本地应用包补验 Automation、Collaboration 和覆盖升级。修复手动执行重算下次调度时间、初始运行忽略旧会话持久权限两处问题。旧记忆正文、历史版本、工作区授权和计划/完全自动模式通过升级及重启复查。使用已有第三方 Responses 渠道复跑两条工作流通过。714 项 Bun 测试、六个工作区类型检查和打包通过。详细证据见规格第 34 节。

`0.19.83` 升级 Pi `1.5.2` 并迁移原生网络重试补丁。715 项 Bun 测试和 macOS arm64 DMG 实机复测通过，包括旧会话续接和换回 `0.19.82` 后继续会话。详情见规格第 35 节。macOS 隔离测试优先使用 `--use-mock-keychain` 和合成凭据。沿用真实渠道的隔离实例曾触发系统钥匙串弹窗，遇到该提示可取消，保留现有钥匙串设置。

## 当前基线与提交状态

| 项目 | 记录时状态 |
| --- | --- |
| 主工程 | `E:\node_project\Proma` |
| 分支 | `dev/new-version-features`，跟踪 `origin/dev/new-version-features` |
| 功能提交 | `13afae331ab310c50f62aefcee0f472ac54e8acb`：`feat: 增加网络诊断、逐轮差异与安全恢复` |
| 提交范围 | 91 个文件；包含 S1/S2 实现、BDD、四层 IPC、界面、版本与 spec |
| 更早源码基线 | `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`，应用 `0.19.58` |
| 参考安装版 | `D:\Program Files\Proma`，静态比对版本 `0.22.80` |
| 功能交付版本 | Electron `0.19.64`、shared `0.1.77`，已进入上述提交 |
| 本次交接文档版本 | Electron patch `0.19.65`、spec `1.0.6`；shared 仍为 `0.1.77`。只更新文档与对应版本元数据 |
| S3-01 当前工作区 | 基于 `5abec93c` 实现；Electron `0.19.66`、spec `1.0.7`、shared `0.1.77` |
| S3-02 当前工作区 | Electron `0.19.67`、spec `1.0.8`、shared `0.1.78` |
| S4-01 当前工作区 | Electron `0.19.68`、spec `1.0.9`、shared `0.1.79` |
| S4-02 当前工作区 | Electron `0.19.69`、spec `1.0.10`、shared `0.1.80` |
| M1 原生验收当前工作区 | Electron `0.19.70`、spec `1.0.11`、shared `0.1.80`，包含项目记忆逐轮采样及快照目录边界修复 |
| M1 第三方 Responses 实机复测 | Electron `0.19.71`、spec `1.0.12`、shared `0.1.80`，包含渠道兼容、项目记忆初始化、并排焦点和独立 HTML 预览修复 |
| M1 macOS 系统事件补测 | Electron `0.19.72`、spec `1.0.13`、shared `0.1.80`，修复入口热更新重复挂载并验证受管浏览器交付与休眠提醒 |
| S3、S4 与 M1 基线 | `5541f077`，Electron `0.19.72`、spec `1.0.14`、shared `0.1.80`。用户实测跨应用 `⌘⇧T` 唤出「快速记录 Todo」 |
| S5-01 基线 | `bea6837e`，Electron `0.19.74`、spec `1.0.16`、shared `0.1.80`。主窗口控制器及脱敏截图 |
| S5-02 基线 | `feat(s5-02): 接入 Proma 自身操作工具与默认 Skill`，Electron `0.19.75`、spec `1.0.17`、shared `0.1.80`、默认 Skill `1.0.0` |

`spec.md` 第 16—20 节保留当时的提交、Node 版本和构建状态。最新进展见规格第 26—31 节和当前 Git 历史。

## 阶段进度

| 任务 | 已完成内容 | 接手判断 |
| --- | --- | --- |
| S0 | 安装版/开源版静态比对、基线问题及部分依赖调查有记录 | Windows 驱动等前置调查未全部闭环，不能宣告 M0 完成 |
| S1-01 | 网络错误分类、有限只读恢复、取消传播；MCP 调用失败不自动重放写入 | 已实现并有可执行测试 |
| S1-02 | 网络状态、渠道检查、脱敏诊断预览/导出、四层 IPC 和设置 UI | 已实现并有测试/组件验证 |
| S1-03 | Pi 三个核心包和 `pi-tui` 同步升级至 `1.5.2`，迁移 `pi-ai` 重试补丁 | macOS arm64 回归与实机验收见规格第 35 节 |
| S2-01 | turn/file/snapshot 类型、Git/受控工具捕获、比较、私有持久化与容量限制 | 已实现，保留主根/附加根边界和 partial 信息 |
| S2-02 | Pi 受控执行接线、追加消息分轮、重试 UUID 归属、四层查询与逐轮 diff 面板 | 已实现，捕获在原权限 allow 之后、工具执行之前 |
| S2-03 | 单文件恢复预览/应用、冲突保护、worktree 移除、监听引用计数和快照清理 | 本地测试与构建通过，逐轮文件恢复随 M1 完成 macOS 实机验收 |
| S3-01 | 记忆目标、revision、历史存储 | 已实现，macOS 定向回归与类型检查通过 |
| S3-02 | 记忆工具、编辑/搜索/历史界面、归档、旧记忆导入与指令关联 | 已实现，macOS 定向回归、浏览器夹具、main/preload 夹具、类型检查及完整构建通过 |
| S4-01 | 交付卡片、Vault 分页与导航、受管浏览器展示 | 已实现，定向回归、浏览器夹具、类型检查和构建通过 |
| S4-02 | 提醒及全局快捷捕获、终端活动、项目归档、会话配置和设置同步 | 已实现，验证记录见规格第 25 节 |
| S5-01 | 主窗口控制、受限控件操作与脱敏 PNG | 已完成，macOS 原生验收通过 |
| S5-02 | 8 个 Pi 工具、前台授权和默认 Skill | 已完成，macOS 原生 Electron 与现有 Responses 渠道验收通过 |
| S6-01 | Windows x64 / macOS arm64 驱动及窗口工具 | Windows 已通过隔离实例冒烟。macOS 已实测系统授权、窗口选择和逐次确认，见规格第 29、32 节 |
| S6-02 | 会话窗口预览、低频回退、激活、停止、重试与默认 Skill | Windows 已实测两帧及停止清屏。macOS 已实测实时预览与撤权清理，多屏 DPI 待验，见规格第 30、32 节 |
| S7-01 | 默认 Skills、旧配置与会话兼容，补验记忆、权限、Automation 和 Collaboration，应用 `0.19.82` | macOS arm64 新装、覆盖升级、重启和两项工作流通过，见规格第 31、33—34 节。签名发布和自动更新待验 |

M1 和 S5 的 macOS 实机验收通过。M2 仍需 S5/S6 的 Windows 实机验收，M3 仍需 S7 发布验收。

## S5 验收与回退

- S5-01 入口为 `main/lib/proma-self-controller.ts`、`proma-self-control-policy.ts` 和 `proma-self-screenshot.ts`。控制器只连接主进程登记的 Proma 窗口。截图由允许的控件布局和静态标签渲染，测试覆盖覆盖层像素、密码、模态、引用失效和取消。
- S5-02 在 `main/lib/agent-service.ts` 取得本轮前台授权，经 `agent-orchestrator.ts` 和 `adapters/pi-proma-self-tools.ts` 接入 Pi。默认 Skill 位于 `apps/electron/default-skills/proma-self-control/`，PNG 经既有工具结果显示并保存在当前会话。后台来源、排队启动和初始 Plan 模式不注册工具。停止、切出和重载会撤权。
- 在 macOS 复验时使用隔离的 Electron 开发实例、合成项目及现有 Responses 渠道。依次让模型读取默认 Skill、交付脱敏 PNG、查找并打开 Todo，再让模型等待不可见的文件搜索框，分别用停止 Agent 和切到全屏规划视图验证取消。核对 PNG 在会话中显示和持久化。S5-01、S5-02 分别通过全仓 681、687 项 Bun 测试、类型检查及 Electron 构建。
- 回退 Pi 工具层时用 `git revert` 撤销 S5-02，保留 S5-01 控制器。若需同时回退控制器，继续撤销 `bea6837e`，回到 `5541f077` 对应的功能范围。

## 已实现代码入口与必须保留的行为

以下路径均相对仓库根。

| 领域 | 代码入口 |
| --- | --- |
| 网络分类/恢复/诊断 | `apps/electron/src/main/lib/network/`、`proxy-fetch.ts`、`adapters/pi-mcp-tools.ts` |
| 网络 UI/状态 | `renderer/components/settings/NetworkDiagnosticsSettings.tsx`、`renderer/atoms/network-atoms.ts` |
| 快照采样/比较/存储 | `main/lib/turn-changes/{capture,compare,paths,git,store,recorder}.ts` |
| 执行生命周期 | `turn-changes/{run,service,identity}.ts`、`agent-orchestrator.ts`、Pi adapter/utility callback |
| 查询与恢复 | `turn-changes/{query,ipc,restore,restore-files,operations-ipc}.ts` |
| 共享/IPC bridge | `packages/shared/src/types/{network,turn-changes}.ts`、`main/ipc.ts`、`preload/index.ts` |
| 逐轮 diff/恢复 UI | `renderer/components/agent/{TurnChangesPanel,TurnRestoreControls}.tsx`、对应 Jotai atoms |
| worktree/目录/终端 | `main/lib/{worktree-removal,project-mutation-guard,directory-watch-subscriptions,workspace-resource-events,workspace-watcher,terminal-service}.ts`、`renderer/components/diff/WorktreeSelector.tsx` |
| 原子写 | `apps/electron/src/main/lib/safe-file.ts`，包含原始字节原子写和排他新增提交 |
| 文件交付 | `main/lib/{present-service,present-ipc,present-runtime}.ts`、`renderer/components/agent/PresentedResources.tsx` |
| Vault 与浏览器展示 | `main/lib/{vault-service,browser-preview-service,browser-controller}.ts`、`renderer/components/vault/{VaultView.tsx,useVaultDirectoryPages.ts}` |

上表 `main/`、`renderer/`、`preload/` 均在 `apps/electron/src/` 内；花括号只是文件定位简写，不是 PowerShell 命令。

- 恢复只读取已验证的私有 before 快照。预览核对当前内容与 after；应用再次核对 hash、文件/祖先/根身份、会话/工作区和授权。一次性预览 60 秒有效，至多 8 份。缺失/超限快照、未知状态或冲突必须明确拒绝。
- 只恢复目标文件，保留原始 BOM/CRLF/二进制字节、无关文件和 Git index。不要把旧的基于 HEAD 的 `revertFile` 接到逐轮恢复，也不要使用 `git reset --hard`。
- 捕获根是主项目或有效活动 worktree；附加目录不能因此变成任意扫描根。Git 观察变化可能来自外部程序，不能都声称是 Agent 修改。
- `project-mutation-guard.ts` 登记 runtime **实际** cwd、主项目和临时附加根。停止期间保留引用直到 abort/采样收束完成；旧代次释放不能影响新代次。
- Worktree 移除检查活动任务/队列/预检/终端、资源引用、真实根与 Git 登记、locked/prunable、未提交/未跟踪/**ignored** 文件。用不带 force 的 Git 移除，保留分支；成功后才清理空闲会话 activeWorktree、观察和已退出终端引用。
- 目录订阅按规范化路径和所有者集合共享；metadata 写入事件覆盖删除、迁移和重选。最后引用释放后，迟到错误和五秒自愈不能重新启动 watcher。
- 私有快照位于主配置根下的 `turn-changes`，不在项目内：每个输入最近 10 次；已完成记录保留 30 天；不再活动的 recording 遗留超过 24 小时可清理。删除会话先 stopAndDrain。损坏数据保留并报告，单次扫描 10000 条上限必须标记 partial。
- Pi 的 native retry 补丁仍需保留；MCP 有副作用调用与模型任务不能因恢复器失败被自动重放。用户项目 AGENTS 仍只通过已验证显式项目根注入。

## M1 验收结果

原生 Electron 与 Pi 已使用用户提供的第三方 OpenAI Responses 渠道完成真实流式响应、重启续接、MCP、差异恢复、项目记忆、独立预览和受管浏览器交付。真实休眠期间到期的合成提醒只投递一次，用户实测跨应用全局快捷键通过。macOS 验收记录见规格第 26 节。官方 Codex OAuth 已移出此次验收范围。Windows 暂缓。

## S3-02 原切入记录

S3-01 入口在 `apps/electron/src/main/lib/agent-memory.ts`、`agent-memory-targets.ts` 与 `agent-memory.test.ts`。从主进程可验证的会话/工作区归属解析目标；Pi 工具和 renderer 不得传任意根目录或自行声明写入权限。优先接通搜索和读写，再接历史恢复预览和带备份的幂等迁移。受管工作区的旧编辑入口应逐步复用新服务，避免同一实际文件有两套写入语义。

最新 macOS 验证执行 `bun test`，文件为记忆服务、项目指令解析、权限服务、会话管理、Agent 运行环境、逐轮恢复共 6 个，66 pass / 0 fail。全仓库 `bun run typecheck` 的 6 个工作区均通过。Windows 与真实 Electron/模型流程仍待验收。新存储布局和限制见规格第 22 节。

## S3-01 原切入记录

规格依据是 `spec.md` 第 8 节；本节是接手切入顺序，不代表新服务已经实现。

1. 调研并梳理现有记忆读写、迁移和权限调用链，明确哪些逻辑应复用或抽取，避免双写。
2. 固化 `MemoryTarget`/项目身份、revision 和私有历史元数据的版本化类型。区分全局 `user_profile.md` 与现有头像/昵称的 `user-profile.json`；后者不是 Agent 的画像记忆。
3. 先做纯服务：授权根解析、只读 inspect、显式 initialize、带 expectedRevision 的 update/history/restore；正文/JSON 均按工程规则原子提交。具体历史目录布局在这一阶段固化并记入 spec。
4. 目标 ID 按规范化项目真实身份生成，覆盖 Windows 大小写/分隔符别名及链接/根替换。项目记忆按授权主根隔离；附加目录不自动加入记忆扫描范围。无外部项目的受管工作区沿用明确的既有记忆根。
5. 默认全局画像预算为 5000 个 UTF-16 code units；提供用量，超限明确拒绝，不能截断。revision 使用内容 hash；并发旧 revision 返回冲突，保留最新内容。
6. 先补 BDD：正常初始化/读写、空内容、项目隔离、别名去重、根/链接替换、并发 revision 冲突、超预算、损坏历史、原子写失败、只读/计划/自动化/委派上下文不产生越权写入。
7. 最小测试通过后运行类型检查，再更新 spec 和 patch 版本。S3-02 再接工具/UI/迁移；不要提前暴露没有实现的 IPC 或记忆工具。

优先阅读：

- `apps/electron/src/main/lib/agent-workspace-manager.ts`：`getWorkspaceAutoMemoryDir`、记忆 summary/list/read/write、现有 AGENTS 与旧记忆迁移。
- `agent-memory-refresh-service.ts`、`workspace-memory-window.ts`、`workspace-memory-change-watcher.ts`、`config-paths.ts`、`user-profile-service.ts`。
- `project-instruction-resolver.ts`、`project-instruction-migration.ts`、`safe-file.ts`；再查对应 main IPC/preload/renderer 的现有记忆调用。

**已确认的切入风险：** `getWorkspaceAutoMemoryPath` 会调用迁移，`getWorkspaceAutoMemoryDir` 会建目录。新 S3 只读 inspect/readonly/计划上下文不能直接使用这些有写入副作用的 getter。现有 `writeWorkspaceAutoMemoryFile` 有 expectedContent 检查但不是新要求的 revision/history 服务。不要自动删除/合并用户 `CLAUDE.md` 或重写用户项目 `AGENTS.md`；新迁移需要预览、备份、逐项结果和幂等。

S0 的驱动与 SDK 调查仍须补齐。S2/S3 服务实现互不强依赖，可继续 S3 的纯服务和测试，但实机/里程碑门槛必须独立记录，不能用夹具结果替代。

## 最近验证：可以沿用的事实与未覆盖事项

| 检查 | 最近实际结果 |
| --- | --- |
| S2 + Agent 邻接回归 | 159 pass / 0 fail，25 个文件，485 个 Bun 断言 |
| 提交前额外网络回归 | 38 pass / 0 fail，5 个文件，66 个 Bun 断言；与上组分开执行 |
| `bun run typecheck` | 6 个工作区通过；最后 UI 焦点修正后再次通过 |
| `bun run electron:build` | 主进程、utility、preload、renderer、CLI 与资源步骤通过 |
| 最后焦点修正后的 UI | `apps/electron` 内 `bun run build:renderer` 通过；仅既有大 chunk 提示 |
| Windows 本机文件/进程夹具 | 真实文件、Git/worktree、fs.watch、Node bundle、实际 main/preload/terminal-service 链路通过；Electron/PTY/模型 host 有替身 |
| 浏览器组件 | 实际组件与样式下验证恢复预览/确认/冲突、取消零写入、焦点返回、worktree 拒绝/成功空状态、深色 460px 无横向溢出；后端为夹具 |
| 本次交接文档 | 仅检查文档、链接、版本/JSON 和 diff；没有重新运行功能测试，不生成新的“全部通过”记录 |

尚未验证：真实 Electron 原生窗口 + Pi/用户模型 + MCP 的端到端任务、完整 Automation/Collaboration 交互、Windows 安装包、新装/升级迁移、macOS/Linux 实机。最近检查根与应用下的 `node_modules/electron/dist/electron.exe` 均不存在；完整 bundle 构建成功不代表应用可启动。

应用内锁不控制外部编辑器/其它进程，极端外部并发仍须实机复核；文件系统不支持安全排他提交时失败，不加“强制恢复”绕过校验。

### 可重跑命令（PowerShell，工程根执行）

```powershell
Set-Location -LiteralPath 'E:\node_project\Proma'
git status --short
git log -1 --oneline
node -p "process.execPath + ' ' + process.version"
bun --version
```

以下是上次实际选取的两组文件；接手后可复制执行，结果需以当次输出为准。不要将历史 159/38 当作当前新改动的测试结果。

```powershell
$regressionFiles = @(
  './apps/electron/src/main/lib/turn-changes/identity.test.ts',
  './apps/electron/src/main/lib/turn-changes/recorder.test.ts',
  './apps/electron/src/main/lib/turn-changes/node-runtime.test.ts',
  './apps/electron/src/main/lib/turn-changes/run.test.ts',
  './apps/electron/src/main/lib/turn-changes/query.test.ts',
  './apps/electron/src/main/lib/turn-changes/ipc.test.ts',
  './apps/electron/src/renderer/atoms/turn-changes-atoms.test.ts',
  './apps/electron/src/main/lib/git-diff-service.test.ts',
  './apps/electron/src/main/lib/agent-permission-service.test.ts',
  './apps/electron/src/main/lib/project-instruction-resolver.test.ts',
  './apps/electron/src/main/lib/agent-session-manager.test.ts',
  './apps/electron/src/main/lib/agent-runtime-env.test.ts',
  './apps/electron/src/main/lib/adapters/pi-message-adapter.test.ts',
  './apps/electron/src/main/lib/network/network-ipc.test.ts',
  './apps/electron/src/main/lib/adapters/pi-native-retry.test.ts',
  './apps/electron/src/main/lib/turn-changes/restore.test.ts',
  './apps/electron/src/main/lib/turn-changes/operations-ipc.test.ts',
  './apps/electron/src/main/lib/worktree-removal.test.ts',
  './apps/electron/src/main/lib/directory-watch-subscriptions.test.ts',
  './apps/electron/src/main/lib/workspace-watcher-lifecycle.test.ts',
  './apps/electron/src/main/lib/workspace-watcher.test.ts',
  './apps/electron/src/renderer/atoms/turn-restore-atoms.test.ts',
  './apps/electron/src/main/lib/terminal-cwd.test.ts',
  './apps/electron/src/main/lib/adapters/pi-mcp-recovery.test.ts',
  './apps/electron/src/renderer/lib/agent-message-queue.test.ts'
)
bun test @regressionFiles

$networkFiles = @(
  './apps/electron/src/main/lib/network/network-errors.test.ts',
  './apps/electron/src/main/lib/network/network-monitor.test.ts',
  './apps/electron/src/main/lib/network/network-recovery.test.ts',
  './apps/electron/src/main/lib/network/network-diagnostics.test.ts',
  './apps/electron/src/renderer/atoms/network-atoms.test.ts'
)
bun test @networkFiles

bun run typecheck
bun run electron:build
```

没有运行整个仓库的 `bun test` 并得到全绿；早期全量测试曾含缺依赖/基线失败。扩大到全量时需单独区分新增失败与已知基线。

## 环境、已移除工具与构建问题

- Bun `1.3.6`。项目包管理继续使用 Bun；用户明确要求以后使用系统 Node：`D:\Program Files\nodejs\node.exe`，当前 `v24.22.3`。不要改动 Codex 自身托管的内置运行时。
- REA 已卸载：全局 `rea-agents`/命令入口、独立 `Documents\Codex\tools\rea\node-v24.22.3-win-x64`、私有 cli/cache/temp、Node 下载包、Codex/DeepSeek Harness 的 REA MCP 注册与各自 Skill 已删除，专用进程已停止。旧聊天仍显示工具时，重启客户端刷新；不要为普通源码开发进行 REA 连接/doctor/setup。
- Ghidra `12.2`、JDK `25.0.5+8` 和下载包仍在 `C:\Users\12590\Documents\Codex\tools\rea` 中；目录名保留不代表 REA 仍安装。
- 上述客户端配置备份在 `C:\Users\12590\Documents\Codex\2026-11-17\rea-removal`，含 `.codex-config.toml.before`、`.dsh-cordis.patch.yml.before`、组件清单。备份可能含私人设置，不提交到仓库，不直接覆盖新配置或恢复已移除服务。
- 早期依赖安装不完整，Electron 构建曾被 Axios 嵌套代理依赖、highlight.js 主次版本和 Vite/esbuild 链接阻塞。已按 `bun.lock` 从本机缓存修复并构建通过；细节见 spec 第 19.6 节，修复属于 ignored node_modules，不在功能提交中。换机器/干净安装不能假定这些目录已准备好。
- 依赖恢复时保留现有 external 和类型边界。Pi `1.5.2` 的原生重试补丁已由 `0.87.1` 迁移，后续变更需复跑重试分类和 MCP 副作用去重回归。
- Bun 同进程测试曾出现 shared/index.ts 的 `EISDIR` 构建读取错误。相关网络/新操作夹具现用独立 Bun 构建 + Node 子进程隔离，已通过组合回归；不要删断言来跳过，也不要把此错误直接当成生产路径失败。
- 某些受限 shell 会报 Git dubious ownership，可对**这一次命令**使用 `git -c safe.directory=E:/node_project/Proma ...`；不要无关改写全局 Git 配置。若宿主只允许 Documents 写入，写主工程需要走其权限审批，不能改为在另一份仓库里交付。

## 本机证据和历史日志

这些路径是可选历史证据，不是继续开发的前置依赖；实现、测试及规格已在本仓库。

- 对比报告：`C:\Users\12590\Documents\Codex\2026-11-16\https-github-com-morluto-rea-blob\outputs\Proma-0.22.80-vs-0.19.58-对比报告.txt`。
- 详细静态证据：同目录下 `work\proma-compare` 的 `comparison-summary.json`、`static-comparison.json`、`dependency-diff.json`。`rea-evidence-bundle.json` 约 30 MB，只按具体问题有界读取，不整份打印。
- 最近 S2-03 验证：`C:\Users\12590\Documents\Codex\2026-11-17\proma-s2-03` 中的 `regression.log`、`build.log`、`final-typecheck.log`、`final-renderer.log`、结果 JSON 和 UI 截图；验证浏览器与本地 HTTP server 已关闭。
- S2-02/S1 旧日志与准备脚本在同一日期树下；其早期失败不能覆盖较新的通过记录。Documents 中的 `files/`、`before/` 和完整源码准备副本都不能当成主工程。

## 每个后续阶段结束时维护

更新 `spec.md` 的当前状态和相应实施节；本文阶段表、下一任务、最新提交/版本、实际检查结果和未覆盖项也同步更新。遵守每次交付 patch +1、共享包逐项升版、默认 Skill frontmatter 升版的约定。README/tutorial/release notes 若需变动仍按根 AGENTS 取得授权。
