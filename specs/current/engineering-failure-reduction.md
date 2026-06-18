# 引擎可修失败的深挖与修复（工程视角失败率）

Status: proposed · Parent: #3408 · 上游背景:stability-performance-state-and-plan.md · Spec format: spec-battle

## Why · 为什么要做

- **用例**:#3408 排查后,把失败按"产品视角(用户面向)/工程视角(引擎可修)"拆开。**工程视角失败率 ~7% 才是我们真正能修的产品可靠性**,但它一直被全量 ~22% 的噪音(用户自救 + 老版本)淹没。
- **痛点**:工程视角里最大的桶是 `process_exit`,其中 `execution_failed`(~4,489/周)是个不透明兜底,藏着真 bug;另有一批已具名的真 bug(配置、spawn、协议)。这些都是**我们引擎的锅、可修**。

## Sources · 事实源（已核实）

- **Repo**:`nexu-io/open-design`(main)。`gh repo clone … && git checkout main`。数据:PostHog OpenDesign=420348(`run_finished`)+ Langfuse `us.cloud.langfuse.com`。
- **process_exit 细分(7d 实测)**:execution_failed 4,489 · terminated_unknown 535 · **agent_config_invalid 382** · fabricated_role_marker 310 · cli_not_installed 260 · agent_protocol_error 255 · exit_code 185 · **spawn_ebadf 66 / spawn_eperm 61 / spawn_enoexec 22** · signal_killed 22 · stdin_write_eof 20。
- **fix_config 根因(Langfuse 实测)**:报错 `Error loading config.toml: unknown variant `default`, expected `fast` or `flex` in `service_tier``。即 codex app 写了 `service_tier="default"`,CLI 只认 `fast`/`flex`。
  - 归一化器 `apps/daemon/src/codex-config-normalize.ts:76` 的正则**只匹配 `"priority"`** → `default` 等其他无效值漏过(`:52-53` 注释明说不管未知值)。382/周全在当前版本(0.10.1=282/0.10.0=56/0.11.0=42,非老版本)。
- **execution_failed 分类延续**:`apps/daemon/src/run-failure-classification.ts`(#4502 已把 execution_failed 按 `runtime_close` 拆成 stream_error/exit_nonzero/fatal_rpc_error,in review)。stream_error 真因多被 opencode 吞(见 reference,需 Langfuse + 可能 opencode 侧加日志)。
- **访问前提**:PostHog `phx_` key、Langfuse pk/sk。

## Goals / Non-goals

- **Goals**:降工程视角失败率——先修已定位的具体 bug(fix_config),再把 execution_failed 不透明桶继续拆细、挖真因、逐个修。
- **Non-goals**:产品视角失败(auth/余额——用户自救);老版本(null,自愈);TTFT 口径(单列);AMR 延迟(独立项目)。

## Proposed design（按可立即落地排切片）

### Slice 1 · fix_config:codex service_tier 归一化通配（先 ship,小而确定）
- **现状**:归一化器只补 `priority→fast`;实测漏的是 `default`。
- **修**:把 `normalizeCodexConfigContent` 从"匹配 `priority`"改成"**匹配任何 service_tier 值,若不在合法集 {fast,flex} 则归一化**"(归一化成安全默认 `fast`,或剥掉该行让 CLI 用内置默认)。
- **保持 scoped**:仍只碰 service_tier 行(锚定行首 + 排除注释/别的 key 的字符串值),别的原样;幂等;原子写。
- **红 spec**:用可注入的 `CodexConfigIO`,断言 `service_tier="default"`(及任意非法值)被归一化、合法值不动、注释/别的 key 不误伤。
- **收益**:~382/周当前版本失败消除 + 未来 codex 再改名不用打地鼠。

### Slice 2 · execution_failed 深挖（持续战役)
- #4502 已把 execution_failed 按 close-reason 拆(stream_error/exit_nonzero/fatal_rpc_error)。下一步:
  - 从 PostHog 取 stream_error/exit_nonzero 的 `langfuse_trace_id` → Langfuse 挖真实错误形态 → 给 `classifyRunFailure` 加真 pattern 分支(把 opaque 拆成可定位的子因)。
  - opencode 多吞真因("Unexpected server error")→ 评估在 opencode 适配器侧加结构化日志(另一条线,跨 opencode)。

### Slice 3 · 已具名的真 bug（execution_failed 之外，process_exit 里可直接修的)
- **spawn_ebadf 66 / spawn_eperm 61 / spawn_enoexec 22(~149/周)**:子进程 spawn 失败。ebadf 关联 #4100 的 FD 泄漏前科——查是否同源(FD 耗尽)、eperm/enoexec 查权限/可执行格式。
- **agent_protocol_error 255**:`json-rpc id N: Internal error`——查 ACP 协议层。
- **fabricated_role_marker 310**:模型伪造 role marker 被 guard 拦——评估是否可重试/是否特定 model。
- 每个先红 spec 复现、再修;按量×our-fault 排。

## Alternatives considered

- fix_config 用"再加一个值映射(default→fast)"而非通配:否决——打地鼠,codex 下次再改名又漏。通配非法值一次性解决。
- execution_failed 直接在 daemon 加更多 pattern 而不挖 Langfuse:否决——不知道真实错误形态就加 pattern 是猜;先挖真因。

## Risks & mitigations

- **fix_config 通配误伤**:若某非法值其实有语义,归一化成 fast 可能改变用户意图 → 缓解:`default` 语义本就是"让系统选",归一化成 fast 或剥行(用 CLI 默认)都安全;红 spec 覆盖"合法值不动/注释不误伤"。
- **execution_failed 挖掘依赖 Langfuse**:trace 留存率有限、opencode 吞真因 → 收益有上限,如实标注;能拆多少拆多少。
- **spawn bug 可能是环境**:ebadf/eperm 部分是用户机器环境 → 先归因再判是否我们可控。
- 无契约/迁移风险(分类是附加;归一化只改本地配置文件)。

## Validation · 验收

- Slice 1:红 spec 先红后绿(`service_tier="default"`→归一化);线上看 agent_config_invalid 当前版本量下降。
- Slice 2:execution_failed 中被拆出具名子因的占比上升(工程视角看板可见)。
- Slice 3:对应 detail(spawn_*/agent_protocol_error)量下降。
- 不需要 #3545 QA gate（不改模型输入输出）。

## Reproduction

- process_exit 细分:`SELECT properties.failure_detail, count() FROM events WHERE event='run_finished' AND properties.failure_category='process_exit' AND timestamp>=now()-INTERVAL 7 DAY GROUP BY 1 ORDER BY 2 DESC`
- fix_config 真因:上面取 `failure_detail='agent_config_invalid'` 的 `langfuse_trace_id` → Langfuse `GET /api/public/traces/{id}` → observations ERROR statusMessage(见 `unknown variant 'default'`)。
- 版本拆:加 `GROUP BY properties.app_version` 确认当前版本(非老版本噪音)。

## Open questions

- service_tier 归一化:遇到未知值,归一化成 `fast` 还是剥行(用 CLI 默认)更稳?(倾向剥行,最小假设)
- spawn_ebadf 是否就是 #4100 FD 泄漏的残留/回归?
- execution_failed 的 exit_nonzero 子桶,Langfuse 里有没有可提取的真因,还是也被吞?
