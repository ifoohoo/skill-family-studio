# Skill Family Studio

`skill-family-studio` 是面向技能族研发与设计验收的本地离线可视化控制台。它在单一回环端口（默认 `127.0.0.1:57630`）内统一承载 `artifact-graph` 宽屏制品图谱浏览、四态引导式逐项审阅与 Foundation 运行态监控。

## 核心能力

1. **统一项目切换，废除内部批次黑话**：顶栏左侧通过唯一的「当前项目」切换器按 `Skill Family 支撑线 / Artifact 制品线 / GLAF4 业务线` 浏览仓库，直观展示制品节点数、版本锁新鲜度、审阅完成度与运行态活跃度。
2. **超宽屏自适应与同层多行自动折行图谱**：主画布解除 `1440px` 锁宽限制，在 `1920px`、`2560px`（2K 桌面）与 `3440px`（21:9 带鱼屏）显示器上 100% 铺满视口；同一层级包含大量节点时自动排布为多行网格（Wrap Grid），少节点层自动居中避免孤岛撕裂，保证有效字号不低于 `11px` 且消除横向滚动条。内嵌 Archify 架构图支持一键全屏展开及点击节点联动定位对应说明章节。
3. **自动感知的四态审阅工作流与零侵入存储**：提供「开始按推荐顺序审阅」与「✓ 通过并审下一项 →」连贯动线。为文档添加未解决批注会自动点亮「🔵 审阅中」，批注全部解决或清空且未给结论时自动回到「⚪ 待审阅」；全部数据保存在 `.skill-family-studio/reviews.json`，零改动受审仓库源码。
4. **单端口集成 Foundation 运行态监控**：直接在「⚡ 运行监控」页签实时查看 `state-store` SHA-256 事件哈希链、`token-lock` 持锁读秒预警与 `supervise-process` 子进程状态，并支持在系统临时目录一键运行隔离沙箱演练。

## 环境要求与快速启动

要求 Node.js `>=22.22.2 <23`。

```bash
# 检查运行环境与离线资产完整性
npx skill-family-studio doctor --root /absolute/project/path

# 幂等守护启动（推荐：已在线则直接复用）
npx skill-family-studio ensure --root /absolute/project/path --port 57630

# 前台启动并默认打开「使用说明」页签
npx skill-family-studio serve --root /absolute/project/path --port 57630 --tab guide

# 离线输出设计态 + 审阅汇总 + 运行态聚合快照
npx skill-family-studio snapshot --root /absolute/project/path
```

## 多宿主技能接入说明

包内包含经 Foundation 构建核验的 `skills/skill-family-studio/SKILL.md` 及多宿主投影清单：

- **Codex / Kimi Code / Qoder / CodeBuddy**：自动映射至 `.agents/skills/skill-family-studio/SKILL.md` 及对应 `.*-plugin/plugin.json`；
- **Claude Code**：映射至 `.claude/skills/skill-family-studio/SKILL.md` 与 `.claude-plugin/plugin.json`；
- **Antigravity**：提供严格遵守官方十键白名单（`name` / `displayName` / `version` / `description` / `author` / `repository` 等）的根级 `plugin.json`，支持按宿主规范挂载至项目 `.agents/skills`、`.agent/skills` 或 `.gemini/config/{skills,plugins}`。

详细操作动线与状态说明请参阅包内随附的 [USER-GUIDE.md](USER-GUIDE.md)。

## 开源许可与署名

作者：广州市风荷科技有限公司。Licensed under Apache-2.0（详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。
