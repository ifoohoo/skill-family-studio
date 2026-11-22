---
name: skill-family-studio
description: 启动或复用单端口本地研发与审阅可视化控制台（Skill Family Studio），在同一界面完成跨仓库宽屏制品图谱浏览、四态引导式审阅签收与 Foundation 运行态监控。用户要求查看制品关系图、逐篇审阅需求与设计、导出审阅验收单或查看本地令牌锁与状态链时使用。
---

# Skill Family Studio 控制台技能

本技能通过 `skill-family-studio` 命令行在本地回环地址（默认 `127.0.0.1:57630`）启动或复用单端口离线控制台，把 `artifact-graph` 设计态审阅与 Foundation 运行态监控合并在同一工作区内执行。

## 一、职责与安全边界

- **本地只读扫描受审仓库**：控制台扫描 `--root` 与 `--scan-roots` 下携带 `artifact-graph.config.yaml` 的技能族、制品线与业务线仓库，仅通过受限路径读取制品与图谱，绝不修改任何受审仓库受 Git 跟踪的文件。
- **零侵入审阅台账**：审阅结论与批注集中写入启动根目录下的 `.skill-family-studio/reviews.json`（或 `--reviews-file` 显式指定的相对路径）。若检测到历史 `artifacts/reviews/workbench-reviews.json`，仅做只读兼容导入。
- **回环安全与纯离线交付**：HTTP 服务仅绑定 `127.0.0.1`，拦截非本地 `Host` 与 `Origin` 请求头；界面样式与脚本 100% 本地离线提供，不发起任何外网请求。
- **不越权执行外部写动作**：本技能不执行 `git commit`、`git push`、`git tag` 或包发布。

## 二、执行步骤

1. **检查环境与健康状态**：在已配置 Node.js `>=22.22.2 <23` 的终端中运行诊断，确认本地运行时、离线宽屏资产与仓库发现正常：

   ```bash
   npx skill-family-studio doctor --root /absolute/project/path
   ```

2. **幂等启动或复用单端口控制台**：需要为用户、制品助手（`artifact-chain-assistant`）或本地长程任务（`local-long-task`）打开可视化界面时，优先调用 `ensure`。若目标端口已有运行中的 Studio 实例会直接复用，不会重复拉起冲突进程：

   ```bash
   npx skill-family-studio ensure --root /absolute/project/path --port 57630 --tab graph
   ```

   需要指定初始页签或默认仓库时，可传入 `--tab <guide|graph|review|runtime>` 与 `--repo <group/repo-name>`。

3. **引导用户按四步动线审阅或排查运行态**：
   - **选定仓库**：在顶栏左侧「当前项目」切换目标仓库（不再区分内部审阅批次；选中 `skill-family-workspace` 时，其生命周期讲解 `LC`、原始故事对照 `US` 与 `Archify` 架构图均作为标准分类展示）。
   - **宽屏看图**：在「🕸️ 制品图谱」使用默认开启的「适应屏宽」与「自动折行排布」查看全局依赖，无需横向翻页。
   - **四态审阅**：点击「▶ 开始按推荐顺序审阅」；阅读中添加至少 1 条未解决批注会自动点亮为 `reviewing`（审阅中），全部解决或清空且未给终态结论时自动回到 `pending`（待审阅）；定稿后点选 `approved`（已通过）、`changes_requested`（需修改）或 `deferred`（暂缓），并在顶栏右侧进度胶囊一键导出 Markdown 验收单。
   - **运行监控**：在「⚡ 运行监控」查看 `state-store` 事件哈希链、`token-lock` 持锁时长预警与 `supervise-process` 子进程状态。

4. **离线快照采证（无需常驻端口时）**：仅需向主控智能体汇报当前制品规模、未决批注或运行态摘要时，直接执行：

   ```bash
   npx skill-family-studio snapshot --root /absolute/project/path
   ```

## 三、结果返回说明

完成调用后，按以下结构向用户或主控会话汇报事实：

```markdown
### Skill Family Studio 控制台状态
- **访问入口与模式**：`<http://127.0.0.1:57630/...>`（`<复用既有实例 / 新启动守护进程 / 离线快照>`）
- **已发现项目规模**：共 `<N>` 座仓库，当前聚焦 `<仓库标识>`
- **当前审阅进度**：已通过 `<X>` · 审阅中 `<Y>` · 需修改 `<Z>`（待解决批注 `<K>` 条）
- **运行态健康摘要**：活跃令牌锁 `<L>` 把，事件哈希链 `<VALID / EMPTY / NO_STORE>`
```
