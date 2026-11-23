# Skill Family Studio

`skill-family-studio` 是面向任意技能族与业务域套组的本地离线可视化控制台。它在单一回环端口（默认 `127.0.0.1:57630`）内统一承载 `artifact-graph` 宽屏制品图谱浏览、三层双向一致性体检与跨仓互跳、故事优先的四态引导式逐项审阅，以及迭代升级的 Foundation 运行态监控。

## 核心能力

1. **零硬编码通用适配（单项目零配置 + 业务域多仓套组）**：零配置即可自动发现当前仓与同父目录兄弟仓库；多仓业务域可通过声明式 `.studio-workspace.json`（或 `artifact-graph.config.yaml` 的 `studio` 节）自定义 `scanRoots`、`groupLabels` 与 `lifecycle-story-pack` / `archify-model-scenes` 扩展集合，对任何第三方技能族开箱即用。
2. **需求进展三列总览与三层双向对齐体检**：高阶规划仓提供「业务处置与承接去向 / 机器派生满足概况 / 阶段与双向健康度」三列一览表，严禁靠手工台账声称满足；支持高阶变了提醒详设（`UPSTREAM_DESIGN_CHANGED`）、详设演进提醒回写（`DOWNSTREAM_DESIGN_EVOLVED`）、单仓代码与 `SKILL.md` 未认领入口告警（`UNCLAIMED_IMPLEMENTATION_ENTRY`），以及高阶与子仓详设之间一键跨仓互跳。
3. **超宽屏自适应折行图谱与故事优先审阅**：解除 `1440px` 锁宽限制，在 `1920px`、`2560px`（2K）与 `3440px`（21:9 带鱼屏）铺满视口并同层多行自动折行；「逐项审阅」按读者任务划分为「首要阅读（用户故事 → 需求总纲 → 场景剧本）」与「关联依据（领域决策 → 架构规格 → 测试追溯）」；添加未解决批注自动点亮「🔵 审阅中」，零侵入保存在 `.skill-family-studio/reviews.json`。
4. **迭代版「⚡ 运行监控」四大观测子视图**：支持聚焦当前项目与全工作区活跃源切换、多格式（MD/JSON/CSV）任务里程碑矩阵、文件锁每秒跳字读秒与超阈值预警、网页内 `+ 挂载运行源` 弹窗与 `🔓 释放沙箱锁`、`state-store` 事件哈希链时间线、`supervise-process` 子进程监督轨迹以及 SSE 实时自动同步。

## 环境要求与快速启动

要求 Node.js `>=22.22.2 <23`。

```bash
# 检查运行环境与离线资产完整性
npx skill-family-studio doctor --root /absolute/project/path

# 幂等守护启动（推荐：已在线则直接复用）
npx skill-family-studio ensure --root /absolute/project/path --port 57630

# 前台启动并默认打开「使用说明」页签
npx skill-family-studio serve --root /absolute/project/path --port 57630 --tab guide

# 离线输出设计态 + 双向对齐 + 审阅汇总 + 运行态聚合快照
npx skill-family-studio snapshot --root /absolute/project/path
```

## 多宿主技能接入说明

包内包含经 Foundation 构建核验的 `skills/skill-family-studio/SKILL.md` 及多宿主投影清单：

- **Codex / Kimi Code / Qoder / CodeBuddy**：自动映射至 `.agents/skills/skill-family-studio/SKILL.md` 及对应 `.*-plugin/plugin.json`；
- **Claude Code**：映射至 `.claude/skills/skill-family-studio/SKILL.md` 与 `.claude-plugin/plugin.json`；
- **Antigravity**：提供严格遵守官方十键白名单的根级 `plugin.json`，支持按宿主规范挂载至项目 `.agents/skills`、`.agent/skills` 或 `.gemini/config/{skills,plugins}`。

详细操作动线、双向对齐规则与运行监控使用方式请参阅随附的 [USER-GUIDE.md](USER-GUIDE.md)。

## 开源许可与署名

作者：广州市风荷科技有限公司。Licensed under Apache-2.0（详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。
