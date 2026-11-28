# Changelog

## 0.3.0

- 新增按需子路径 `./otel-compliance`（`src/otel-siem-exporter.mjs`）：直接复用 `skill-family-harness-node@0.39.2` `state-store` 哈希链与快照锚点，在强监管模式下强制不少于 `180` 天防篡改留存下限，提供 `SessionTraceBundle` 密码学验封转换 OTLP JSON `resourceSpans`、SIEM NDJSON 审计导出、凭据与个人信息脱敏及等保三级五域控制项证据映射报告。
- 新增按需子路径 `./collector-server`（`src/studio-collector-server.mjs`）：内置 `solo`（默认本机回环免打扰）/ `team`（允许自批）/ `regulated`（强监管异体双人审批与 `>= 180` 天留存锁）三档渐进画像与独立 `approvalMode`（`off | self | dual`）开关，预留 `authProvider`、`secretVaultProvider`、`auditStoreProvider` 三大商业扩展插槽，支持零明文 SHA-256 恒定时间多租户 RBAC、基于 `openUsageGuard` 的配额守卫及含敏感凭据异常 `STB` 脱敏重封存导出 `FB-2` 回归候选闭环；主入口 `src/index.mjs` 保持零治理预加载。

## 0.2.2

- 升级对齐 `artifact-graph@1.2.3`（细粒度提示词与 `SKILL.md`/`references/**` 非代码资产 SHA-256 锁）与 `skill-family-execution-driver@0.2.1`（厂商中立受管多宿主 CLI 采集驱动与 `./replay-driver` 导出）。
- 正式纳入公开包映射并导出 `./blueprint-canvas`（零 `innerHTML` 受限枚举多会话编排蓝图画布、实时反自审与外部副作用 HITL 门禁支配检查及 `blueprintRef` 规范化 SHA-256 摘要生成）。

## 0.2.1

- 单端口统一承载三业务主页签（审阅与对齐、制品图谱、运行监控）与按需「📖 手册」，提供零配置单仓与声明式多仓发现。
- 支持高阶规划仓 4 列需求进展与双向对齐总览表、机器派生满足度（严格校对代码/测试双锁 SHA-256）、跨仓一键互跳与高阶无代码锁豁免说明。
- 支持手风琴 6 组折叠目录树、EntityBrief 摘要卡片、运行期零侵入接入本地项目（.skill-family-studio/workspace-projects.json）与全局 ⌘K 搜索。
- 支持双栏主从任务推进树、多宿主智能体会话编队（双窗保头保尾与扩展凭据脱敏）、沙箱锁实时读秒排障，以及 Archify iframe 同源沙箱（sandbox="allow-scripts" + postMessage）与同端口回环 CSRF 防护。
