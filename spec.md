# Proma 新版本地能力实施规格

| 项目 | 内容 |
| --- | --- |
| 文档版本 | 1.0.14 |
| 制定日期 | 2026-11-16 |
| 状态 | S1—S4 已形成提交基线，M1 的 macOS 验收通过。下一步为 S5-01，Windows 暂缓 |
| 开发分支 | `dev/new-version-features` |
| 源码基线 | 桌面应用 `0.19.58`；提交 `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf` |
| 参考安装版 | `D:\Program Files\Proma`，桌面应用 `0.22.80` |
| 当前交付版本 | 桌面应用 `0.19.72`、共享包 `0.1.80`，实施与验收记录见第 22—26 节 |
| 首要平台 | Windows；共享逻辑需维持 macOS/Linux 的既有能力 |
| 接手入口 | [当前交接记录](docs/plans/2026-11-17-local-upgrade-handoff.md)，包含 M1 macOS 验收结果和 S5-01 实施入口 |

## 1. 目标与依据

将参考安装版中确认存在的非云端能力，按照当前项目的 Electron、Pi Agent、Bun monorepo 和 Jotai 架构实现。优先形成“稳定执行任务 → 展示每轮文件变化 → 维护本地记忆 → 交付结果”的闭环，再扩展自身界面操作和桌面操作。

本文是实施要求，不是新版源代码的逐文件复原，也不以接口名称完全一致作为完成标准。已有功能应扩展现有服务；新增服务仅在职责、生命周期或状态归属不同的情况下拆分。

### 1.1 对比证据

本规格依据已完成的《Proma 安装版与本地开源版静态对比》。该报告位于本机：

```text
C:\Users\12590\Documents\Codex\2026-11-16\https-github-com-morluto-rea-blob\outputs\Proma-0.22.80-vs-0.19.58-对比报告.txt
```

证据标识及限制：

- 参考 `app.asar` SHA-256：`444ce7b4f3d259a48dc6a196bc60a20cd0d52e0dccd79dd9e732045350c41f1c`。
- REA preload 子集分析父 Evidence：`ev_32af6e85296333c795fc70d7a44ae1d76472a4988fcaed349d1f15d996d71322`。
- 完整 ASAR 分析触及保留容量上限；后续子集分析的应用图和语义图为 partial。跨版本结论另外由完整 preload AST 比对和主进程代码阅读支持。
- 安装版 preload 顶层 API 为 438 个，本地源码为 436 个；有 60 个新增同名属性位置、58 个旧属性不再出现。这些是接口差异，不能直接解释为功能增加/删除数量。
- 报告中的 `main.cjs`、`preload.cjs` 行号指 ASAR 内原始打包文件，不能对应本地 TypeScript 同行号。
- 参考安装版不是经联网确认的全球最新版本；本地源码也不代表官方开源仓库的最新提交。
- 尚未通过运行参考安装版验证性能、权限生效、驱动能力或远程服务行为。未明确的行为必须先补调查，不得把猜测写成产品要求。

### 1.2 已有能力

当前源码已经具备 Pi Agent、MCP、受管浏览器、多 Agent 协作、自动化、语音输入、Office 处理、Git/worktree、工作区记忆及 Vault 等能力。上述能力属于复用和回归范围，不重新实现一套。

## 2. 范围

### 2.1 本期纳入

| 编号 | 功能域 | 差异依据 | 交付阶段 |
| --- | --- | --- | --- |
| FR-NET | 自配模型/MCP 网络恢复与诊断 | 报告第 7 项，`network/*` 与状态/诊断接口 | S1 |
| FR-RUNTIME | Pi 适配与依赖兼容 | 报告第 10 项，Pi `0.87.1 → 1.5.2` | S0/S1 |
| FR-DIFF | 逐轮文件变化、diff、checkout 恢复和 worktree 生命周期 | 报告第 5 项，`turn-changes/*` | S2 |
| FR-MEM | 全局画像、项目记忆、搜索、历史与迁移 | 报告第 4 项，`agent-memory`、`pi-memory-tools` | S3 |
| FR-PRESENT | 最终文件交付物及展示状态 | 报告第 9 项，`Present`、Vault presentation | S4 |
| FR-VAULT | Vault 目录、wiki link、导航与定位 | 报告第 9 项，Vault 新增接口 | S4 |
| FR-LOCAL | 提醒、快捷捕获、目录观察、终端活动及会话设置 | 报告第 9 项 | S2/S4 |
| FR-SELF | Proma 自身界面操作 | 报告第 3 项，`proma-self-controller` 等 | S5 |
| FR-CUA | Windows Computer Use 与窗口预览 | 报告第 2 项，driver/preview/stream | S6 |
| FR-COMPAT | 旧会话、旧 Chat、权限及既有扩展兼容 | 报告第 8 项，接口迁移证据 | 全阶段/S7 |
| FR-SKILL | 本地默认 Skills 的工具说明和升级 | 报告第 6 项，随包工作流差异 | 各阶段/S7 |

### 2.2 明确排除

本期不实现、不引入占位 UI、不新增其运行依赖或自动请求：

1. Proma 云账户、登录/注册、邮件验证码、云通知。
2. Proma 官方模型渠道同步、云端余额、计费、套餐额度、订阅和支付。
3. 云端 API Key 管理、云端模型/token/工具/语音用量报表。
4. 企业 Skills 的云端列表、发布、版本管理和分发服务。
5. `proma-cloud-sdk` 及依赖 Proma 后端的搜索、生图等工作流。
6. 将启动模式切换为 `PROMA_MODE=cloud`，或引入 `packages/cloud`。

现有用户自配模型、OAuth、MCP、网络搜索服务若已在项目中可用，继续维持；“排除 Proma 云服务”不等于禁用现有外部模型和联网能力。现有第三方模型额度查询也不因为安装版的 `planQuota` 接口而重新接入 Proma 计费。

### 2.3 后置事项

- GitHub 变更请求/PR 查询与轮询不纳入首个里程碑；仅可作为后续独立集成，使用用户已有 GitHub 授权，不依赖 Proma 云服务。
- macOS 专属 OCR、权限引导和原生桌面实现不作为 Windows 首发验收项。其他平台能力不可用时要返回明确原因。
- 不因新版缺少旧接口而删除当前 Chat、系统提示管理、Agent Island 或权限服务。
- 不追求所有新版模型选项、视觉资源或默认 Skill 名称一致。`jev-use` 等尚未确认用途和依赖的工作流列为调查项，不默认纳入。

## 3. 工程约束

1. 使用 Bun；不得用 npm/pnpm 修改本项目依赖和锁文件。
2. 仅使用 Pi Agent runtime；保持现有 `SDKMessage`、JSONL 会话和 renderer 兼容边界。
3. TypeScript 不使用 `any`；对象类型优先 `interface`，仅类型引用使用 `import type`。
4. renderer 状态统一使用 Jotai，复用现有 Radix/shadcn primitives 和主题变量。
5. JSON/会话元数据的写入使用 `safe-file.ts` 中的原子写封装；新格式使用 JSON/JSONL，不新增本地数据库。
6. 新增/修改 IPC 必须同步完成 shared 常量与类型、main handler、preload bridge、renderer/Jotai 四层契约。
7. 用户项目指令继续通过 `project-instruction-resolver.ts` 的已授权项目根解析。不得恢复 cwd/祖先目录/附加目录的环境式指令发现。
8. 新增能力接入既有权限服务。安装版旧审批接口的消失，不构成本项目取消审批的依据。
9. 每个实现提交递增受影响交付物 patch 版本；共享包分别递增。默认 Skill 内容变化同步递增 frontmatter `version`。
10. 本文是本次授权的开发文档；README/tutorial/release notes 的更新仍需按项目约定另行确认。

### 3.1 共用请求与生命周期约定

- main 是持久化、窗口控制、驱动和权限判定的权威；renderer 仅展示和发起受控请求。
- 每个可变请求携带明确的 `sessionId`、`workspaceId`、`turnId` 或资源 ID；main 重新检查归属，不能仅信任 renderer 传入的文件路径。
- 复用已有错误和事件协议；必要新增错误要能区分验证失败、冲突、取消、超时、不可用和运行失败。
- 订阅返回释放函数。窗口关闭、会话删除、工作区切换、Agent 停止和应用退出时释放对应 watcher、进程、CDP 会话与流。
- 任何后台回调必须核对所属运行代次，避免已结束任务的结果写入后继会话。
- UI 包含空状态、加载状态、失败重试、键盘操作及深浅色主题；状态改变应有明确可访问标签。

## 4. 阶段、依赖与里程碑

```text
S0 基线与前置调查
 └─ S1 网络与运行时兼容
     ├─ S2 逐轮文件变更
     └─ S3 全局/项目记忆
         └─ S4 本地交付与工作流
             ├─ S5 Proma 自身界面操作
             └─ S6 Windows Computer Use
                 └─ S7 集成与发布
```

该顺序表示交付先后；S2 与 S3 的业务实现互不强依赖。S5 与 S6 共享会话归属、权限和预览约定，但不能把内部 CDP 操作与系统桌面驱动合并为一个控制器。S6 的驱动可用性调查必须在 S0 提前完成。

| 里程碑 | 内容 | 完成门槛 |
| --- | --- | --- |
| M0 | S0 | 基线记录、SDK 适配结论、Windows 驱动结论齐备 |
| M1 | S1—S4 | 自配模型/MCP可恢复；逐轮 diff、记忆、Present 形成可用闭环 |
| M2 | S5—S6 | 自身界面与桌面操作分别通过 Windows 实机验收 |
| M3 | S7 | 安装包验证、兼容迁移、回归和版本检查完成 |

不预设未经验证的工期。S0 完成后，依据 SDK 改动面、构建基线与驱动验证结果估算各阶段工作量。

## 5. S0：基线与前置调查

### 5.1 工作项

- [ ] 记录当前分支、提交、Bun/Node/Electron 版本、依赖安装状态和 Windows 构建环境。
- [ ] 执行现有测试、类型检查和构建，记录预先存在的问题；不把未运行的检查标记为通过。
- [ ] 建立“现有能力 / 新增要求 / 排除项 / 待调查项”清单，落实本文所有 FR 编号。
- [ ] 核对 Pi `1.5.2` 的实际包导出和当前调用点；检查根 `overrides`、桌面依赖、`pi-tui` 与 `pi-ai` 补丁的兼容性。
- [ ] 调查 `cua-driver.exe` 的可信获取途径、允许分发方式、Windows 版本/架构、命令协议、退出与取消行为。
- [ ] 检查现有 Browser CDP 服务可复用的连接/输入原语及自身窗口隔离条件。

### 5.2 产出与决策门槛

基线记录需列出每条命令、结果和已有失败；SDK 记录需列出“保持当前版本 / 局部适配 / 同步升级”的理由。

安装版中的 `1.5.2` 是候选兼容目标，不是可以直接升级的结论。升级三个核心包时，同时核对根 `pi-tui` override 和补丁；不得只修改桌面 package.json。

若驱动尚不可获取或无法验证，S6 保持“外部依赖阻塞”，允许继续 M1/S5；占位 UI 或假预览不算 S6 完成。

## 6. S1：网络恢复与 Pi 兼容

### 6.1 复用与拟新增位置

复用 `proxy-fetch.ts`、`proxy-settings-service.ts`、`oauth-proxy-scope.ts`、`mcp-configuration-service.ts`、`mcp-validator.ts`、`adapters/pi-agent-adapter.ts` 和现有请求扩展。

在职责明确后增设 `main/lib/network/`：连接状态、错误分类、恢复协调、诊断脱敏与导出。浏览器、MCP、模型请求沿用各自的连接实现，通过公共状态协议协作，不强制改成同一种 transport。

### 6.2 要求

- FR-NET-01：区分系统联网提示与模型/MCP端点可达性；浏览器的 online 事件不能直接代表请求服务可用。
- FR-NET-02：维护可观察的连接状态和最近一次失败原因，支持显式检查与重连。
- FR-NET-03：自动重试采用有上限的退避，支持 AbortSignal。认证失败、参数错误、明确拒绝不进行无限重试。
- FR-NET-04：连接恢复不得自动重新执行已经提交的写文件、Shell、MCP mutation 或桌面点击。模型流中断必须区分可续接与结果不确定。
- FR-NET-05：诊断先预览再导出，默认去除 token、Authorization、cookie、密钥和敏感 URL 参数。
- FR-RUNTIME-01：SDK 适配覆盖工具调用、分块输出、图片/工具结果、取消、压缩、历史恢复、模型选项及 Automation/Collaboration。
- FR-RUNTIME-02：SDK 升级独立提交；不为了对齐依赖清单引入云 SDK、axios 或其他无实际需求的包。

### 6.3 IPC 与 UI

新增或等价扩展 `network:get-status`、`network:reconnect`、`network:status-changed`、诊断预览/检查/导出接口。诊断导出使用用户选择的保存位置，返回实际结果。错误提示不得掩盖原始失败，也不得显示密钥。

### 6.4 验收

- Given 已建立模型流，When 网络中断再恢复，Then UI 展示状态变化且不重复执行已完成工具。
- Given MCP 连接断开，When 用户停止会话，Then 取消后不再重连或补发请求。
- Given 端点返回认证失败，When 恢复协调器收到错误，Then 提示修复配置且不循环重试。
- Given 含敏感头和查询参数的诊断，When 导出，Then 敏感值不出现在文件中。
- SDK 升级后，旧 JSONL 会话可恢复；现有模型适配与权限回归通过。

## 7. S2：逐轮变更、恢复与工作区生命周期

### 7.1 实施拆分

1. 定义 turn/file/change 的共享类型与持久化版本。
2. 实现捕获和比较服务；先纯服务及测试，再接入 Agent 工具事件。
3. 接入逐轮摘要和单文件 diff 的四层 IPC 与 renderer 面板。
4. 实现恢复预览/应用和冲突处理。
5. 接入 worktree 移除、目录观察及会话清理。

拟新增 `main/lib/turn-changes/{capture,compare,paths,git,recorder}.ts`，复用 `git-diff-service.ts`、现有 worktree 与 watcher 逻辑。文件名可按现有职责调整，需维持清晰边界。

### 7.2 数据模型

`TurnChangeRecord` 至少包含：schemaVersion、recordId、sessionId、turnId、workspaceId、canonicalCwd、开始/结束时间、完成状态、来源覆盖、限制信息及文件列表。

文件项包含相对路径、变更类型、before/after hash、字节数、内容可用状态和快照引用；不得把文件正文无限制嵌入会话索引。

覆盖必须区分：

- Agent 受控编辑工具捕获到的变化。
- Git 观察到的工作树变化，其来源可能包含外部程序或用户编辑。
- 非 Git 目录中未覆盖的 Shell/外部写入。

不能将“本轮期间观察到变化”都标记为“Agent 修改”。

### 7.3 要求

- FR-DIFF-01：支持新增、修改、删除；重命名根据证据标记，无法确认时保留为增删。
- FR-DIFF-02：处理中文/空格路径、CRLF、空文件、二进制、大文件、Git/非 Git 目录和 worktree。
- FR-DIFF-03：开始阶段确定文件数、单文件字节及总快照容量限制；超限返回明确 partial/omitted 状态，不能无声截断或阻塞 Agent。
- FR-DIFF-04：`getTurnChanges` 与 `getTurnFileDiff` 校验 session/turn/workspace 归属，且只能读取授权项目或明确附加资源。
- FR-DIFF-05：恢复分为预览与应用。应用时核对当前内容 hash 和目标身份，发生后续编辑则返回冲突；不得用全局 `git reset --hard` 覆盖用户工作。
- FR-DIFF-06：恢复保持与本次目标无关的修改和暂存区状态。删除恢复及恢复失败必须有明确结果。
- FR-DIFF-07：worktree 移除先检查活动会话、未提交修改和路径归属，执行后释放 watcher/终端引用。
- FR-LOCAL-01：目录观察按授权根共享或复用，订阅按会话引用计数，删除/切换后释放。

### 7.4 验收

- Given 编辑、写入、删除工具依次运行，When 本轮结束，Then 摘要与各文件 diff 一致。
- Given 有二进制或超限文件，When 查询变更，Then 正文不可预览的原因明确且普通文件仍可查看。
- Given 文件在记录后被用户修改，When 应用恢复，Then 返回冲突并保留用户新内容。
- Given 同一目录被两个会话观察，When 删除其中一个会话，Then 另一个订阅仍正常，最终订阅删除后 watcher 释放。
- Given worktree 含活动会话或脏文件，When 请求移除，Then 按策略阻止或要求明确处理，不静默删除。

## 8. S3：全局画像与项目记忆

### 8.1 复用与拟新增位置

复用 `agent-workspace-manager.ts` 的已有记忆、`agent-memory-refresh-service.ts`、`workspace-memory-window.ts`、`workspace-memory-change-watcher.ts` 和项目指令解析器。

拟新增 `agent-memory.ts`、`memory-search.ts`、`global-profile-memory.ts`、迁移模块及 `adapters/pi-memory-tools.ts`。项目内已有同职责函数需逐步抽取，避免新旧服务同时写同一份数据。

### 8.2 存储与版本

- 全局用户画像：配置根内的 `user_profile.md`；与现有 `user-profile.json` 的 UI 资料明确区分。
- 项目记忆：经 main 解析授权后确定的项目根内 `MEMORY.md` 与 `memory/` 下的 Markdown；无外部项目的受管工作区使用该工作区的既有记忆根。
- 历史版本位于配置根的 `agent-memory/history/<target-id>/<file-key>/<revision>.json`。每份 JSON 保存 schema 版本、目标、文件键、revision、归档时间与原正文。归档文件路径索引保存在 `agent-memory/archived/`，导入备份与幂等状态保存在 `agent-memory/migrations/`。
- 目标 ID 绑定规范化项目身份；Windows 大小写/分隔符差异不能生成重复记忆目标。
- 文本更新使用原子替换，JSON/元数据走 `safe-file.ts`。每次写入核对 expectedRevision，revision 采用内容 hash。

### 8.3 要求

- FR-MEM-01：实现 inspect/initialize/update/search/history/restore/migrate/archive 的本地服务和 Agent 工具。
- FR-MEM-02：全局画像可跨项目复用；项目内容按授权根隔离，附加目录不隐式扩展为记忆扫描根。
- FR-MEM-03：画像默认预算为 5000 个 UTF-16 code units，提供当前使用量；超限拒绝保存并给出整理结果状态，不能静默截断。
- FR-MEM-04：更新和恢复必须携带 expectedRevision；版本冲突返回最新 revision，让调用方重新读取和合并。
- FR-MEM-05：搜索返回文件、行号和有界片段，不引入数据库或远程索引。
- FR-MEM-06：迁移有来源清单、预览、备份、逐项结果和幂等标识；保留无法解析的旧文件。不得自动覆盖/删除 `CLAUDE.md` 或改写用户 `AGENTS.md`。
- FR-MEM-07：用户要求关联项目指令时，通过显式项目根和现有写入边界追加必要链接，保留原文；只读/计划任务不能触发初始化写入。
- FR-MEM-08：Automation/Collaboration 不能因新工具获得额外项目或全局画像修改权限；沿用现有执行来源与审批策略。
- FR-MEM-09：编辑 UI 显示预算、冲突、保存结果和历史恢复预览；初始化不编造用户事实。

### 8.4 验收

- Given 两个项目，When 更新其中一个的项目记忆，Then 另一个项目记忆不变，全局画像依授权一致可读。
- Given 两个并发编辑器，When 后提交者使用旧 revision，Then 拒绝覆盖并返回冲突。
- Given 超预算画像，When 提交更新，Then 原内容不变，UI/工具显示预算信息。
- Given 同一旧记忆重复迁移，When 第二次执行，Then 不重复追加、不丢原文。
- Given 只读、自动化或委派上下文，When 请求受限写入，Then 与既有权限策略一致。

## 9. S4：交付物及本地工作流

### 9.1 Present 与文件展示

- FR-PRESENT-01：新增 `Present` 工具，声明已经存在的最终交付文件及可选说明，不复制、不移动、不执行文件。
- FR-PRESENT-02：记录 sessionId、turnId、资源 ID、授权范围和展示状态，支持前端确认展示/取消。
- FR-PRESENT-03：主进程验证目标为授权范围内的普通文件，检查符号链接/目录联接后的实际路径。校验与打开之间目标变化时返回错误。
- FR-PRESENT-04：UI 展示文件名、类型、说明、打开/定位入口；文件被删除时显示失效状态；按规范化路径去重。

### 9.2 Vault 与浏览器展示

复用 `vault-service.ts`、`file-preview-service.ts`、`detached-preview-window.ts`、`browser-preview-service.ts`。

- FR-VAULT-01：新增目录分页/浏览、打开文件夹、定位文件和导航恢复；大目录不一次性加载全部后代。
- FR-VAULT-02：wiki link 支持明确匹配和歧义候选；不根据模糊名称打开授权根外文件。
- FR-VAULT-03：展示请求与完成/取消回执关联到同一个请求 ID，旧窗口回执不更新后继请求。
- FR-LOCAL-02：补齐受管浏览器预览与展示请求的会话归属和结束清理，复用已有浏览器自动化服务。

### 9.3 提醒、会话和终端

- FR-LOCAL-03：在已有 planning manager/scheduler 上增加提醒创建、更新、删除及快捷捕获；本地保存、重启后恢复，以稳定 occurrence ID 防止重复触发。
- FR-LOCAL-04：时间计算覆盖时区变化、夏令时、系统休眠/唤醒与已过期提醒；实际调度与界面显示使用同一时间语义。
- FR-LOCAL-05：终端新增 Agent 活动事件、保留/释放引用；进程退出或会话删除后不能留下僵尸活动状态。
- FR-LOCAL-06：补齐工作区归档、流会话重新绑定、叙述模式、Codex speed 和渠道移除通知；不支持的模型明确禁用相关选项。
- FR-LOCAL-07：将旧 `codexFastMode` 显式映射到新设置，读取旧值兼容；迁移后保留可恢复的旧记录。
- FR-LOCAL-08：Skill 使用统计只聚合本地实际激活/调用记录；字体即时同步、快捷键重注册、用户资料变更通知按需求接入已有设置服务。
- FR-LOCAL-09：如补齐 changelog 展示，仅使用本地随包资料，不接入云通知或云账户服务。

### 9.4 验收

- Given 授权目录内完成的文件，When Present，Then 当前轮次显示交付卡片且能正确打开/定位。
- Given 目录联接指向授权根外，When Present 或解析 wiki link，Then 拒绝访问。
- Given 重名笔记，When 解析 wiki link，Then 返回歧义而不是任意选择。
- Given 提醒在休眠中到期，When 系统恢复，Then 按明确定义的策略处理且不重复通知。
- Given 终端/会话关闭，When 清理结束，Then 活动计数和订阅都归零。
- Given 老会话使用 codexFastMode，When 新版本读取，Then 映射明确且不导致无法打开会话。

## 10. S5：Proma 自身界面操作

### 10.1 边界与结构

新增 `proma-self-controller.ts`、`proma-self-control-policy.ts` 和 `adapters/pi-proma-self-tools.ts`，复用 CDP 的底层连接与输入原语。控制目标必须来自 main 保存的 Proma 窗口引用，不接受任意端口、URL 或其他应用窗口。

工具按能力拆分为 Observe、Find、Click/Act、Fill、Press、Scroll、WaitFor、Screenshot；是否提供更宽泛 DOM 操作须单独评审，不直接暴露任意 JavaScript 执行入口。

### 10.2 要求

- FR-SELF-01：Observe/Find 返回带观察代次的短期引用；页面重载、新观察或窗口关闭使旧引用失效。
- FR-SELF-02：工具只在明确的用户交互会话中可见；automation、delegation、external 来源默认不注入。
- FR-SELF-03：输入框、密码字段、权限/AskUser 响应、破坏性确认和会触发新 Agent 请求的控件分类保护。不能借自身操作回答自己的审批问题。
- FR-SELF-04：创建项目、执行破坏性操作等仍走既有用户确认；工具通过与否由 main 判定。
- FR-SELF-05：每个会话串行执行写操作，设置递归/重入边界，支持超时和取消；不能点击发送按钮让自身循环发起任务。
- FR-SELF-06：截图及可访问性树按会话交付；对敏感输入内容使用最小输出策略。

### 10.3 验收

- Given 一个新观察结果，When 点击有效引用，Then 在指定 Proma 窗口产生可验证的状态变化。
- Given 页面重载，When 使用旧引用，Then 返回引用失效并要求重新观察。
- Given 自动化/委派来源，When 构建工具集，Then 不包含自身界面操作工具。
- Given 密码、审批或发送控件，When 工具请求操作，Then 阻止不允许的动作，不能替用户审批或触发递归任务。
- Given 等待中取消会话，When 取消完成，Then 不再发生后续输入。

## 11. S6：Windows Computer Use

### 11.1 前置门槛

必须完成 S0 驱动验证：真实可用驱动、兼容架构、协议、分发条件、校验与打包路径已明确。不得仅复制参考安装版中的二进制并假设其可独立工作。

### 11.2 实施步骤

1. 定义平台驱动接口和能力探测结果，先实现 mock adapter 的契约测试。
2. 接入已验证的 Windows 驱动与固定 argv/JSON 调用，支持子进程取消、超时和输出限制。
3. 实现目标选择、窗口身份、观察/截图与基础输入操作。
4. 实现预览、激活、重试、结束和低频截图回退；随后验证流式预览。
5. 接入 Agent 工具、renderer 状态和本地默认 Skill。
6. Windows 安装包验证驱动路径与生命周期，不只在开发环境验证。

### 11.3 要求

- FR-CUA-01：目标身份至少绑定进程与窗口，窗口 ID 被复用后不能继续操作新目标。
- FR-CUA-02：driver 缺失/版本不符、权限不足、窗口消失、锁屏/桌面不可用、超时、截图失败分别返回明确状态。
- FR-CUA-03：点击坐标绑定截图/窗口代次及缩放信息。目标移动、尺寸变化或预览过期时重新观察。
- FR-CUA-04：预览与操作共享同一个 session/target 绑定，切换目标时取消旧流并清空旧状态。
- FR-CUA-05：超时后若动作执行结果不确定，先观察实际状态，不能盲目重试点击/键盘操作。
- FR-CUA-06：窗口关闭、会话停止、应用退出后释放进程、截图流和临时资源。
- FR-CUA-07：截图内存与传输有明确预算，慢消费时丢弃过期预览帧，不无限堆积。
- FR-CUA-08：沿用权限/用户授权边界；macOS 专属文字识别不包装成已经支持的 Windows 能力。

### 11.4 验收

- Given 可用 Windows 目标窗口，When 观察和执行基础输入，Then 预览和输入落在同一目标。
- Given 窗口关闭后 ID 被复用，When 使用旧绑定，Then 拒绝操作并要求重新选择。
- Given 驱动缺失或桌面锁定，When 发起操作，Then 明确显示不可用原因，不出现假成功。
- Given 多显示器/DPI 缩放，When 在观察后点击，Then 坐标转换正确；无法确定映射时拒绝动作。
- Given 慢 renderer 或中断连接，When 预览持续产生，Then 内存有界且能停止清理。

## 12. S7：兼容、Skills 与发布

### 12.1 兼容与迁移

- 保持旧 Chat 读写路径及其 UI；如增加 legacy summary/list/prepare 接口，先做到只读/显式迁移，不替换现有入口。
- 不自动删除旧系统提示、自定义工具、Agent Island 和代理设置。
- 保留 `respondPermission`、权限模式及计划退出流程；任何重构都需提供等价权限回归。
- 旧元数据迁移使用版本字段和幂等标识；先备份后写入，失败保留来源并给出逐项结果。
- 历史数据恢复与程序回退分开验证；提交回退不能代替磁盘数据恢复。

### 12.2 默认 Skills

| 工作流 | 本期策略 |
| --- | --- |
| `cua-driver-cli` | 驱动协议验证后新增，与实际 Windows 能力一致 |
| `proma-self-control` | S5 工具通过验证后新增 |
| `proma-build-in-proma-app` | 调查依赖，仅本地可实现部分后置纳入；不可暗中依赖云 API |
| `jev-use` | 用途和依赖未确认，调查后另定范围 |
| `proma-cloud-sdk` / `proma-web-search` / `proma-gpt-image-25` | 本期排除依赖 Proma 后端的实现 |
| 当前 `knowledge-maintenance` / `tool-builder` | 不因参考包缺失而删除；按新记忆和工具接口更新说明 |
| 现有 collaboration/automation/browser/Office Skills | 工具契约变化时同步更新并递增版本 |

### 12.3 发布验收

- [ ] 新安装：无需 Proma 云账户，可使用用户自配模型和本地能力。
- [ ] 升级安装：旧配置、会话、工作区、记忆和权限设置保持可读。
- [ ] 至少覆盖一个自配模型、一项 MCP 工具、受管浏览器、Automation 和 Collaboration 的完整流程。
- [ ] 文件 diff、恢复冲突、全局/项目记忆、Present、自身操作及 Computer Use 分别通过对应验收。
- [ ] Windows 打包产物中运行依赖、native helper、默认 Skills 路径正确。
- [ ] 非 Windows 平台共享逻辑无新增类型/导入错误，缺失平台能力有明确状态。
- [ ] 本期新功能没有请求 Proma 云服务，也没有引入登录/支付 UI。
- [ ] 所有未完成的平台项、外部依赖阻塞与基线失败明确列出，不写成通过。

## 13. 实施提交建议

每行可以拆成多个提交；不得把需要独立回退的 SDK 升级、数据迁移和 UI 大改合为一次提交。

| 任务 | 内容 | 前置条件 | 必要验证 |
| --- | --- | --- | --- |
| S0-01 | 基线、差异清单、SDK/驱动调查 | 当前分支 | 记录真实运行结果 |
| S1-01 | 网络错误分类、取消与恢复协调 | S0-01 | 单元/故障注入、类型检查 |
| S1-02 | 网络 IPC、状态 UI、脱敏诊断 | S1-01 | 四层契约、取消及导出测试 |
| S1-03 | 经论证必要的 Pi 适配/升级 | S0-01 | 适配回归、electron:build |
| S2-01 | turn 数据类型、捕获、比较、持久化 | M0、S1兼容接口稳定 | Git/非 Git、限额、异常清理 |
| S2-02 | diff 面板和四层 IPC | S2-01 | 归属验证、UI 空/错/加载状态 |
| S2-03 | 恢复、worktree 与目录观察 | S2-02 | 冲突、脏目录、引用计数 |
| S3-01 | 记忆目标、revision、历史存储 | M0、S1兼容接口稳定 | 并发/隔离/原子写 |
| S3-02 | 记忆工具、UI、迁移 | S3-01 | 权限、预算、迁移幂等 |
| S4-01 | Present、Vault 与浏览器展示 | S2/S3稳定 | 路径边界、展示回执 |
| S4-02 | 提醒、终端、会话与设置增强 | S1/S2 | 时间语义、旧值映射、生命周期 |
| S5-01 | 自身 CDP 控制器与策略 | M1 | 引用代次、控件保护、重入 |
| S5-02 | 自身 Agent 工具与 Skill | S5-01 | 执行来源、实机验证 |
| S6-01 | Windows 驱动 adapter 与工具 | 驱动门槛完成、M1 | 协议、取消、窗口身份 |
| S6-02 | 桌面预览/流及 Skill | S6-01 | DPI、慢消费、安装包路径 |
| S7-01 | 兼容回归及本地发布验证 | M2 | 完整测试、构建、安装包冒烟 |

## 14. 测试执行规则

实现提交首先运行最小相关 BDD 测试，再运行类型检查。涉及 Agent 工具、权限或上下文路径时，补充工作区隔离、附加目录、指令解析、会话恢复及 Automation/Collaboration 回归。

项目根命令：

```bash
# 某项变更对应的真实测试文件；新服务在实现时新增同名测试
bun test apps/electron/src/main/lib/agent-permission-service.test.ts
bun test apps/electron/src/main/lib/project-instruction-resolver.test.ts
bun test apps/electron/src/main/lib/agent-session-manager.test.ts

# 基线、阶段集成和发布验收
bun test
bun run typecheck

# 运行时依赖、external 或打包规则发生变化后必须执行
bun run electron:build

# Windows 发布产物验证
bun run dist:win
```

具体操作场景需要 mock 时，用本地 HTTP/WebSocket/MCP fixture 和临时 Git 仓库；不依赖真实付费服务或私人账户。fixture 与真实驱动/实机测试分别记录，mock 通过不能替代实机验收。

纯文档变更不运行应用功能测试；本次只校验文档完整性、版本、JSON 有效性和 git diff。以上命令是后续实施要求，不表示本次已经运行通过。

## 15. 完成定义与状态维护

每个任务只有同时满足以下条件，才能把 checkbox 标记为完成：

1. 实现、shared 类型、四层 IPC 和调用侧一致；未使用的接口不提前暴露。
2. 正常路径与主要边界的可执行测试通过，新增的失败与基线问题清楚区分。
3. 持久化、版本迁移、权限及资源清理按本文验收。
4. UI 具备必要状态与可访问交互，不包含无实际功能的成功提示。
5. patch 版本与默认 Skill 版本按工程约定递增。
6. 提交前检查 diff，不覆盖用户改动、不混入云服务或无关依赖。
7. 在本文任务下记录实施提交、验证命令、结果和未解决事项。

有外部阻塞的任务保持未完成并记录具体条件。M1 可以独立交付；完整计划只有在 M3 通过后完成。

## 16. 首批实施记录（2026-11-16）

### 16.1 环境与基线

| 项目 | 实际观察 |
| --- | --- |
| 分支/基准提交 | `dev/new-version-features` / `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`；当前修改尚未提交 |
| 本批桌面版本 | `0.19.60`，同步 `bun.lock` 工作区版本元数据 |
| Bun / Node | Bun `1.3.6`、Node `24.14.1`，Windows x64 |
| Electron | package 声明 `43.2.0`；本地依赖的 Electron 二进制尚未准备完成，不能记作实机验证 |
| 初始依赖状态 | 根目录没有 node_modules，测试先完成 302 pass / 21 fail / 19 errors；失败中包含大量缺失依赖 |
| 初始类型检查 | `bun run typecheck` 因没有 tsc 失败 |
| 初始构建 | `bun run electron:build` 在准备 OfficeCLI 时下载失败；沙箱外重试下载仍停滞 |
| 依赖安装 | 两次完整 frozen-lockfile 安装停在 app-builder-bin 大文件下载，已结束停滞进程；`bun install --frozen-lockfile --ignore-scripts --filter @proma/shared` 成功完成类型工具链接；不能把完整桌面依赖记为安装成功 |

OfficeCLI 已从本机参考安装目录复用：大小 `33386408`、SHA-256 `760696b262f3d6bd2cd174577220d54541b6e1e04ec58dee051f1897395638b8`，与项目固定资源完全一致。构建脚本已确认资源有效；随后构建因缺少 esbuild 可执行链接停止。资源位于既有 gitignore 目录，不提交二进制。

### 16.2 已落地代码

- `network/network-errors.ts`：有界 cause 链分类，区分取消、认证、权限、余额/配额拒绝、配置、TLS、限流、超时和瞬时连接错误。永久失败优先于外层通用 fetch 文案。
- `network/network-recovery.ts`：有限次数指数退避、AbortSignal 传播和解绑、可取消的共享握手等待；有副作用操作不得由恢复器自动重放。
- `adapters/pi-mcp-tools.ts`：只读 tools/list 可以有限恢复和重新握手；tools/call 遇到 HTTP Session 拒绝时使旧连接失效并报告结果未确认，不自动重放；后续显式调用可重新建立连接。
- 预先取消、握手等待中取消、dispose 后迟到握手，都不会派发后续工具动作；取消某个等待者不取消其他调用共享的连接准备。
- 修复基线中 3 处 retired provider 类型声明不一致：保持旧值的清理/展示兼容，不将旧供应商重新加入可创建类型，不改变迁移行为。

本批只改 main 服务与测试，没有提前暴露未实现的 network IPC 或 UI。S1-02 的状态界面、诊断脱敏/导出，以及后续功能均未实现。

### 16.3 真实验证结果

| 检查 | 结果与覆盖 |
| --- | --- |
| 网络模块、MCP 恢复、既有 Pi native retry 与 error-patterns 定向测试 | 80 pass / 0 fail，5 个测试文件；其中新增 30 项测试 |
| MCP 本地 HTTP fixture | 验证 503 恢复、404 不重放、预先取消、握手中取消和 dispose；不访问真实用户 MCP |
| Node 共享握手 fixture | 用 Bun.build 打包同一 manager 后由真实 Node 执行，验证两个调用共享一次握手，一个取消后另一个只执行一次工具 |
| Bun HTTP 差异 | Bun 1.3.6 在延迟初始化响应/并发取消场景出现停滞及失败测试后的 native crash；共享握手场景因此使用 Node fixture。单独 Node 探针与持久化测试均通过，未替换系统 Bun |
| `bun run typecheck` | 6 个工作区全部通过；先前的 3 处 retired provider 类型错误已修正 |
| main MCP 模块 Node bundle | `bun build .../pi-mcp-tools.ts --target=node --format=cjs` 成功，717 modules；不等价于整应用构建成功 |
| 首轮依赖补齐后的全量 `bun test` | 501 pass / 5 fail / 1 error，77 个文件；当时尚未加入最后几项扩展测试，不作为最终全量通过记录 |
| `bun run electron:build` | OfficeCLI 验证通过，随后 esbuild executable 缺失失败；完整构建仍待完成 |

全量失败均发生在本批未修改的功能路径，需在干净、完整依赖环境复核后才能确定归因：

1. `.xlsm` / `.ppsx`：officeparser 的 `fileType is not a function`。
2. planning-manager：测试需要独立 Electron Node 进程，当前 Electron 路径未准备完成。
3. update-cache-cleanup：chmod 权限拒绝假设在 Windows 不成立，清理成功后测试再次 chmod 已删除路径报错。
4. compaction-progress：parse5 所需 `entities/escape` 未解析，属于待完成的依赖验证项。

测试日志留在本机临时目录的 `proma-s0-*` / `proma-s1-*` 文件中；后续每次执行需单独保留结果，不覆盖为“已通过”的笼统状态。

### 16.4 SDK 与驱动调查结论

- 已确认源码使用 Pi `0.87.1`，参考安装包三个核心包为 `1.5.2`，候选包声明 Node `>=22.19.0`，仍有 compat/rpc-entry 等导出；完整 API 迁移矩阵尚未完成。
- 当前 `pi-ai@0.87.1` 带有本地网络错误补丁，安装后的 retry.js 已确认包含补丁项；现有 Pi native retry 测试通过。本批保持 `0.87.1`，不为了 MCP 恢复升级 SDK；升级继续作为 S1-03 独立任务。
- 已定位[官方 cua-driver Rust workspace](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/README.md)，确认上游有 Windows UIA/capture/input 实现及 Cargo 构建入口。
- 本机 PATH 未发现独立 cua-driver；参考安装目录的 bin 只有 proma.exe。驱动的固定版本获取、分发条件、实际协议和 Windows 实机能力尚未验证。S6 保持前置调查状态，不能记为可交付。
- 现有 `browser-cdp.ts` 已有命令超时和取消边界，可供 S5 复用；自身窗口权限、目标隔离及重入策略尚未实现。

### 16.5 下一步与未完成门槛

1. 完成桌面依赖和 Electron/esbuild 准备，重跑完整构建与全量测试，逐项确认既有失败。
2. S1-01 代码与定向验证已落地；完整集成门槛未通过，暂不标记 M0/M1 完成。
3. 进入 S1-02：共享网络状态类型、main IPC、preload、Jotai 状态 UI、诊断预览/脱敏/导出；继续遵守四层契约。
4. S2—S7 尚未实施；不因为本批测试通过提前勾选后续任务。

## 17. 第二批实施记录（2026-11-16）

### 17.1 范围与版本

本批落地 S1-02 的主进程 HTTP/MCP 状态、受控渠道检查和诊断预览/导出。第 16 节保留首批执行时的历史状态；以下记录更新当前进度。桌面应用版本递增至 `0.19.61`，共享包递增至 `0.1.74`，`bun.lock` 同步工作区版本；没有新增依赖或升级 Pi。

### 17.2 实现

- shared 定义网络状态、失败分类、检查请求、诊断报告和 IPC 通道；main、preload、renderer 已同步接入。
- 主进程记录经过公共 fetch 封装的 HTTP 响应和 MCP 握手/关闭/错误。系统 online/offline 只作为提示，不据此伪造端点成功。并发观测有代次检查，最多保存 32 个匿名端点。
- 设置中的代理页面增加“网络状态与诊断”。使用 Jotai 保存快照与预览，复用现有设置容器、Button 和主题变量；提供空状态、检查中/取消/失败提示、键盘可用的渠道选择和可聚焦的 JSON 预览。
- 检查仅接受已有渠道 ID；main 重新读取配置并剥离 URL 用户信息、路径、查询和片段，仅向 origin 发送 HEAD，不携带模型认证、不跟随重定向，使用有效代理设置，期限 4 秒。HTTP 401/403 等响应表示网络可达，不表示模型认证成功。
- 检查取消与窗口销毁绑定。取消不等待忽略 signal 的上游请求完成，迟到响应不能改成成功；错误请求 ID 不会停止当前检查。超时与用户取消分别显示。
- main 只接受当前主窗口的主 frame 调用，状态事件只发回主窗口。preload 订阅可释放；renderer 卸载时移除订阅、系统事件并取消其检查。应用退出时解除监控订阅和 IPC handler。
- 诊断按白名单生成，仅含版本、时间、系统联网提示、匿名端点 ID、来源、状态、HTTP 状态码与失败分类；不包含 URL、渠道名、原始错误、凭据、请求头、响应正文或工具参数。
- 预览由 main 缓存并绑定窗口和随机 ID，有效期 10 分钟。导出只接受预览 ID，通过原生保存对话框选择路径，使用 `writeTextFileAtomic` 写入相同快照。取消不写文件；弹窗等待期间新建预览或旧预览失效时拒绝写入。

### 17.3 验证结果

| 检查 | 本批结果 |
| --- | --- |
| 网络、MCP 恢复、Pi native retry、error-patterns、OAuth proxy scope、Jotai 状态定向测试 | 100 pass / 0 fail，10 个文件，157 个断言 |
| 权限、项目指令解析、会话管理、Pi 代理隔离和代理设置回归 | 36 pass / 0 fail，5 个文件，87 个断言 |
| `bun run typecheck` | 6 个工作区全部通过 |
| 实际 main handler + 实际 preload 的 Node fixture | 通过；覆盖 sender/frame 校验、渠道读取、无认证 HEAD、事件解绑、预览快照固定、取消导出、原子写入、旧预览拒绝、检查取消和迟到结果 |
| `bun run electron:build` | 已用本地同版本 `@esbuild/win32-x64@0.24.2` 恢复被中断安装遗漏的命令入口；OfficeCLI 验证通过。构建进一步暴露缺失嵌套依赖：Axios 需要 `https-proxy-agent@5`，当前错误回落到根目录的 v9，报 default export 不匹配；完整构建仍失败 |
| Electron 实机界面、原生保存对话框、深浅主题视觉检查 | 未完成；fixture 的 Electron host/dialog 是替身，不作为实机验收 |

测试日志：本机临时目录中的 `proma-s1-02-tests.log` 和 `proma-s1-02-boundaries.log`。本批没有再次运行全量测试；第 16.3 节的全量基线失败仍待完整环境复核。

再次尝试 `bun install --frozen-lockfile --ignore-scripts --filter @proma/electron`：沙箱内被临时目录写权限拒绝；获准后在沙箱外启动，解析/提取 2 项后长时间无进展，已通过该执行会话发送中断结束。本次未将完整依赖安装记为成功，也未修改锁文件中的依赖版本来规避构建错误。esbuild 入口修复位于忽略的 node_modules 内。

### 17.4 剩余边界与后续顺序

1. 当前报告的 `scope` 明确为 `main-process-http-and-mcp`。Pi utility process 内部的模型流和浏览器 transport 尚未接入主进程状态汇总，不能据此声称所有模型流均已监控。
2. 本批实现显式“检查连接”；没有暴露会直接拆除活跃 MCP 连接的“强制重连”按钮。安全重连继续沿用 S1-01 的只读恢复与后续显式工具调用；独立重连操作及模型流中断状态仍需补充，S1 整体验收保持未完成。
3. S1-03 保持独立：先完成 Pi API/补丁/会话兼容矩阵，再决定必要适配或升级，不直接更改到安装版版本。
4. 桌面依赖、构建和实机门槛未通过，M0/M1 尚未完成；S2—S7 尚未落地，不能把第二批测试通过当成后续阶段完成。

## 18. 第三批实施记录（2026-11-17）

### 18.1 交付范围与版本

本批进入 S2-01，新增共享的 turn/file/snapshot 数据契约与 main 的纯本地捕获、比较和持久化服务。不升级 Pi、不新增依赖。桌面应用递增至 `0.19.62`，共享包递增至 `0.1.75`，锁文件仅同步工作区版本。

这不是逐轮 diff 功能的完整交付：服务尚未接到 Agent 工具与会话生命周期，未新增 renderer/IPC、恢复操作或 worktree 删除。S1-03、M0/M1 和 S2 整体验收仍未完成；先行验证独立服务不意味着跳过这些门槛。

### 18.2 底层服务与语义

- `turn-changes/{paths,capture,git,compare,store,recorder}.ts` 提供 begin、受控工具执行前 captureBefore、finish、按归属读取记录和文本快照。
- 每条记录包含 schemaVersion、recordId、sessionId、turnId、workspaceId、canonicalCwd、开始/结束时间、完成状态、覆盖范围、限额、部分结果原因和文件变化。
- Git 使用只读 inventory，比较的是本轮捕获的工作树内容。原有未提交修改与暂存区均不回写；支持工作区子目录和 linked worktree，不将 HEAD 内容冒充轮初快照。
- 非 Git 仅捕获明确声明的文件或 captureBefore 注册的文件，不扫描未知 Shell/外部写入。`controlled-tool` 与 `git-observed` 表达采样来源，都不证明 Agent 是唯一编辑者。
- 轮末新发现、轮初没有快照的 Git 路径标为 unknown/not-captured。例如文件可能原先被忽略，不能一律认定为新增。受控工具运行前确认不存在的文件可以可靠标为 added。
- 支持新增、修改、删除、空文件、原始 CRLF/BOM、中文/空格路径、二进制标记和 hash 比较。重命名未取证，暂保留增删或未知。
- Windows 相对路径按大小写折叠去重，拒绝越界、Git 内部目录、ADS、设备名和不稳定的尾点/尾空格别名；目录联接/符号链接不能让捕获或快照读取越界。
- 缺失、非普通文件、不可读、读取期间变化、单文件超限或预算不足分别记录，不能无声截断正文。文本读回校验原始字节 hash 和长度，二进制不作文本返回。

### 18.3 限额、持久化与生命周期

| 默认限额 | 数值 |
| --- | --- |
| 单轮候选文件 | 500 |
| 单文件字节数 | 1 MiB |
| 单轮前后捕获总字节预算 | 16 MiB，空文件可用 |
| 每次 Git 输出 | 1 MiB |
| 每次 Git 命令期限 | 5 秒，可取消 |
| 同一 recorder 活跃轮次 | 8 |

所有限额可在构造服务时向下或在硬上限内调整；非法值提前拒绝。超限使用 partial/limitations 表达；非 Git 未覆盖外部写入还会由 coverage 单独声明，不能把 partial=false 理解为全目录覆盖。

拟由 main 在用户配置根下显式传入独立 `turn-changes` 私有目录，不能接受 renderer 提供的存储根。当前服务布局：`<storageRoot>/<recordId>/record.json` 和 `snapshots/<sha256>`。配置根的实际接线、会话删除后的清理及保留策略在 S2-02/S2-03 完成。

正文与索引分离。快照只按受限 hash 引用，JSON 元数据使用 `safe-file.ts` 的原子文本写封装；失败不发布新元数据，并清理本次未发布的新 blob。初始 before 已持久化，因此进程中断后仍能读取 completion=recording 的记录，不冒充正常完成；本批未实现进程重启后的自动继续捕获。

同一轮的 captureBefore/finish 串行，重复结束和归属不匹配会被拒绝。预先取消不会启动采样，完成期间取消保留已知快照并标记 cancelled/partial。结束或异常时释放活动引用；Agent 停止、会话删除和退出时自动调用收束的接线留待下一批。记录与快照读取核对 session/turn/workspace 三重归属；后续 IPC 仍须在 main 重新验证会话授权。

### 18.4 验证与剩余项

| 检查 | 结果 |
| --- | --- |
| 准备目录最小 BDD 测试 | 23 pass / 0 fail，2 个文件，104 个断言；包括真实 Git、worktree、目录联接与 Node 子进程 |
| 准备目录类型检查 | 通过；复用项目锁定的 TypeScript，由 Bun 脚本调用 tsc，未安装新依赖 |
| 写回项目后最小相关测试 | 53 pass / 0 fail |
| 写回项目后类型检查 | 6 个工作区全部通过 |
| Electron 界面、完整构建与发布 | 本批未完成；第 17 节的嵌套依赖/构建问题仍待完整环境复核 |

测试覆盖 Git 脏工作树与 index 保留、授权子目录、linked worktree、非 Git 未覆盖范围、Unicode/CRLF/BOM/空文件、二进制、容量上限、取消、活跃上限、所有权、并发结束、损坏快照与目录替换。准备目录不等于原工程全量验收。

下一批优先将采样挂到 Pi 受控工具的执行前/后边界及会话 finally，并完成查询四层契约和逐轮 diff UI；然后实现带 hash 冲突检查的恢复预览/应用。不能直接把已有基于 HEAD 的 revertFile 接到逐轮恢复，也不能使用 git reset --hard。

写回后验证日志：本批准备目录中的 project-tests.log 与 project-typecheck.log。补丁应用前保留了原工作区文件备份；未创建提交。

## 19. S2-02 实施记录（2026-11-17）

### 19.1 范围与版本

本批将 S2-01 接入实际执行路径，新增按轮次查询的四层契约与消息底部的快照 diff 面板。原工程目录为 `E:\node_project\Proma`，分支 `dev/new-version-features`。应用版本递增至 `0.19.63`，共享包至 `0.1.76`；未增加依赖、升级 Pi 或引入 Proma 云服务。

临时准备与组件验证在本机 Documents/Codex 目录完成；写回时逐文件验证原内容 hash，并对大文件接线重新在原工程现状上重放窄范围变更，避免覆盖已有工作区修改。临时 harness、编译输出与截图不纳入工程补丁。

### 19.2 执行与生命周期

- 主进程确认工作区、项目根和有效 worktree 后启动采样；未绑定工作区时不扫描 home。主采样根使用项目文件根或活动 worktree，工具相对路径仍按实际 runtime cwd 解析。
- 只在原 canUseTool 返回 allow 后采样，使用最终 updatedInput，并等待 captureBefore 完成后才返回许可。不改变原权限决策；拒绝、取消及旧代次许可不会触发后续工具。
- Write/Edit/MultiEdit/NotebookEdit 的主根内文件可受控捕获；根外授权资源只标注 additional-root-not-captured，不扩大目录扫描范围。Git 观察仍不能证明 Agent 是唯一编辑者。
- Pi 接纳用户输入后，通过新的可选 onUserTurnStarted callback 通知主进程。空 Skill 输入也登记 UUID，重复文本 FIFO、失败入队 discard 语义保留；Skill 归因回调仍只处理非空 Skill 激活。
- 接纳追加输入时，主进程先收束前一轮，再开始新轮；下一次工具许可等待这个边界，避免把追加消息后的文件修改写到上一条输入的记录。旧输入 UUID 的迟到回调不会切回旧轮。
- 正常结束、错误结束与 finally 均幂等收束；完成事件在快照落盘之后发送。失败任务在本代次仍有效时读取 after，取消或失去代次时不采样后继任务的写入。
- stop 对指定 session/generation 中止采样并等待收束；stopAndDrain 的删除屏障覆盖这部分等待。退出时先中止所有采样，再给出最多 5 秒的收束窗口；超时保持原子文件和未完成状态，不无限阻止退出。
- 模型/工具执行失败不因诊断采样失败被隐式重放。采样失败标明未覆盖，任务可以继续；没有记录时 UI 不声称“没有改动”。

### 19.3 查询与界面

- shared 新增 TurnChangesQuery、TurnFileDiffQuery、TurnFileDiff 和 LIST/GET_DIFF/CHANGED 通道；main、preload、renderer 同步接入。
- main 仅允许当前主窗口主 frame 调用。sessionId 必须对应仍存在且未删除的会话；workspaceId 从主进程 metadata 解析，不接受 renderer 提供的根目录。读取结束后再次核对会话归属。
- 私有 turn-index 以 workspace/session/turn 三重身份 hash 定位，最多列出同一输入最近 10 次记录，不扫描整个项目或全部快照目录。较旧正文暂保留在本地，保留策略及删除会话后的物理快照清理仍属 S2-03 待办。
- GET_DIFF 只读取该记录列出的文件与受限 SHA-256 快照引用；不读取当前磁盘文件作为回退。缺失文件侧可为空文本，二进制、超大或未捕获侧保留不可用原因。
- 未收束记录中的 files 属于轮初候选集，查询侧隐藏这些候选，不冒充已发生的文件变化；记录仍显示未完成状态，原始 before 仍保留。
- 消息底部保留原文件 chip，并增加“查看本轮文件差异”：记录选择、文件列表、执行状态、覆盖说明、partial 原因、统一/左右 diff、空状态、加载、失败重试。
- 复用消息自身 BasePathsProvider 的 sessionId，嵌入子会话不借用全局当前会话。展示状态使用独立 Jotai atom；按 session/turn 生命周期隔离，文件或列表乱序响应不能覆盖新选择。
- 面板展开后订阅归属匹配的 CHANGED 通知并刷新，收起/卸载时解绑。preload 订阅返回释放函数；主进程退出时移除监听与 IPC handler。

### 19.4 验证

| 检查 | 结果 |
| --- | --- |
| 准备目录定向 BDD | 执行接线、私有索引、查询、IPC/preload 与 Jotai 状态测试通过；最终合并后结果以下方原工程检查为准 |
| Node host fixture | 实际 utility facade、服务注册表、权限包装、记录服务、main handler 和 preload 执行；Electron host、会话读取和模型工具执行使用本地替身，不访问真实模型 |
| 生命周期 fixture | 追加输入分轮、按代次停止不误伤新 run、退出收束、事件解绑、已删除会话不可查询、磁盘后续编辑不改变快照 |
| 组件浏览器验证 | 实际 PanelBody/Button/DiffView、Tailwind 与主题变量；验证浅/深色、460px 窄窗口、键盘展开/重试、加载/空态、二进制及缺失快照；后端与消息上下文为夹具 |
| 写回项目后最小相关测试 | 102 pass / 0 fail，15 个文件；见 final-regression.log |
| 写回项目后类型检查 | 6 个工作区全部通过（依赖修复后复核） |
| 写回项目后完整构建 | 通过（依赖修复后复核） |
| Electron + 真实 Pi/模型实机流程 | 未验证；host fixture 与浏览器组件验证均不能替代 |

准备目录截图为 `ui-light.png` 和 `ui-dark-narrow.png`，测试用临时浏览器会话与 HTTP server 均已关闭。没有安装新依赖或使用真实模型凭据。

### 19.5 后续门槛

1. 完整构建现已通过；Electron 原生运行环境、真实模型与发布包仍需验证。本次未放宽 external 或修改 SDK 版本。
2. 本批不提供恢复按钮；S2-03 继续实现 hash 冲突校验、恢复预览/应用、worktree/watchers 生命周期与快照保留/删除。
3. 附加目录、Shell/MCP 对非 Git 文件的未知写入不作为“受控工具捕获”承诺；UI 明确展示覆盖范围。
4. S2-02 代码已接入，不等于 M0/M1、完整 S2 或 S7 发布验收完成。真实模型、MCP、Automation/Collaboration 的完整实机流程仍需在可运行的 Electron 环境复核。

写回后验证日志：本批准备目录中的 project-tests.log 与 project-typecheck.log。补丁应用前保留了原工作区文件备份；未创建提交。


### 19.6 本地依赖布局复核

冻结锁文件的 production 安装完成（32 个包），但没有修复 Axios 的嵌套代理依赖；它还使本地根 highlight.js 解析到 Pi 所需的 10.7.3，导致 core/ui 类型检查失败。没有通过添加 any 声明或调整 external 掩盖这些错误。

随后从本机 Bun 缓存按锁文件恢复了四个明确目录：Pi coding-agent 私有 highlight.js 10.7.3、根 highlight.js 11.11.1、Axios 私有 https-proxy-agent 5.0.1 及其 agent-base 6.0.2。原目录在 node_modules 内留有备份；未修改依赖版本、SDK 补丁或锁文件。以上是本机 node_modules 修复，未纳入源码提交。

后续又恢复了 Vite 6.4.3 的本地命令入口和其锁定的 esbuild 0.25.12 / Windows binary 子依赖。主进程、utility、preload、renderer、CLI 和资源步骤均由原 electron:build 脚本验证，没有改构建命令或 external 清单。

本节表格已更新为依赖修复后的实际结果；日志为 post-repair-build.log、post-repair-typecheck.log、post-repair-tests.log。测试额外复核既有 Pi native retry 补丁，避免依赖恢复丢失网络补丁。完整 Electron 界面、真实模型/MCP 与发布包仍未验证。

### 19.7 重试身份与旧代次屏障

手动重试不新增用户消息。本批按错误 UUID 通过 session-core 的既有 turn 分组查找原输入，并验证与本次重试的原始文本一致；未知、不一致或缺失输入 UUID 时不猜测归属。该 ID 仅供快照关联，不改既有 onRunStarted/用户消息持久化语义。

新代次的采样开始前会中止并等待同会话旧采样收束，避免同一输入立即重试时占用旧 reservation。只有仍持有 active slot 的新代次可以收束旧采样，迟到的旧预检不能中止新 run。等待使用 5 秒上限，不让采样无限阻止 Agent 启动。

可执行测试覆盖重复文本按 UUID 归属、工具结果排除、未知/不一致输入、旧代次占位、新代次接续及迟到旧预检隔离。

最终回归中，网络 IPC 的 Bun.build 在大组合测试中重复报告 shared/index.ts 的 EISDIR 读取错误；入口仍为普通文件，定向与多个小组合均通过。现将该夹具的构建迁至独立 Bun 进程，隔离测试模块 mock 与构建缓存；断言和实际 Node/main/preload 验证保留，不改生产代码。修复后同一组完整回归通过。最终测试日志为 final-regression.log，构建与类型检查日志仍为 post-repair-build.log、post-repair-typecheck.log。


## 20. S2-03 实施记录（2026-11-17）

### 20.1 范围与版本

原工程 `E:\node_project\Proma`，分支 `dev/new-version-features`。应用版本 `0.19.64`，共享包版本 `0.1.77`，规格版本 `1.0.5`。本批没有增加依赖、改动锁文件或 SDK 版本；保留原工作区已有的 S1/S2 改动，未创建提交。第 18/19 节是先前批次的历史状态，本节补齐其中列出的 S2-03 代码待办。

实现位置：`turn-changes/restore.ts`、`restore-files.ts`、`operations-ipc.ts`，以及 `worktree-removal.ts`、`project-mutation-guard.ts`、`directory-watch-subscriptions.ts`、`workspace-resource-events.ts`。界面新增 `TurnRestoreControls.tsx`，扩展既有 WorktreeSelector；业务展示状态使用 Jotai。

### 20.2 单文件恢复

- 消息底部的逐轮 diff 选择文件后提供“预览恢复此文件”；预览展示当前内容到轮初快照的差异，再由用户确认应用。新增文件明确展示删除确认；二进制展示字节数与无文本预览的说明。
- shared、main、preload、renderer 同步新增 PREVIEW_RESTORE/APPLY_RESTORE。写操作仅允许当前主窗口 main frame；应用前再次确认调用方仍有效。没有向 Agent 工具注入新的写入或审批旁路。
- 会话与工作区归属由 main 读取。只恢复本批捕获的主项目根或当前活动 worktree；历史根不再授权、会话迁移、项目重选或 worktree 身份变化后，旧预览失效。renderer 不能传正文、绝对写入位置或存储根。
- 预览核对当前文件是否仍等于本轮 after；应用同时核对预览时的当前内容 hash、文件身份、祖先目录身份、项目根身份和授权状态。后续内容改变或同路径文件替换均不覆盖；缺失任一侧快照、尚未收束、超限或不可信路径明确拒绝。
- 每个预览 60 秒有效、至多保存 8 份；应用凭据绑定 session/turn，正确归属的应用请求只可使用一次。写入响应丢失不会自动重放，须检查文件并重新预览。
- `TurnChangeStore.readBytes` 校验原始字节 hash；BOM、CRLF、空文件和二进制按快照精确恢复，显示层的换行归一化不参与写入。普通修改使用扩展后的 safe-file 原子写；重建已删除文件使用排他提交，不能覆盖预览后新建的文件。临时创建的空父目录在失败时回收。
- 路径每一层拒绝符号链接/目录联接，拒绝 `.git`、设备名、数据流和越界路径。恢复只修改目标文件，不运行 Git reset/restore，不修改暂存区，不改写原快照记录；无关文件保留。通知失败不会把已成功落盘伪报为未执行。
- 应用内根操作互斥；runtime 登记实际 cwd、主项目根和临时附加目录的活动引用。停止时继续持有引用直到底层 abort 与采样收束完成，旧代次释放不移除新代次。终端尚在创建时也阻止相关项目恢复。

### 20.3 Worktree 移除

- WorktreeSelector 的非主 worktree 行新增移除入口与 Radix 确认框，保留分支说明、失败原因、执行中状态和移除后的空状态。取消返回选择按钮焦点，恢复确认框取消返回预览按钮焦点；错误提示移除 Electron 内部 IPC 调用前缀。
- 新增 REMOVE_WORKTREE 四层契约。main 校验发起会话、授权仓库、Git 登记项、真实根身份、`.git` 指针身份及主仓库；主仓库、子目录、链接入口、locked/prunable 或失效目标不可移除。
- 活动会话、启动预检、队列、实际 runtime 授权根、正在停止的任务，以及运行/创建中的终端均阻止移除。目录内仍配置为项目根或附加文件/目录时，先要求解除资源关联。
- `git status --porcelain -z --untracked-files=all --ignored=matching` 不能有内容；命令失败、超时或输出超量不能被视为干净。最终再核对授权与活动状态，执行不带 force 的 `git worktree remove`，不删除分支。
- Git 移除成功后清除空闲会话的 activeWorktree 并广播更新；释放目录内已退出终端的历史引用，同步 watcher、失效 diff 缓存并通知文件列表。无关目录的终端历史保留。若 Git 已删除但清理失败，返回“已删除、引用待复核”的明确警告，不能隐式重试删除。

### 20.4 目录观察和快照保留

- manager 成功原子写入会话索引、工作区索引或工作区配置后发布资源归属变化；watcher 合并通知后从显式元数据同步订阅。覆盖会话删除、迁移、项目重选、附加文件/目录和活动 worktree，不只依赖 renderer 的某条 UI 路径。
- 真实规范化路径作为共享键，所有者集合提供引用计数；同一会话重复同步不累加。两个会话共同引用时删除一个不关闭底层 watcher；最后一个引用移除或切换根时关闭。受管目录由已有递归主 watcher 覆盖，避免重复创建底层监听。
- 缺失目录继续复用最近现存父目录监听，恢复后切回目标目录；error 回调与自愈定时器检查 watcher 身份、当前引用和全局启用状态。迟到的旧 watcher 错误不能关闭新 watcher，也不能在取消后复活。停止时释放订阅、父目录监听、防抖及重启定时器。
- 同一输入仅保留最近 10 次执行；索引成功提交后清理被淘汰的已完成私有记录。启动及每小时清理超过 30 天的已完成记录，以及超过 24 小时且本实例不再活动的 recording 遗留。
- 删除会话/工作区先沿用 stopAndDrain 屏障，再失效恢复凭据并清理对应 session 的私有快照；日常维护会重试已无会话的孤立记录。维护检查实时会话归属，不能因启动时的旧列表误删随后新建会话的记录。
- 清理仅删除经过记录验证的私有 UUID 目录，不跟随目录联接，不删除项目文件。单次扫描上限 10000 条；损坏/无法验证的数据保留并计入 skipped，超过扫描上限标记 partial，主进程明确记录待复核状态，不能把这类情况声称为完整物理清理。

### 20.5 验证结果

| 检查 | 结果 |
| --- | --- |
| 原工程最小相关及扩展 BDD 回归 | 159 pass / 0 fail，25 个文件，485 个 Bun 断言；`regression.log` |
| 四层 IPC / Node 集成夹具 | 实际 main handler、preload、恢复服务、Git 移除与 terminal-service 执行；验证主 frame 失效、错误归属、单次凭据、pending 终端和退出终端回收；Electron/PTY host 使用替身 |
| 真实 fs.watch 生命周期 | 共享目录删一个引用、切换 worktree、缺失目录恢复、迟到错误与五秒自愈取消、停止后不再推送均通过；会话元数据由本地夹具提供 |
| 文件 / Git 验证 | 原始字节、恢复新增/修改/删除、BOM/CRLF/二进制、hash/身份冲突、根与目录联接替换、暂存区字节及无关脏文件保留、ignored/untracked/locked worktree、私有快照淘汰和过期清理 |
| Agent 邻接回归 | 权限、项目指令、会话恢复与迁移、实际 Pi native retry 补丁、MCP 取消/不重放、消息队列及终端 cwd 相关测试通过；不等于完整自动化/协作实机验收 |
| 全工作区类型检查 | 6 个工作区通过；最后确认框焦点修正后再次通过，`final-typecheck.log` |
| Electron 完整构建 | 通过，主进程、utility、preload、renderer、CLI 与资源步骤成功；`build.log` |
| 最后 UI 修正后的 renderer 构建 | 通过，`final-renderer.log`；仅有既有大 chunk 提示 |
| 实际组件浏览器验证 | 恢复预览、Esc 取消零写入、确认单次请求、应用冲突、删除确认、worktree 脏目录拒绝/成功后空状态、两个确认框焦点返回、深色 460px 无横向溢出；后端为夹具 |
| git diff 检查 | 通过；未覆盖原有工作区改动，未创建提交 |

验证日志和组件截图保存在本机准备目录 `Documents/Codex/2026-11-17/proma-s2-03`。源码、类型检查、BDD 和构建的目标始终是 `E:\node_project\Proma`；临时 harness 不加入工程或交付包。组件浏览器会话与临时 HTTP server 在本批结束时关闭。

### 20.6 剩余验收与下一阶段

S2-03 的服务、四层契约、界面及本地夹具已实施。Electron 原生窗口、真实 Pi/模型任务、Automation/Collaboration 的完整交互和 Windows 安装包未在本批实机验证；不能据此宣布 M0/M1、M2 或 S7 已验收。

同步提交前校验避免 Proma 自身请求插入检查与提交之间；本地锁不控制系统外部编辑器或其它进程，极端外部并发仍需实机复核。链接/不支持的文件系统操作安全失败，不提供强制恢复开关。

下一阶段为 S3-01：记忆目标、revision、历史存储和并发/隔离/原子写测试；继续排除 Proma 云服务功能。


## 21. 提交、环境变更与 Agent 交接（2026-11-17）

### 21.1 当前功能基线

S1/S2 代码、BDD、四层 IPC、UI 和此前规格已提交到 `dev/new-version-features`：`13afae331ab310c50f62aefcee0f472ac54e8acb`，提交说明“增加网络诊断、逐轮差异与安全恢复”，共 91 个文件。提交时锁文件的工作区版本元数据同步为 Electron `0.19.64` / shared `0.1.77`，未升级依赖。此前第 16—20 节的“未提交”是各批实施时的历史状态。

提交前另运行网络错误、监测、恢复、诊断及 renderer network atoms 五文件测试：38 pass / 0 fail、66 个断言；与第 20 节的 159 项回归分开执行。Electron/真实模型、Automation/Collaboration 和安装包等实机门槛继续保留，不据此宣布里程碑完成。

### 21.2 用户环境指令

用户要求以后使用本机更新的 Node：`D:\Program Files\nodejs\node.exe`，核对版本 `v24.22.3`。本项目包管理仍使用 Bun。专用 Node、REA 安装/缓存/命令、两个客户端的 REA 连接与 Skill 已卸载，Ghidra/JDK 和对比证据保留；不应自动重装 REA 来继续源码开发。详情及配置备份位置见交接记录。

### 21.3 本次记录与接续位置

新增 [Agent 交接记录](docs/plans/2026-11-17-local-upgrade-handoff.md)，根 AGENTS 增加入口，固化阶段表、实现边界、S3-01 切入顺序、实际测试命令、历史证据位置和未验收项。应用按文档交付要求 patch 升至 `0.19.65`，同步锁文件；本规格 `1.0.6`，shared 保持 `0.1.77`。

本次仅文档和对应版本元数据变更，检查内容、链接、JSON/锁文件版本及 diff，不重复运行应用测试或把历史测试冒充本次执行。下一项实现为 S3-01：记忆目标、revision、历史存储；S3-02/S4—S7 尚未实施，M0—M3 不宣告验收完成。

## 22. S3-01 实施记录（2026-11-18）

本批在 macOS 的 Proma 工作区继续 `dev/new-version-features`，基于交接提交 `5abec93c`。Electron patch 升至 `0.19.66`，依赖版本与共享包版本不变。本机安装版确认为 `0.22.80`。本阶段的存储和权限要求已由规格与既有实现明确。

- `agent-memory-targets.ts` 从工作区索引只读解析显式授权根。项目身份包含规范化真实路径与文件系统目录身份；同根别名共享目标，项目重选、根目录替换或变成链接会使旧目标失效。受管工作区沿用 `memory/MEMORY.md` 与 `memory/*.md`。
- `agent-memory.ts` 实现 inspect、显式空初始化、版本校验的更新、历史读取和恢复。全局画像独立保存在 `user_profile.md`，报告并执行 5000 个 UTF-16 code units 的预算。单份记忆为至多 1 MiB 的 UTF-8 Markdown，BOM/CRLF 参与原始字节 revision。
- 空文件的 revision 是空字节 SHA-256，未创建的 revision 为 `null`。更新和恢复比较调用方的 expectedRevision，冲突返回当前 revision。正文提交前再次核对根、工作区授权及文件状态，显式新增使用排他提交。
- 已有正文在覆盖前按 revision 原子归档。同一内容在同一文件内只保存一次，历史列出当前正文之外的已归档版本。读取历史核对目标、文件键和内容 hash；损坏或缺失版本不可用于恢复。正文写入失败时旧内容仍有效，再次提交可复用已有归档。
- 服务边界只接受由主进程构造的用户写入上下文；计划、只读、自动化、委派与外部来源的变更请求被拒绝。实际 Pi 工具权限与 IPC 审批由 S3-02 接入并验证。应用内的同步最终校验不能锁住独立的系统进程。

macOS 以 Bun `1.4.4` 按冻结锁文件恢复依赖后执行 6 个定向测试文件，结果为 66 pass、0 fail，其中 15 个为新增记忆测试。`bun run typecheck` 在 6 个工作区通过。另将记忆服务单独打包为 CJS，并在本机 Node `v24.21.0` 完成写入、重读历史和按字节恢复的冒烟验证。Windows 实机、完整 Electron/真实模型执行、S3-02 与后续里程碑仍待验证。

## 23. S3-02 实施记录（2026-11-18）

桌面应用 `0.19.67`、shared `0.1.78`。本批在当前 macOS 工作区接续 S3-01，复用本地 Markdown、原子写和 Pi 既有工具包装及单次审批。

- Pi 新增 `MemoryRead`、`MemoryWrite`。工具绑定会话元数据中的项目和运行代次，执行时复核项目根、最新权限、取消状态及会话归属。计划模式只允许读取。Automation、Collaboration 子 Agent 与外部桥接不注册工具。全局改写、归档、恢复、导入和关联指令走单次审批。
- shared、主进程、preload 与 renderer 同步接入。主进程限定当前主窗口主 frame，拒绝任意根路径。旧记忆编辑窗只能操作登记的工作区，受管工作区内重叠的 Markdown 保存归入同一 revision/history 服务。
- 项目记忆从工作区记忆页进入，全局画像可从通用设置或工作区记忆页打开。编辑器展示预算、保存状态与冲突。归档可由历史恢复，恢复前展示当前正文和待恢复正文；搜索返回同一目标内的相对路径、行号和有界片段。
- 导入预览列出工作区旧记忆和授权项目的兼容来源，确认时重算计划并复核正文。每个可导入项先写入私有备份，再排他写入空目标。原文件、已存在的目标和无法解析的条目均保留。已导入标记使重试或归档后重复导入保持幂等。旧工作区画像仍属于对应项目，用户可在全局画像编辑器单独整理跨项目适用的信息。
- 已停用启动与读取时自动搬移旧记忆。需要关联项目指令时，用户预览后才能确认追加一个记忆链接，保留现有字节与换行风格。该操作只面向项目目标的 `AGENTS.md`。

验证覆盖 85 项相关 Bun 回归和单独在 macOS 系统权限下复跑的文件监听夹具。用 Node 执行实际 main/preload 模块和本地存储，覆盖主 frame、未授权窗口及退出解绑。浏览器夹具通过实际组件和主题验证了预算、保存、历史预览与恢复、深色导入及搜索定位。`bun run typecheck` 与 `bun run electron:build` 通过。Windows、真实 Electron 模型会话和安装包仍待验收。

## 24. S4-01 实施记录（2026-11-18）

桌面应用 `0.19.68`，shared `0.1.79`。复用 Pi 工具注册、独立文件预览、Vault 和受管浏览器。

- Pi `Present` 将已经存在的授权普通文件登记到当前用户输入轮次。交付记录按会话、轮次存放于主配置根的 `present/`，按规范化路径去重并原子写入。卡片支持确认、取消、打开与系统定位。主进程在展示前复核会话授权、规范化路径和文件身份，已替换、移出授权范围或删除的文件显示为失效。
- Vault 按目录逐层分页，每页最多 100 项。定位按需打开祖先目录并显示目标，按 Vault 和会话保存最近选中的文件或文件夹。明确路径优先匹配，同名笔记展示可选择的路径，超出扫描预算时保留未完成状态。主进程复核目录联接与 Vault 根边界。
- 每次展示都绑定独立请求 ID，只有当前请求的完成回执能更新卡片。HTML 在所属会话的受管浏览器中展示，本地资源通行范围绑定到该预览的目录、浏览器会话和标签页生命周期。切换该标签页的地址、关页或注销会话后撤销通行范围。停止 Agent 会取消尚未完成的展示，删除会话会清理相关展示窗口和记录。
- macOS 的 11 个定向 Bun 测试文件共 94 项通过。浏览器夹具使用实际组件和本地存储验证了展示回执、同名 Wiki 链接候选、目录翻页和刷新后恢复。`bun run typecheck` 与 `bun run electron:build` 通过。Electron 原生展示、真实 Pi 模型会话和 Windows 安装包仍待实机验收。

## 25. S4-02 实施记录（2026-11-18）

桌面应用 `0.19.69`，shared `0.1.80`。对照本机安装版 `0.22.80` 的 ASAR 和 preload 接口核对全局快速捕获、过程表述、速度档位和终端活动。对比限于 JavaScript，REA 报告的解包原生文件完整性差异未用于本阶段判断。

- Todo 和日程详情可添加、改期或删除提醒。`Cmd/Ctrl+Shift+T` 打开 Todo 快速捕获，可随任务一起保存提醒。沿用已有 Planning 数据库，schema v10 持久化提醒实例代次。改期或推迟生成新实例，同一时刻的重复保存保留原实例。调度器在启动、轮询和系统唤醒时事务认领到期实例。过期且未认领的提醒会补发一次，未确认记录在重启后继续显示。
- 提醒按绝对时间触发，按本地时区显示。时区变化时刷新显示。输入落在夏令时缺失的时刻会报错，重叠的时刻选较早的瞬间。调度器在通知前写入认领记录，应用若在两步之间退出，下次启动仍恢复应用内提醒。
- 终端以 PTY 子进程状态投影会话活动，侧栏可定位正在运行的 Agent 终端。主进程接收并确认输出，终端退出会清除活动状态并保留有限输出回放。用户打开的终端保留回放引用，关闭标签、删除会话或移除失效 worktree 时释放。
- 项目可归档与恢复，归档视图含项目原有会话。归档只改项目索引，应用至少保留一个活跃项目。主窗口恢复流状态时重新绑定活跃会话，原运行所有权保持有效。
- 会话提供高效、解释两种过程表述，并根据 Codex 模型能力开放标准、快速、极速。会话索引 v3 把旧布尔速度映射为新档位并保留旧字段，已有有效新档位优先。渠道主动删除会在界面反馈，升级移除的旧渠道只提示一次。
- Skill 卡片按工作区统计实际激活和成功读取的会话数。同一会话内重复使用只计一次，跨项目记录保持隔离，超出扫描范围时明确标示。用户档案和 Markdown 字号即时同步，全局快捷键随设置保存重新注册。

macOS 定向回归通过 18 个文件共 105 项，包含真实 SQLite 重启、时区和夏令时、流路由所有权与终端生命周期。深色浏览器夹具使用实际组件验证了快速捕获带提醒，以及提醒添加、改期、删除。`bun run typecheck`、`bun run electron:build` 和 `git diff --check` 通过。系统级唤醒和快捷键、真实 Pi/Codex 会话以及 Windows PTY 和安装包仍需实机验收。

## 26. M1 macOS 原生验收（2026-11-18）

在 macOS arm64 上使用仓库锁定的 Electron `43.2.0`、Electron 内置 Node `24.18.0`、Pi `0.87.1` 和源码构建产物。原生窗口启动通过，端到端驱动从真实主窗口的 preload 发起 IPC。工作区为隔离 Git 仓库，模型使用回环地址的 SSE 夹具，MCP 使用本机 stdio 服务。正式 Proma 配置未写入。

- 模型首个请求返回 502，Pi 随后恢复并执行工具。MCP 调用返回预期结果。第二轮复用相同的 Pi 会话 ID，并读回项目记忆。
- `Write` 生成带原始字节的逐轮差异。恢复预览签发凭据后将文件写回原内容，旧交付卡片随后显示失效。HTML 在真实受管 BrowserView 加载，普通文件独立预览返回就绪回执。
- Vault 交付请求带回笔记路径，主窗口的 preload 可读取目录、定位祖先和目标笔记、解析 Wiki 链接并签发回执。已完成请求的旧回执被拒绝。
- 原生 Agent PTY 运行命令、发布活动状态、退出归零并保留输出，关闭后释放引用。实际调度器将一条过期提醒认领一次并展示为待处理提醒。开发实例确认全局快捷键注册成功。
- 已将本地项目中通过授权的单文件 `MemoryWrite` 操作接到逐轮采样。原生复测确认 `MEMORY.md` 的写入前状态为缺失，逐轮记录完整，恢复后撤销了新建文件。另修复了 macOS 目录别名导致的项目内快照存储判断失效，新增测试确认拒绝写入。
- 应用升至 `0.19.70`。全仓 `bun test --parallel=4` 在隔离测试进程中通过 663 项，SQLite 回归使用锁定的 Electron 可执行文件。全工作区类型检查和 Electron 构建通过。

### 第三方 OpenAI Responses 实机复测

按用户指定使用第三方 OpenAI Responses 渠道与 `gpt-6-luna` 完成真实请求。通过 macOS 原生界面在独立合成 Git 项目执行，正式 Proma 配置和项目未写入。

- Pi 完成真实流式响应与本机 stdio MCP 调用，改写测试文件、生成静态 HTML 并通过 `Present` 交付。经界面预览并恢复单文件后，原始字节恢复，旧交付卡正常失效。独立预览窗口渲染出实际 HTML 内容。
- 检查到旧版在系统加密不可用时保存的明文密钥会在重启后被误判为密文。渠道读取兼容可辨识的旧明文，后续回退值带显式标记，密文解密失败继续报错。原渠道在重启后恢复请求并复用同一 Pi 会话 ID。
- Pi `MemoryWrite` 初始化时可一次保存首版正文，已有文件返回冲突。真实模型在重启后新建并读回合成记忆。轮次记录将该文件标识为受控写入，正确记录轮初文件缺失。
- 合并右侧并排工作区的焦点同步与清理，原生界面复测确认交付卡能唤出受管浏览器首次使用提示。独立预览入口补齐 `TooltipProvider`，实际 HTML 预览通过。
- 应用升至 `0.19.71`。隔离运行的全仓 Bun 测试通过 670 项。全工作区类型检查、Electron 构建及 `git diff --check` 通过。

macOS 的 M1 主链路通过。官方 ChatGPT（Codex）OAuth 已按用户要求移出此次验收范围。

### macOS 受管浏览器与系统事件补测

- 按用户授权确认首次提示，确认版本持久化为 `1`。第三方 Responses 会话交付的 `report.html` 从卡片进入受管 BrowserView。原生窗口直接显示「M1 Responses 验收」标题及正文，唤醒后仍可见。
- 实机发现 Vite 热更新会重复挂载窗口根，导致首次使用提示重复及两个浏览器槽位争用原生视图。入口现在在热更新时卸载旧 React 根，释放订阅与布局，异步窗口入口在销毁后停止渲染。重启及再次热更新后，真实交付单击可见。
- 系统日志记录 15:46 的软件休眠、一次维护唤醒，以及 15:49 的完全唤醒。隔离 Electron 使用实际 `powerMonitor`、规划调度器、SQLite 和 preload IPC，休眠时创建的合成提醒送达一次。系统完全唤醒前该提醒已被认领，测试关闭系统通知，仅验证应用内投递与去重。
- 用户在其他应用处于前台时实际按下 `⌘⇧T`，确认 Proma 唤出「快速记录 Todo」。独立 Electron 验证也覆盖了隐藏窗口恢复到前台和主页面重载期间的回调投递。
- 桌面应用 `0.19.72` 的全仓 Bun 670 项、类型检查和 Electron 构建通过。M1 的 macOS 验收完成，Windows 暂缓。
