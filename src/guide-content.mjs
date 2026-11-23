// @feature STU002

export const STUDIO_GUIDE_MODEL = Object.freeze({
  title: 'Skill Family Studio 使用说明书',
  subtitle: '单端口统一承载跨仓需求进展对齐、故事优先宽屏审阅与 Foundation 运行态监控。',
  whyItExists: [
    '无论是独立维护一个技能族仓库，还是协同管理“1 个高阶规划仓 + 多个子技能族详设仓”的业务域套组，团队在审阅与验收时最常遇到四个断点：不知道从哪篇文档读起、看不出高阶需求有没有真正拆到底下仓库并写锁测试、改完代码或详设后上下游逐渐脱节、以及设计图谱和运行监控分在两个端口来回跳转。',
    'Skill Family Studio 把这四件事收拢进同一个本地回环端口（默认 127.0.0.1:57630）和同一套顶栏导航：左上角切换项目，中间固定「使用说明、制品图谱、逐项审阅、运行监控」四个页签，右上角随时查看审阅进度并导出验收单。所有批注与结论集中在 Studio 自管台账（默认 .skill-family-studio/reviews.json），绝不修改任何受审仓库受 Git 跟踪的源码或文档。',
  ],
  usageModes: [
    {
      id: 'single-repo',
      title: '单技能族项目模式（零配置开箱即用）',
      audience: '适合独立开发或维护单一技能族的外部业务域开发者',
      whenToUse: '当你只关心自己仓库里的“需求 / 用户故事 → 详设 → 代码与测试锁”闭环时，直接在项目根目录启动控制台即可，无需编写任何额外配置文件。',
      howItWorks: '控制台自动读取本仓的 artifact-graph.config.yaml，同时轻量发现同一父目录下的兄弟受管仓库；自动识别标准 artifacts/ 下的故事、需求、图表与设计制品，并在「逐项审阅」中体检本仓代码入口是否都已被 traceability-version-lock.json 认领。',
      command: 'npx skill-family-studio ensure --root . --port 57630',
    },
    {
      id: 'domain-portfolio',
      title: '业务域多仓套组模式（1 个高阶规划仓 + N 个子技能族详设仓）',
      audience: '适合跨仓规划架构师、产品经理与多仓协同团队',
      whenToUse: '当一个业务域由“1 个高阶规划仓（负责总体需求拆分与业务闭环） + 多个子技能族仓（各自落地详设与代码）”组成时，在高阶仓根目录放置声明式的 .studio-workspace.json（或写在 artifact-graph.config.yaml 的 studio 节）来组织跨仓视图。',
      howItWorks: '通过 scanRoots 指定跨组扫描目录、groupLabels 定义自然分组标签、collections 挂载自定义故事包（lifecycle-story-pack）或 Archify 业务闭环图（archify-model-scenes）。高阶仓通过 artifacts/portfolio-allocations.json 登记拆分去向，子仓通过 artifacts/upstream-bindings.json 回指上游，实现双向对齐与一键跨仓互跳。',
      command: 'npx skill-family-studio ensure --root /absolute/portfolio/repo --port 57630',
    },
  ],
  readingOrderGuide: [
    {
      step: 1,
      stage: '理解诉求 · 用户故事',
      why: '先读用户故事（US），搞清楚“谁在什么处境下想完成什么任务、期待什么可观察结果”，避免一开始就陷入技术字段和文件树里迷路。',
    },
    {
      step: 2,
      stage: '核对进展 · 需求进展与双向对齐三列一览表',
      why: '在「逐项审阅」顶部的三列一览表核对每条需求“分给了谁、由代码/测试锁机器算出的真实满足概况是什么、上下游有没有漂移”，再点击具体需求查看正文或跨仓跳到子项目。',
    },
    {
      step: 3,
      stage: '看清全局 · 宽屏制品图谱与 Archify 业务闭环',
      why: '切到「🕸️ 制品图谱」看清上下游依赖全貌；若项目配有 Archify 业务闭环图，可全屏展开并点击图节点直接跳到对应的说明章节。',
    },
    {
      step: 4,
      stage: '细看行为与依据 · 场景剧本、领域决策与测试追溯',
      why: '最后按需核对场景剧本（前提/动作/预期结果）、架构设计与实现/测试锁覆盖，确认每项承诺都有真实代码和测试承接。',
    },
  ],
  fiveSteps: [
    {
      step: 1,
      title: '在顶栏左侧选定要看的项目或业务域套组',
      whenAndWhat: '点击左上角「当前项目」下拉框，按当前工作区声明的分组浏览或关键字过滤仓库。每个项目会直接标注角色（如高阶规划仓 / 详设子仓）、制品节点数、版本锁新鲜度与是否有活跃运行任务；工作区配置中的扩展故事包与 Archify 图谱会自动汇总到对应仓库分类中。',
      actionId: 'open-repo-switcher',
      actionLabel: '立即体验：展开项目切换器 →',
    },
    {
      step: 2,
      title: '在「制品图谱」看清全局依赖与业务闭环',
      whenAndWhat: '切到「🕸️ 制品图谱」页签，画布按显示器真实宽度（1920px、2560px 2K、3440px 带鱼屏）自适应铺满，单层超多节点自动折成多行网格，无需横向拖拽滚动条。包含 Archify 业务图时可一键全屏展开，点击图节点直接定位右侧关联说明文档与章节锚点。',
      actionId: 'go-tab-graph',
      actionLabel: '立即体验：打开宽屏制品图谱 →',
    },
    {
      step: 3,
      title: '先查「需求进展与双向对齐总览」，再跨仓互跳对照原件',
      whenAndWhat: '进入「📝 逐项审阅」页签，可一键在「📋 需求进展与双向对齐总览表」和「📖 按阅读任务逐篇审阅」之间切换。高阶规划仓展示业务处置与去向、机器派生满足概况、双向健康度三列；点击下游承接胶囊直接跨仓跳到子项目详设，在子项目阅读页顶部点击「↖ 上游高阶来源」即可跳回高阶条目。',
      actionId: 'go-tab-alignment',
      actionLabel: '立即体验：查看需求对齐总览 →',
    },
    {
      step: 4,
      title: '按推荐顺序逐篇阅读、记批注并流转四态签收',
      whenAndWhat: '点击「▶ 开始按推荐顺序审阅」，系统按「用户故事 → 需求总纲 → 场景剧本 → 领域与架构依据」定位到第一篇待审条目。写下第一条未解决批注会自动点亮「🔵 审阅中」；批注全部解决或清空且未给终态结论时自动回到「⚪ 待审阅」；确认无误点击「✓ 通过并审下一项 →」连贯推进。',
      actionId: 'start-guided-review',
      actionLabel: '立即体验：按推荐顺序开始审阅 →',
    },
    {
      step: 5,
      title: '导出验收单，或在「运行监控」实时排查卡点',
      whenAndWhat: '顶栏右侧胶囊实时统计「已通过 / 审阅中 / 需修改 / 共 N 项」，点击即可复制或下载 Markdown 验收单与 JSON 台账。排查长程任务卡点时切到「⚡ 运行监控」，在当前项目与全工作区活跃源之间切换，直接钻取里程碑进度、实时文件锁读秒、事件哈希链与子进程轨迹。',
      actionId: 'open-export-drawer',
      actionLabel: '立即体验：打开审阅汇总与导出 →',
    },
  ],
  alignmentGuide: {
    satisfactionStates: [
      {
        code: 'verified_satisfied',
        badge: '🟢 已验证满足',
        meaning: '下游全部承接目标存在、上下游摘要双向一致，且下游仓库的 traceability-version-lock.json 具备新鲜的代码实现锁与测试验证锁（只读冻结仓含有效的 verifiedReceiptPath 验证收据）。绝不靠手工台账声称满足。',
      },
      {
        code: 'partially_allocated',
        badge: '🔵 部分覆盖',
        meaning: '需求已拆出部分下游承接，但 remainingScope 仍列有未覆盖的剩余范围，界面会逐条标出尚未落地的部分。',
      },
      {
        code: 'allocated_in_progress',
        badge: '⏳ 已派单推进中',
        meaning: '需求已分配给下游技能族仓，但下游目标尚在完善、存在摘要漂移，或下游代码与测试锁尚未齐全验证。',
      },
      {
        code: 'not_applicable',
        badge: '⚪ 按处置不计满足',
        meaning: '该需求被明确处置为暂缓（deferred）、合并（merged）或废弃（abandoned），不会混入已满足比例中虚增进度。',
      },
    ],
    driftChecks: [
      {
        code: 'UNALLOCATED_ACTIVE_DEMAND',
        badge: '🔴 高阶漏拆',
        meaning: '高阶规划仓中有活跃（allocated）需求，但 allocations 列表为空，还没有任何子项目认领。',
        action: '补齐目标子项目承接关系，或在详设确认后暂缓/合并该需求。',
      },
      {
        code: 'UPSTREAM_DESIGN_CHANGED',
        badge: '🟠 高阶已变待同步详设',
        meaning: '高阶需求原文自上次绑定以来发生过修订，子项目的详细设计尚未同步更新摘要。',
        action: '点击下游胶囊跨仓进入子项目核对变动并更新详设与 upstream-bindings.json。',
      },
      {
        code: 'DOWNSTREAM_DESIGN_EVOLVED',
        badge: '🟠 详设已演进待回写高阶',
        meaning: '子项目在编写手册或实现中演化了详设内容，但高阶规划仓的 portfolio-allocations.json 记录的还是旧摘要。',
        action: '点击「↖ 上游高阶来源」回到高阶规划仓核实影响，并刷新双向绑定锁。',
      },
      {
        code: 'UNCLAIMED_IMPLEMENTATION_ENTRY',
        badge: '🟠 单仓代码/技能未认领',
        meaning: '单仓匹配 implementationSurface.entryGlobs 的核心源码或 SKILL.md 入口文件，尚未在 traceability-version-lock.json 中绑定任何 @feature / @scenario 锁。',
        action: '在对应源码或技能顶部补齐追溯注解并运行 artifact-graph version-lock refresh --all。',
      },
    ],
  },
  statusRules: [
    {
      code: 'pending',
      badge: '⚪ 待审阅',
      trigger: '尚未写过任何未解决批注，也未给出终态审阅结论；或者此前记下的批注已全部标为「已解决」/ 删除清空且尚未下结论。',
      meaning: '表示这篇制品还没有进入实质审阅，会排在「下一项待审」队列最前面。',
    },
    {
      code: 'reviewing',
      badge: '🔵 审阅中',
      trigger: '阅读时添加了至少 1 条未解决批注（自动感知点亮），或主动点击了「标为审阅中」且尚未给出通过/需修改/暂缓结论。',
      meaning: '表示审阅者正在边读边记问题、尚未定稿收尾；一旦所有批注解决或清空且未给终态结论，会自动回到「待审阅」。',
    },
    {
      code: 'changes_requested',
      badge: '🟠 需修改',
      trigger: '主动点击「需修改」按钮提交结论（通常附带未解决批注或结论备注）。',
      meaning: '明确要求作者依据批注返工修订，导出验收单时会归入待整改项。',
    },
    {
      code: 'approved / deferred',
      badge: '🟢 已通过 / 🟣 暂缓',
      trigger: '主动点击「已通过」（或「✓ 通过并审下一项 →」）完成签收，或点击「暂缓」留待后续轮次。',
      meaning: '当前轮次已有明确裁决，自动引导动线会跳过该篇并定位下一篇未签收条目。',
    },
  ],
  widescreenTips: [
    '画布容器解除固定宽度上限（max-width: none），在 1920px、2560px 2K 屏与 3440px 21:9 超宽带鱼屏上均 100% 利用横向视口，少节点层自动居中保持舒展间距。',
    '开启「自动折行排布」后，单层包含几十个节点的仓库会自动排成多行网格，既不横向溢出，也不会把节点字号压缩到 11px 以下。',
    '切换到 Archify 业务逻辑图时默认按宽屏满视口渲染并保持左右对照：工具栏支持上一张/下一张切换与一键全屏展开，点击图中任意业务节点即可直接定位并高亮右侧对应说明章节。',
    '在「逐项审阅」页签的大屏视口（>= 1920px）下，界面自动升级为「左目录列表 + 中间舒适正文区 + 右侧粘滞审阅操作与批注栏」三栏布局，可一边对照正文一边批注签收；点击正文右上角「铺满全屏阅读」也可切换通栏显示。',
  ],
  runtimeSubpanels: [
    {
      id: 'tasks',
      title: 'A. 任务与里程碑推进矩阵',
      detail: '自动解析执行计划（Markdown 复选框与进度表、JSON tasks/steps、CSV 清单），渲染多段彩色进度条（已完成/进行中/阻断/待推进），支持按里程碑、状态胶囊与关键字筛选每一条任务明细。',
    },
    {
      id: 'locks',
      title: 'B. 文件锁与并发写集雷达',
      detail: '实时扫面活跃 token-lock、state-store 写入锁与仓库静态 traceability-version-lock.json 概览；前端每秒跳字显示当前持锁时长，超过阈值（默认 30 秒）高亮琥珀色「⚠️ 持锁超时预警」，并可一键释放沙箱排他锁。',
    },
    {
      id: 'chain',
      title: 'C. Foundation 事件溯源哈希链（state-store）',
      detail: '逐条校验证明链从创世摘要（STATE_GENESIS_DIGEST）到最新事件的 SHA-256 哈希连续性，直接展示 VALID / CHAIN_BROKEN / STALE_HEAD 徽章与 #000001..#NNNNNN 事件时间线明细。',
    },
    {
      id: 'processes',
      title: 'D. 受管子进程监督轨迹（supervise-process）',
      detail: '记录每条子进程调用的脚本标签、RUNNING / EXITED / TIMED_OUT / TERMINATED 状态、退出码、耗时以及超时代杀保护标记。',
    },
  ],
  runtimeTips: [
    '顶栏与范围切换联动：切换顶栏「当前项目」时，监控页自动切换范围；点击顶部范围胶囊可在「聚焦当前项目」与「全工作区活跃告警聚合」之间随时切换，也可通过单源下拉筛选器钻取单个运行源。',
    '页内直接挂载与沙箱自检：点击右上角「+ 挂载运行源」填写目标 ID、标题及 stateDir/planPath/runsDir/lockPaths 即可持久化接入新任务源；暂无活跃任务时点击「▶ 运行隔离沙箱演练」生成真实锁与事件链，演练后可点「🔓 释放沙箱锁」即时释放排他锁。',
    'SSE 实时自动同步：服务端监听注册表与沙箱状态变更并通过 SSE 推送 runtime-change 事件，文件锁获取、释放或新事件写入后界面自动更新，无需手动刷新浏览器。',
  ],
});

export function renderUserGuideMarkdown() {
  const m = STUDIO_GUIDE_MODEL;
  const lines = [
    `# ${m.title}`,
    '',
    `> ${m.subtitle}`,
    '',
    '## 一、这款工具解决什么问题',
    '',
    ...m.whyItExists.flatMap(p => [p, '']),
    '## 二、两种开箱即用的工作模式（零硬编码通用适配）',
    '',
  ];
  for (const mode of m.usageModes) {
    lines.push(
      `### ${mode.title}`,
      '',
      `- **适用读者**：${mode.audience}`,
      `- **何时选用**：${mode.whenToUse}`,
      `- **工作方式**：${mode.howItWorks}`,
      '',
      '```bash',
      mode.command,
      '```',
      '',
    );
  }
  lines.push(
    '声明式多仓配置文件 `.studio-workspace.json` 示例（可放在高阶规划仓根目录，或等价写入 `artifact-graph.config.yaml` 的顶层 `studio` 节）：',
    '',
    '```json',
    '{',
    '  "schemaVersion": "1.0",',
    '  "role": "portfolio",',
    '  "title": "我的业务域规划工作区",',
    '  "scanRoots": ["..", "../sub-skills"],',
    '  "groupLabels": {',
    '    "my-domain": "业务域技能族"',
    '  },',
    '  "collections": [',
    '    {',
    '      "id": "domain-stories",',
    '      "kind": "lifecycle-story-pack",',
    '      "storiesJson": "artifacts/stories/stories.json",',
    '      "explanationsDir": "artifacts/stories/explanations"',
    '    },',
    '    {',
    '      "id": "business-diagrams",',
    '      "kind": "archify-model-scenes",',
    '      "manifestJson": "artifacts/diagrams/model-and-scenes.json"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## 三、按阅读任务分主次的审阅动线',
    '',
  );
  for (const r of m.readingOrderGuide) {
    lines.push(`${r.step}. **${r.stage}**：${r.why}`);
  }
  lines.push('', '### 五步走通一次设计审阅与对齐验收', '');
  for (const s of m.fiveSteps) {
    lines.push(`#### 第 ${s.step} 步：${s.title}`, '', s.whenAndWhat, '');
  }
  lines.push(
    '## 四、三层双向一致性体检怎么看、怎么跨仓互跳',
    '',
    '在「📝 逐项审阅」页签的 **「📋 需求进展与双向对齐总览表」** 中，「满足概况」全部由下游仓库的真实文件存在性与代码/测试锁状态机器派生，严禁人工篡改统计口径：',
    '',
    '| 满足概况徽章 | 机器派生依据与业务含义 |',
    '| --- | --- |',
    ...m.alignmentGuide.satisfactionStates.map(s => `| **${s.badge}** (\`${s.code}\`) | ${s.meaning} |`),
    '',
    '常见的四类双向漂移与缺口告警及处理方式：',
    '',
    '| 告警徽章与错误码 | 识别到什么问题 | 推荐操作 |',
    '| --- | --- | --- |',
    ...m.alignmentGuide.driftChecks.map(d => `| **${d.badge}** (\`${d.code}\`) | ${d.meaning} | ${d.action} |`),
    '',
    '**一键跨仓互跳**：在高阶规划仓的总览表中，点击任意下游承接胶囊可直接跳到目标子技能族仓库并定位该详细设计文档；在子技能族阅读页顶部点击「↖ 上游高阶来源」胶囊，可直接切回高阶规划仓并打开对应的上游需求。',
    '',
    '## 五、四种审阅状态的准确含义与流转条件',
    '',
    '| 状态标识 | 触发与流转条件 | 业务含义 |',
    '| --- | --- | --- |',
    ...m.statusRules.map(r => `| **${r.badge}** (\`${r.code}\`) | ${r.trigger} | ${r.meaning} |`),
    '',
    '## 六、宽屏图谱与正文阅读操作技巧',
    '',
    ...m.widescreenTips.map(t => `- ${t}`),
    '',
    '## 七、迭代版「⚡ 运行监控」四大观测子视图与实操指南',
    '',
  );
  for (const sub of m.runtimeSubpanels) {
    lines.push(`### ${sub.title}`, '', sub.detail, '');
  }
  lines.push(
    ...m.runtimeTips.map(t => `- ${t}`),
    '',
    '## 八、常用命令行入口',
    '',
    '```bash',
    '# 启动单端口控制台（默认监听 127.0.0.1:57630）',
    'npx skill-family-studio serve --root /absolute/project/path --port 57630',
    '',
    '# 幂等守护启动（若已在线则直接复用，供技能与自动化脚本调用）',
    'npx skill-family-studio ensure --root /absolute/project/path --port 57630',
    '',
    '# 离线导出设计态 + 审阅台账 + 双向对齐 + 运行态聚合快照',
    'npx skill-family-studio snapshot --root /absolute/project/path',
    '',
    '# 检查本地 Node.js 版本、依赖包与离线前端资产完整性',
    'npx skill-family-studio doctor --root /absolute/project/path',
    '```',
  );
  return `${lines.join('\n')}\n`;
}
