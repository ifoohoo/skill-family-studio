// @feature STU002
// @feature STU006

export const STUDIO_GUIDE_MODEL = Object.freeze({
  title: 'Skill Family Studio 使用说明书',
  subtitle: '不用背命令行、不用猜读取顺序——一个本地端口统一搞定跨仓需求对齐、故事优先审阅、长任务推进树与多智能体会话编队。',
  whyItExists: [
    '无论是独自维护一个技能族仓库，还是协助管理“1 个高阶规划仓 + 多个子技能族详设仓”的业务域套组，初次打开或验收项目时最常遇到五个困惑：不知道先对智能体说什么就能打开界面、不知道上百份文档该从哪篇读起、分不清哪条需求只是“派了单”还是“真写完了代码并跑通测试”、看不清长任务执行树推进到哪一步以及派出去的多个子智能体正在干什么、还经常在点击图表或目录时被页面跳回顶部打断阅读。',
    'Skill Family Studio 把这些场景全部收拢进单一本地回环端口（默认 127.0.0.1:57630）：左上角切换当前项目，中间固定「使用说明、制品图谱、逐项审阅、运行监控」四个页签，右上角随时查看审阅进度并导出验收单。界面里所有概念旁都有就地「ⓘ」悬停气泡可随时查阅；所有批注和结论均保存在 Studio 自管目录（默认 .skill-family-studio/reviews.json），绝不改动任何受审仓库受 Git 跟踪的文件。',
  ],
  conversationalStart: {
    title: '一、零门槛开启：直接对智能体说一句话即可',
    intro: '你不需要记住任何启动参数，也不用先写配置文件。在正在工作的项目目录里直接对你的智能体（如 Antigravity / Claude Code / Codex）说出你的意图即可：',
    samplePrompts: [
      { intent: '想看全盘结构或开始审阅', say: '“打开工作台，带我看下这个项目的设计。”' },
      { intent: '想核对需求拆分与实现对齐', say: '“打开逐项审阅，帮我核对需求进展和代码锁有没有漂移。”' },
      { intent: '想盯长程任务和多智能体协作', say: '“打开运行监控，看看任务推进树和派出去的子会话跑到哪一步了。”' },
    ],
    behindTheScenes: [
      '第一步（静默体检）：智能体先只读运行环境探针（inspect-setup），自动识别当前目录属于单技能族仓库、高阶规划仓、详设子仓还是多仓父目录，同时探测是否已经绑定了上下游仓库或存在活跃运行源。',
      '第二步（智能决策）：如果是无上下游绑定的单技能族项目，智能体默认只扫描当前这一个仓库（--scan-roots none），避免把父目录里无关仓库全塞进下拉框，直接拉起控制台并给你一条明确的固定审阅路线。',
      '第三步（仅当必要时问一道三选题）：如果检测到当前仓已与上下游仓关联但还没有 .studio-workspace.json，智能体只用大白话问你一次三选一：① 仅聚焦当前仓；② 自动纳入关联上下游仓以支持跨仓互跳；③ 指定业务域扫描目录并由智能体代写配置。',
    ],
  },
  usageModes: [
    {
      id: 'single-repo',
      title: '单技能族项目模式（聚焦本仓、零配置即开）',
      audience: '适合独立开发或验收单一技能族的开发者与审阅者',
      whenToUse: '当你只关心当前这一个仓库里的“用户故事 / 需求 → 详设 → 代码与测试锁”闭环时使用。',
      howItWorks: '系统自动只读取本仓 artifact-graph.config.yaml 与标准 artifacts/ 目录（故事、需求、场景、架构与代码测试锁），不混入父目录里其他项目，同时在「逐项审阅」体检本仓核心源码和 SKILL.md 入口是否都已被版本锁认领。',
    },
    {
      id: 'domain-portfolio',
      title: '业务域多仓套组模式（1 个高阶规划仓 + N 个子技能族详设仓）',
      audience: '适合跨仓规划架构师、产品负责人与多仓协同团队',
      whenToUse: '当一个业务域由“1 个高阶规划仓（总体需求与业务闭环） + 多个子技能族仓（各自落地详设与代码）”组成时使用。',
      howItWorks: '由智能体代写或在项目根目录放置 .studio-workspace.json（也可写在 artifact-graph.config.yaml 顶层 studio 节），声明跨组扫描目录 scanRoots、自然分组名 groupLabels 与扩展故事/Archify 集合 collections。即可在同一界面查看高阶拆分三列一览表并实现一键跨仓互跳。',
    },
  ],
  roleRoutes: [
    {
      id: 'pm-review',
      roleTitle: '动线一：产品负责人 / 业务需求验收（4 步闭环）',
      when: '适合刚接手项目、需要按“诉求 → 拆解去向 → 验收结论”系统过一遍全部设计的人，照着顺序走完即可，无需自由抽样。',
      steps: [
        {
          step: 1,
          title: '在顶栏左上角确认当前项目',
          detail: '点击左上角「当前项目」确认自己正处在高阶规划仓还是某个具体子仓（角色徽章会直接写明；点空白处或按 Escape 即可随时收起下拉框）。',
          actionId: 'open-repo-switcher',
          actionLabel: '打开项目切换器 →',
        },
        {
          step: 2,
          title: '核对「需求进展与双向对齐总览表」',
          detail: '切到「📝 逐项审阅」，先看总览表的三列核心信息：这条需求分给了谁、由下游文件和代码测试锁机器算出的真实「满足概况」是什么、是否存在漏拆或摘要漂移；点任意下游胶囊可直接跨仓跳入子仓详设。',
          actionId: 'go-tab-alignment',
          actionLabel: '看三列进展总览 →',
        },
        {
          step: 3,
          title: '按「故事 → 需求 → 场景」主线批注签收',
          detail: '点击「▶ 开始按推荐顺序审阅」，工作台按“理解诉求（用户故事）→ 核对边界（需求总纲）→ 细看行为（场景剧本）”带你逐篇读完人读文稿（机器 .json 契约已自动单独收纳到底部，不会打断阅读）；写下第一条未解决批注自动转「🔵 审阅中」，确认无误点击「✓ 通过并审下一项 →」。',
          actionId: 'start-guided-review',
          actionLabel: '开始按推荐顺序审阅 →',
        },
        {
          step: 4,
          title: '导出完整 Markdown 审阅验收单',
          detail: '点右上角「审阅进度胶囊」，抽屉自动汇总各仓已通过、审阅中、需修改与待解决批注清单，支持一键复制或下载存档（按 Escape 或点击遮罩空白即可关闭）。',
          actionId: 'open-export-drawer',
          actionLabel: '打开导出抽屉 →',
        },
      ],
    },
    {
      id: 'dev-arch',
      roleTitle: '动线二：架构师 / 技能族开发者（3 步对齐与排错）',
      when: '适合改完详细设计或新增代码与技能入口后，快速确认上下游依赖没断链、代码已被版本锁认领、没有跨仓漂移。',
      steps: [
        {
          step: 1,
          title: '在「🕸️ 制品图谱」看全局依赖与业务闭环',
          detail: '在宽屏图谱中点击任意节点，右侧直接弹出正文阅读，画布坐标 100% 恒定不会乱跳；顶部面包屑定位条显示所属分层和上下游条数，可按需开启「仅看上下游关联子图」。若有 Archify 业务逻辑图可切换并一键全屏对照。',
          actionId: 'go-tab-graph',
          actionLabel: '打开宽屏制品图谱 →',
        },
        {
          step: 2,
          title: '检查单仓代码/技能入口认领覆盖率',
          detail: '打开「📝 逐项审阅 → 需求进展与双向对齐总览」，看页面下方「单仓内部详设 ↔ 代码与测试双向互锁」KPI，确认未认领入口（UNCLAIMED_IMPLEMENTATION_ENTRY）与锁漂移均为 0。',
          actionId: 'go-tab-alignment',
          actionLabel: '查单仓代码锁体检 →',
        },
        {
          step: 3,
          title: '点选胶囊跨仓互跳修补漂移条目',
          detail: '若看到「高阶已变待同步详设」或「详设已演进待回写高阶」，直接在表格点下游胶囊或正文顶部的「↖ 上游高阶来源」跨仓定位原文核对，再刷新版本锁与双向绑定。',
          actionId: 'go-tab-review',
          actionLabel: '进入跨仓正文对照 →',
        },
      ],
    },
    {
      id: 'fleet-supervisor',
      roleTitle: '动线三：长程任务与多智能体监督（3 步盯控）',
      when: '适合你让主智能体拆了好几个波次或派出一队子智能体干活，想直观掌握推进卡点、协作往来和每条委派详情时使用。',
      steps: [
        {
          step: 1,
          title: '看「🌳 任务推进树」掌握当前处于哪一环节',
          detail: '进入「⚡ 运行监控」默认即进入任务推进树。顶部聚焦横幅直接亮出当前正在执行的具体路径与完成比例，下方可逐层展开“迭代波次 → 父任务 → 子步骤”及前置依赖 blockedBy。',
          actionId: 'go-tab-runtime',
          actionLabel: '打开任务推进树 →',
        },
        {
          step: 2,
          title: '看「🛰️ 会话与子会话编队」掌握多智能体协同全貌',
          detail: '切到第二子页签，左侧树状网络展示主会话与全部子会话的型号、运行状态与上下文负载（点击任意卡片位置不变且高亮链路），右侧泳道画出委派与回报时序箭头，底部检查器可查看每次委派的任务简报并切换「原文 / Markdown」。',
          actionId: 'go-tab-fleet',
          actionLabel: '打开会话编队面板 →',
        },
        {
          step: 3,
          title: '仅在疑似卡死或超时时点开「🩺 底层排障」',
          detail: '日常监督完全不需要看第三子页签；只有当任务长时间停滞、怀疑写锁没释放或子进程超时代杀时，再点开底层排障查看实时锁读秒、事件哈希链并点击「🔓 释放沙箱锁」。',
          actionId: 'go-tab-diag',
          actionLabel: '打开底层排障诊断 →',
        },
      ],
    },
  ],
  perPageAnatomy: [
    {
      page: '全局顶栏（所有页面固定可见）',
      when: '无论处于哪个页签，随时切换仓库、识别角色健康度和导出成果。',
      areas: [
        '左侧「当前项目」切换器：按工作区分组展示所有仓库与角色徽章（高阶规划仓 / 详设子仓 / 单项目仓）；点触发器外任意空白或按 Escape 立即收起。',
        '角色与版本锁徽章：实时标出本仓制品版本锁是否新鲜（如 锁新鲜 102/102）及未闭合告警；悬停「ⓘ」即可看清含义。',
        '右侧进度胶囊与外观切换：统计「已通过 / 审阅中 / 需修改 / 共 N 项」，点击展开导出抽屉；支持浅色 / 深色双主题一键切换。',
      ],
    },
    {
      page: '🕸️ 制品图谱页（全局结构与关系视图）',
      when: '第一次熟悉陌生项目架构、核对需求到场景/测试的连线、或对照 Archify 业务逻辑图阅读时使用。',
      areas: [
        '左/主画布区：支持在「制品依赖图谱（6 层结构）」与「Archify 业务逻辑图」之间切换；开启「适应屏宽」与「自动折行排布」后在 1920px / 2560px / 3440px 下无横向溢出。',
        '防跳变定位条与全屏模式：点击任何矩形节点时全图坐标 100% 保持不动，仅原地高亮连线与顶部面包屑定位条；可点击「仅看上下游关联子图」过滤无关节点，全屏下按 Escape 平滑退出。',
        '右侧联动阅读区：即时打开当前选中节点的全文、章节锚点、审阅结论按钮及批注列表。',
      ],
    },
    {
      page: '📝 逐项审阅页（核对齐与批注签收主阵地）',
      when: '需要核对需求是否真正拆分并满足、逐篇阅读设计文档写修改意见并签署结论时使用。',
      areas: [
        '顶部双视角切换条：在「📋 需求进展与双向对齐总览表」和「📖 按阅读任务逐篇审阅」之间一键切换；配「▶ 跳至下一项待审条目」顺着主线推进。',
        '对齐总览三列表 + 单仓锁指标：高阶仓看「业务处置与去向 / 机器派生满足概况 / 双向健康度」三列并直接点击下游跨仓跳转；子仓看上游绑定列表与「↖ 上游高阶来源」回指；底部看本仓代码/技能认领情况。',
        '逐篇阅读三栏区：左侧目录按「首要阅读（故事/需求/场景）」「关联依据（领域/架构/验证）」「结构化数据契约（.json/.yaml 单独收纳）」清晰分层；点开 .json 文件默认呈现结构化摘要表格，同时在顶部提供「📖 切换到对应的人读版 Markdown 文档」与「📊 摘要 / { } 源码」切换。',
      ],
    },
    {
      page: '⚡ 运行监控页（三大场景化观测视图）',
      when: '需要实时盯控长程任务树、追踪多智能体会话委派与回报、或排查卡死锁冲突时使用。',
      areas: [
        '🌳 任务推进树（默认首屏）：顶部聚焦横幅直接告诉你当前正在执行哪一环，下方可折叠展开「波次 → 阶段 → 子任务 → 步骤」并支持 [全部 | 仅看未完成 | 聚焦当前活跃链路] 过滤。',
        '🛰️ 会话与子会话编队：顶部 4 项脉冲指标 + 左「Agent 会话网络」拓扑卡片（点击位置不动）+ 右上「跨会话协作泳道」时序连线 + 下「协作任务 & 事件检查器」（[Markdown 渲染 | 原文] 切换）。',
        '🩺 底层排障与健康诊断（按需展开）：平时顶部一行绿灯汇总健康态即可，异常时再点开检查文件锁每秒读秒、state-store 哈希链完整性与受管子进程超时标记，并可一键「🔓 释放沙箱锁」。',
      ],
    },
  ],
  alignmentGuide: {
    satisfactionStates: [
      {
        code: 'verified_satisfied',
        badge: '🟢 已验证满足',
        meaning: '下游全部承接目标存在、上下游摘要双向一致，且下游仓库的 traceability-version-lock.json 同时具备新鲜的 implements 代码锁与 verifies 测试验证锁（只读冻结仓含有效的 verifiedReceiptPath 验证收据）。绝不靠手工台账声称满足。',
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
  faq: [
    {
      q: '为什么我在项目下拉框里只看到了当前一个仓库？以前怎么把整个目录都扫进来了？',
      a: '当你在一个没有绑定上下游关系的独立单仓启动时，智能体会默认传入 --scan-roots none 只聚焦当前仓库，避免把同级无关目录全部塞进列表。如果你确实需要跨仓联动，对智能体说“帮我把同级兄弟仓或关联上下游也纳入工作台”或点击生成 .studio-workspace.json 即可。',
    },
    {
      q: '为什么在「逐项审阅」里点击文件或点击图谱节点时，画面不会再把节点挪到最前面或跳回顶部了？',
      a: '画布布局引擎现已保证全图坐标 100% 恒定：点选节点只原地高亮关联连线、更新顶部位置面包屑并打开右侧正文，不会打乱你的空间记忆；审阅页切换或提交批注时也会原位保留滚动条进度。',
    },
    {
      q: '列表最下面新增的「结构化数据契约 (.json/.yaml)」是什么？审阅时一定要一个个点开吗？',
      a: '它们是供自动化脚本、状态机检查与门禁校验读取的结构化数据契约，正常引导审阅流程（「▶ 开始按推荐顺序审阅」）会自动跳过它们、优先带你读完人读 Markdown 文稿。当你想核对字段细节时点开即可，界面默认整理为表格卡片，且顶部支持直接切到配对的 Markdown 原文或源码。',
    },
    {
      q: '日常监督长程任务时，「🩺 底层排障与健康诊断」里的文件锁与哈希链什么时候才需要看？',
      a: '平时看进度只盯第一页签「🌳 任务推进树」和第二页签「🛰️ 会话与子会话编队」就够了。只有当页面提示告警数字、任务长时间停滞不前、或者怀疑有未释放的排他写锁阻断后续步骤时，再展开「🩺 底层排障」定位超时锁并一键释放。',
    },
    {
      q: '我在界面里点「已通过」或记了好多批注，会不会弄脏受审项目的 Git 工作区？',
      a: '不会。所有审阅结论和批注都统一存放在工作台启动根目录的 .skill-family-studio/reviews.json 中，受审兄弟仓库完全保持只读、零写入。',
    },
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
    `## ${m.conversationalStart.title.replace(/^一、/, '二、')}`,
    '',
    m.conversationalStart.intro,
    '',
    '| 你的目的 | 对智能体说的一句话示例 |',
    '| --- | --- |',
    ...m.conversationalStart.samplePrompts.map(s => `| ${s.intent} | ${s.say} |`),
    '',
    ...m.conversationalStart.behindTheScenes.map(step => `- ${step}`),
    '',
    '### 两种工作模式（由智能体自动适配或代配）',
    '',
  ];
  for (const mode of m.usageModes) {
    lines.push(
      `#### ${mode.title}`,
      '',
      `- **适用读者**：${mode.audience}`,
      `- **何时选用**：${mode.whenToUse}`,
      `- **工作方式**：${mode.howItWorks}`,
      '',
    );
  }
  lines.push('## 三、按你的角色与来意选一条动线', '');
  for (const r of m.roleRoutes) {
    lines.push(`### ${r.roleTitle}`, '', `> ${r.when}`, '');
    for (const s of r.steps) {
      lines.push(`${s.step}. **${s.title}**：${s.detail}`);
    }
    lines.push('');
  }
  lines.push('## 四、逐页界面全拆解（每个区域是什么、什么时候看、怎么用）', '');
  for (const p of m.perPageAnatomy) {
    lines.push(`### ${p.page}`, '', `- **什么时候看这里**：${p.when}`, ...p.areas.map(a => `- ${a}`), '');
  }
  lines.push(
    '## 五、状态流转图与三层双向互锁原理图',
    '',
    '### 1. 审阅四态自动与手动迁移图',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> pending: 初次进入',
    '  pending --> reviewing: 添加第1条未解决批注（自动）',
    '  reviewing --> pending: 批注全部解决/清空且无终态结论（自动）',
    '  pending --> approved: 点击「已通过」',
    '  reviewing --> approved: 点击「通过并审下一项」',
    '  reviewing --> changes_requested: 点击「需修改」',
    '  pending --> deferred: 点击「暂缓」',
    '```',
    '',
    '| 状态标识 | 触发与自动感知条件 | 业务含义 |',
    '| --- | --- | --- |',
    ...m.statusRules.map(r => `| **${r.badge}** (\`${r.code}\`) | ${r.trigger} | ${r.meaning} |`),
    '',
    '### 2. 高阶 ⇄ 详设 ⇄ 代码测试三层双向互锁闭环图',
    '',
    '```mermaid',
    'flowchart LR',
    '  P["高阶规划仓<br/>(portfolio-allocations.json)"] <-->|"sourceDigest / targetDigest 双向校对"| S["子仓详细设计<br/>(upstream-bindings.json)"]',
    '  S <-->|"implements 代码锁 + verifies 验证锁"| C["真实源码与测试<br/>(traceability-version-lock.json)"]',
    '  C -->|"同时新鲜才判定已满足"| V["🟢 verified_satisfied"]',
    '```',
    '',
    '| 满足概况徽章 | 机器派生依据与业务含义 |',
    '| --- | --- |',
    ...m.alignmentGuide.satisfactionStates.map(s => `| **${s.badge}** (\`${s.code}\`) | ${s.meaning} |`),
    '',
    '| 告警徽章与错误码 | 识别到什么问题 | 推荐处理动作 |',
    '| --- | --- | --- |',
    ...m.alignmentGuide.driftChecks.map(d => `| **${d.badge}** (\`${d.code}\`) | ${d.meaning} | ${d.action} |`),
    '',
    '## 六、高频疑问解答 FAQ',
    '',
  );
  for (const f of m.faq) {
    lines.push(`### Q：${f.q}`, '', `A：${f.a}`, '');
  }
  lines.push(
    '<details>',
    '<summary>附录：脚本自动化 CLI 与 `.studio-workspace.json` 配置参考（日常由智能体代劳，按需展开）</summary>',
    '',
    '```bash',
    '# 只读探测当前仓库角色（单仓 / 高阶仓 / 详设子仓）与推荐启动参数',
    'npx skill-family-studio inspect-setup --root /absolute/project/path --json',
    '',
    '# 按单仓或关联套组安全生成 .studio-workspace.json',
    'npx skill-family-studio init-workspace --root /absolute/project/path --mode related',
    '',
    '# 幂等守护启动或复用单端口控制台（若已有实例未收录当前仓，会自动隔离分配空闲端口）',
    'npx skill-family-studio ensure --root /absolute/project/path --port 57630',
    '',
    '# 离线导出设计态、双向对齐与运行态快照',
    'npx skill-family-studio snapshot --root /absolute/project/path',
    '',
    '# 核验本地 Node.js 版本、离线前端资产与仓库发现状态',
    'npx skill-family-studio doctor --root /absolute/project/path',
    '```',
    '',
    '声明式多仓配置 `.studio-workspace.json` 示例（可放在高阶规划仓根目录，或等价写入 `artifact-graph.config.yaml` 顶层 `studio` 节）：',
    '',
    '```json',
    '{',
    '  "schemaVersion": "1.0",',
    '  "role": "portfolio",',
    '  "title": "我的业务域规划工作区",',
    '  "scanRoots": ["..", "../sub-skills"],',
    '  "groupLabels": { "my-domain": "业务域技能族" },',
    '  "collections": [',
    '    { "id": "domain-stories", "kind": "lifecycle-story-pack", "storiesJson": "artifacts/stories/stories.json", "explanationsDir": "artifacts/stories/explanations" },',
    '    { "id": "business-diagrams", "kind": "archify-model-scenes", "manifestJson": "artifacts/diagrams/model-and-scenes.json" }',
    '  ]',
    '}',
    '```',
    '',
    '</details>',
  );
  return `${lines.join('\n')}\n`;
}
