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
2. **需求进展与双向对齐总览、跨仓互跳与就地 `ⓘ` 解释**：高阶规划仓在「📝 逐项审阅」→「📋 需求进展与双向对齐总览」提供四列双向对齐总览表（需求、业务处置与承接去向、机器派生满足概况、阶段与双向健康度）；发现 `UPSTREAM_DESIGN_CHANGED`、`DOWNSTREAM_DESIGN_EVOLVED`、`UNALLOCATED_ACTIVE_DEMAND`、`SOURCE_ARTIFACT_MISSING` 或 `UNCLAIMED_IMPLEMENTATION_ENTRY` 等问题时，均可原地悬停或点击 `ⓘ` 查看人话解释，并一键在上下游仓库间跨仓跳转。
3. **固定坐标宽屏图谱与 JSON 契约分离审阅**：取消 `1440px` 锁宽并采用双主题原生 SVG，点击图上节点时坐标 100% 恒定不跳变；「📝 逐项审阅」→「📖 按阅读任务逐篇审阅」按统一角色动线先展示「首要阅读（用户故事 → 需求总纲 → 场景剧本）」，再展示「关联依据」，并将 `.json`/`.yaml` 数据契约独立置底且支持与同源 Markdown 文稿一键互跳；添加未解决批注（`＋ 添加批注（自动转入审阅中）`）自动点亮「🔵 审阅中」，零侵入保存在 `.skill-family-studio/reviews.json`。
4. **多级任务树与跨宿主智能体编队监控（「⚡ 运行监控」）**：默认首页以可折叠「🌳 任务推进树（默认）」呈现波次 → 阶段 → 子步骤及前置依赖（`blockedBy`）；新增「🛰️ 会话与子会话编队」脱敏聚合多宿主（Antigravity / Claude Code / Codex / 本地沙箱）的父子会话树、跨泳道委派回报时序与 `原文 | Markdown` 任务简报；底层 `token-lock`、`state-store` 哈希链与 `supervise-process` 收纳进「🩺 底层排障与健康诊断」。

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

# 前台启动并默认打开「使用说明」页签
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
