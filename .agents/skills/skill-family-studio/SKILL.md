---
name: skill-family-studio
description: 启动或复用单端口本地研发与审阅可视化控制台（Skill Family Studio），在同一界面完成无硬编码跨仓工作区发现、宽屏制品图谱浏览、三层双向对齐体检与跨仓互跳、故事优先四态审阅签收及 Foundation 运行态监控。用户要求查看制品关系图、核对高阶拆分与代码锁对齐、逐篇审阅需求与故事、导出审阅验收单或查看实时令牌锁与事件哈希链时使用。
---

# Skill Family Studio 控制台技能

本技能通过 `skill-family-studio` 命令行在本地回环地址（默认 `127.0.0.1:57630`）启动或复用单端口离线控制台，把 `artifact-graph` 设计态审阅、跨层双向对齐体检与 Foundation 运行态监控合并在同一工作区内执行。

## 一、职责与安全边界

- **通用无硬编码与零侵入扫描**：控制台优先读取启动根目录的 `.studio-workspace.json`（或 `artifact-graph.config.yaml` 顶层 `studio` 节），在无配置时自动发现当前仓与同父目录下带 `artifact-graph.config.yaml` 的兄弟仓库，仅通过受限路径只读加载制品与对齐锁，绝不修改受审仓库受 Git 跟踪的任何文件。
- **零侵入审阅台账**：审阅结论与批注集中写入启动根目录下的 `.skill-family-studio/reviews.json`（或 `--reviews-file` 显式指定的相对路径），仅对历史 `artifacts/reviews/workbench-reviews.json` 做只读兼容导入。
- **回环安全与纯离线交付**：HTTP 服务仅绑定 `127.0.0.1`，拦截非本地 `Host` 与 `Origin` 请求头；界面样式与脚本 100% 本地离线提供，不发起任何外网请求。
- **不越权执行外部写动作**：本技能不执行 `git commit`、`git push`、`git tag` 或包发布。

## 二、执行步骤

1. **检查环境与健康状态**：在已配置 Node.js `>=22.22.2 <23` 的终端中运行诊断，确认本地运行时、离线宽屏资产与仓库发现正常：

   ```bash
   npx skill-family-studio doctor --root /absolute/project/path
   ```

2. **幂等启动或复用单端口控制台**：需要为用户、制品助手（`artifact-chain-assistant`）或长任务工作流打开可视化界面时，优先调用 `ensure`（兼容 `open`）。若目标端口已有运行中的 Studio 实例会直接复用，不会重复拉起冲突进程：

   ```bash
   npx skill-family-studio ensure --root /absolute/project/path --port 57630 --tab graph
   ```

   需要指定初始页签或默认仓库时，可传入 `--tab <guide|graph|review|runtime>` 与 `--repo <group/repo-name>`。

3. **引导用户按四大主线工作流操作**：
   - **切换项目与工作模式**：在顶栏左侧「当前项目」切换目标仓库（支持单技能族零配置与 `.studio-workspace.json` 声明的业务域多仓套组；标签直接标明 `高阶规划仓 / 详设子仓 / 单项目仓`）。
   - **宽屏看图与 Archify 联动**：在「🕸️ 制品图谱」使用「适应屏宽」与「自动折行排布」查看全局依赖，在 1920px、2560px（2K）与 3440px（21:9 带鱼屏）下均无横向溢出；切换到 Archify 业务架构图时支持一键全屏展开，点击图节点直接定位右侧关联说明文档与章节锚点。
   - **核对三列需求进展并跨仓互跳审阅**：在「📝 逐项审阅」顶部的「📋 需求进展与双向对齐总览」核对拆分去向、机器派生「满足概况」、上下游漂移与单仓未认领入口；点击下游承接胶囊直接跨仓跳到子项目详设，在子仓阅读页顶部点击「↖ 上游高阶来源」跳回高阶规划条目；切入「📖 按阅读任务逐篇审阅」时按「首要阅读（用户故事 → 需求总纲 → 场景剧本）」与「关联依据」有序推进，添加未解决批注自动点亮 `reviewing`，全部解决或清空且无终态结论时自动回到 `pending`，定稿后通过顶栏右侧胶囊导出验收单。
   - **实时排查运行态卡点**：在「⚡ 运行监控」切换「聚焦当前项目」或「全工作区监控源聚合」，按需钻取 A（MD/JSON/CSV 任务里程碑矩阵）、B（文件锁每秒读秒雷达与超阈值预警）、C（`state-store` 事件哈希链时间线）、D（`supervise-process` 子进程轨迹），并支持网页内 `+ 挂载运行源` 与 `🔓 释放沙箱锁`。

4. **离线快照采证（无需常驻端口时）**：仅需向主控智能体汇报当前制品规模、双向对齐状态、未决批注或运行态摘要时，直接执行：

   ```bash
   npx skill-family-studio snapshot --root /absolute/project/path
   ```

## 三、结果返回说明

完成调用后，按以下结构向用户或主控会话汇报事实：

```markdown
### Skill Family Studio 控制台状态
- **访问入口与模式**：`<http://127.0.0.1:57630/...>`（`<复用既有实例 / 新启动守护进程 / 离线快照>`）
- **已发现项目规模**：共 `<N>` 座仓库，当前聚焦 `<仓库标识>`
- **双向对齐与审阅进度**：对齐告警 `<A>` 项；已通过 `<X>` · 审阅中 `<Y>` · 需修改 `<Z>`（待解决批注 `<K>` 条）
- **运行态健康摘要**：活跃令牌锁 `<L>` 把，事件哈希链 `<VALID / EMPTY / NO_STORE>`
```

<!-- @feature STU002 -->
<!-- @feature STU003 -->
<!-- @feature STU004 -->
<!-- @feature STU005 -->
