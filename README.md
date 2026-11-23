# Skill Family Studio

`skill-family-studio` 是面向任意技能族与业务域套组的本地离线可视化控制台。它在单一回环端口（默认 `127.0.0.1:57630`）内统一承载 `artifact-graph` 固定坐标宽屏图谱、三层双向一致性体检与跨仓互跳、故事优先的四态逐项审阅，以及多级任务树与跨宿主智能体编队监控。

## 三十秒零记忆启动（推荐：直接对 AI 助手说一句话）

安装技能包后，**不需要背任何命令行参数**。只要你在项目目录里对 Codex / Claude Code / Kimi Code / Antigravity 说：

> “打开工作台” / “帮我审阅这个项目的设计文档” / “看看任务推进和子智能体编队”

智能体会自动执行以下静默引导流程：
1. 先调用内置 `inspect-setup` 探针识别当前目录角色：**独立单仓**默认以 `--scan-roots none` 纯净聚焦本仓，不再混入无关兄弟仓；
2. 若检测到关联上下游仓或位于多仓工作区父目录且尚未配置，仅向你提出**一个中文三选一**问题（只看本仓 / 看关联业务套组 / 看全工作区）；
3. 选定后代劳生成 `.studio-workspace.json`（若需要）、在已收录同一项目的前提下幂等复用现有服务并精准隔离冲突端口，最后直接输出可点击链接与当前角色的推荐阅读顺序。

## 核心能力

1. **多仓声明式发现与单仓纯净隔离**：单仓默认 `--scan-roots none` 干净聚焦当前仓库；多仓业务域可通过声明式 `.studio-workspace.json`（或 `artifact-graph.config.yaml` 的 `studio` 节）自定义 `scanRoots`、`groupLabels` 与 `lifecycle-story-pack` / `archify-model-scenes` 扩展集合，对任何第三方技能族开箱即用。
2. **三步自引导「📝 审阅与对齐」、跨仓互跳与就地 `ⓘ` 解释**：顶栏正中聚焦「📝 审阅与对齐」「🕸️ 制品图谱」「⚡ 运行监控」，右侧收拢按需「📖 手册」与「🌓 外观」。审阅页以「① 核对需求与代码对齐 ──▶ ② 按顺序逐篇审阅 ──▶ ③ 导出验收结论」自带引导流程；高阶规划仓提供四列双向对齐总览表，单仓/子仓提供代码锁体检与「下一步：开始逐篇审阅正文 →」直达推进；发现 `UPSTREAM_DESIGN_CHANGED`、`DOWNSTREAM_DESIGN_EVOLVED`、`UNALLOCATED_ACTIVE_DEMAND`、`SOURCE_ARTIFACT_MISSING` 或 `UNCLAIMED_IMPLEMENTATION_ENTRY` 等问题时，均可原地悬停或点击 `ⓘ` 查看人话解释并一键跨仓跳转。
3. **固定坐标宽屏图谱、纯净内嵌 Archify 与草稿不丢失**：取消 `1440px` 锁宽并采用双主题原生 SVG 与自适应折行排布，点击图上节点坐标 100% 恒定不跳变，并一键「重置视角」归零缩放与位移；Archify 业务逻辑图通过 `&embed=1` 隐藏冗余内壳层；逐篇目录按「第 1 顺位：先看诉求（用户故事） → 第 2 顺位：核对边界（需求与场景） → 备查依据 → 附：机器契约（默认自动跳过）」排列，未提交批注与备注草稿跨篇切换自动暂存（「📝 草稿」），全状态变更支持 5 秒撤销，零侵入保存在 `.skill-family-studio/reviews.json`。
4. **健康灯自明运行监控与自挂源全生命周期管理（「⚡ 运行监控」）**：顶栏子视图自带实时状态灯「🌳 任务推进树」「🛰️ 智能体会话编队」「🩺 异常排障 (🟢 无卡死 / ⚠️ N 告警)」；无活跃计划时智能直推跳转本机编队、沙箱演练或「+ 挂载运行源」，自定义挂载源随时支持「✏️ 编辑」与「🗑️ 移除」；关键词搜索自动穿透折叠树、全部空筛选提供「🔄 清空筛选条件」，排障锁雷达聚焦运行时并发写集排他锁。

## 环境要求

- Node.js `>=22.22.2 <23`

<details>
<summary>高级与手动 CLI 命令参考（平时交由 AI 助手代劳即可，按需展开）</summary>

```bash
# 只读探测当前目录角色与推荐启动参数（输出结构化 JSON）
npx skill-family-studio inspect-setup --root /absolute/project/path

# 在工作区或单仓按选择安全生成 .studio-workspace.json
npx skill-family-studio init-workspace --root /absolute/project/path --mode standalone

# 单仓纯净聚焦守护启动（推荐加 --scan-roots none，仅收录当前项目）
npx skill-family-studio ensure --root /absolute/project/path --port 57630 --scan-roots none

# 按项目 .studio-workspace.json 声明启动多仓套组控制台
npx skill-family-studio ensure --root /absolute/project/path --port 57630

# 前台启动并默认打开「📖 手册」页签
npx skill-family-studio serve --root /absolute/project/path --port 57630 --scan-roots none --tab guide

# 检查运行环境与离线资产完整性
npx skill-family-studio doctor --root /absolute/project/path

# 离线输出设计态 + 双向对齐 + 审阅汇总 + 运行态聚合快照
npx skill-family-studio snapshot --root /absolute/project/path
```

</details>

## 多宿主技能接入说明

包内包含经 Foundation 构建核验的 `skills/skill-family-studio/SKILL.md` 及多宿主投影清单：

- **Codex / Kimi Code / Qoder / CodeBuddy**：自动映射至 `.agents/skills/skill-family-studio/SKILL.md` 及对应 `.*-plugin/plugin.json`；
- **Claude Code**：映射至 `.claude/skills/skill-family-studio/SKILL.md` 与 `.claude-plugin/plugin.json`；
- **Antigravity**：提供严格遵守官方十键白名单的根级 `plugin.json`，支持按宿主规范挂载至项目 `.agents/skills`、`.agent/skills` 或 `.gemini/config/{skills,plugins}`。

完整逐页引导、角色动线与运行监控说明请参阅随附的 [USER-GUIDE.md](USER-GUIDE.md)。

## 开源许可与署名

作者：广州市风荷科技有限公司。Licensed under Apache-2.0（详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。
