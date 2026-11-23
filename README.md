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

1. **多仓声明式发现、运行期管理与来源追溯**：单仓默认 `--scan-roots none` 干净聚焦当前仓库；多仓业务域可通过声明式 `.studio-workspace.json`（或 `artifact-graph.config.yaml` 的 `studio` 节）自定义 `scanRoots`、`groupLabels` 与扩展集合。控制台支持运行期「＋ 添加本地项目」、按 `package.json#description` / `README.md` 查看「✎ 说明与来源」并零侵入覆写名称说明或移出列表。
2. **全站实体第一身份与统一表头 `ⓘ` 口径**：无论是高阶对齐表、子仓绑定、审阅目录、运行计划还是智能体编队，均将中文标题与正文第一句自然摘要放于首位，编号与文件路径退居辅助位置；高频列表头以单一 `ⓘ` 集中阐释列规则与状态字典，行内仅真正异常与漂移告警保留诊断 `ⓘ`。
3. **折叠目录树、现代长文排版与草稿不丢失**：逐篇审阅左侧提供「① 用户故事 → ② 生命周期讲解 → ③ 需求总纲 → ④ 场景剧本 → ⑤ 领域模型与架构设计 → 附：机器数据契约 (.json/.yaml · 自动跳过)」手风琴折叠目录树，支持关键词穿透搜索；正文顶部呈现 Hero 摘要卡、GitHub Callout 与用户故事卡片；Archify 业务逻辑图通过 `&embed=1` 纯净内嵌，未提交批注与备注草稿自动暂存（「📝 草稿」）并支持 5 秒撤销，零侵入保存在 `.skill-family-studio/reviews.json`。
4. **双栏主从运行监控（活跃 + 历史计划树 & 多宿主编队）**：「🌳 任务推进树」左侧聚合活跃运行计划与近期进行中/已完成历史计划、右侧展开多级树与进度条；「🛰️ 智能体会话编队」左侧以宿主过滤芯片和摘要卡片直选 Antigravity / Claude / Codex / 沙箱编队，右侧联动渲染网络拓扑、协作泳道与 Markdown 事件简报；「🩺 异常排障」实时汇报运行时排他写锁、事件哈希链与子进程看门狗。

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
