export const STUDIO_GUIDE_MODEL = Object.freeze({
  title: 'Skill Family Studio 使用说明书',
  subtitle: '单端口统一承载宽屏制品图谱审阅、引导式逐项签收与 Foundation 运行态监控。',
  whyItExists: [
    '过去在审阅多个技能族仓库时，常常要在「制品关系图谱」「不同文档池切换」与「独立端口的运行态看板」之间来回跳转，既不清楚该从哪一篇开始看，也不知道写下批注后算不算已经进入审阅。',
    'Skill Family Studio 把全部操作收敛到同一个本地回环端口（默认 127.0.0.1:57630）和同一套顶栏导航：先在左上角选定一个项目仓库，随后围绕该仓库固定使用「使用说明、制品图谱、逐项审阅、运行监控」四个页签。所有审阅批注与结论集中保存在 Studio 自管台账（默认 .skill-family-studio/reviews.json），绝不改动受审仓库受 Git 跟踪的任何源码或文档。',
  ],
  fiveSteps: [
    {
      step: 1,
      title: '在顶栏左侧选定要看的仓库',
      whenAndWhat: '点击左上角「当前项目」下拉框，可按「Skill Family 支撑线 / Artifact 制品线 / GLAF4 业务线」分组浏览或输入关键字筛选。每一行直接标明该仓库的制品节点数、版本锁是否新鲜、已审比例以及是否有活跃运行态任务。选中 skill-family-workspace 时，其 81 条原始需求故事、66 篇生命周期讲解（LC-01..66）、18 项差异承接决议与 14 张 Archify 业务逻辑图会直接作为该仓库的标准分类展示，不再区分任何内部批次。',
      actionId: 'open-repo-switcher',
      actionLabel: '立即体验：展开项目切换器 →',
    },
    {
      step: 2,
      title: '在「制品图谱」看清全局上下游关系',
      whenAndWhat: '切到「🕸️ 制品图谱」页签，画布会自动按当前显示器宽度铺满（支持 1920px、2560px 2K 屏与 3440px 带鱼屏自适应分栏），并把同一层超多节点自动折成多行网格，无需左右拖动底部滚动条。点击任意节点即可在右侧直接阅读原件并记录意见；若当前仓库包含 Archify 业务架构图，可随时一键全屏展开，且点击图节点可直接定位到关联说明文档与具体章节。',
      actionId: 'go-tab-graph',
      actionLabel: '立即体验：打开宽屏制品图谱 →',
    },
    {
      step: 3,
      title: '点「开始按推荐顺序审阅」逐篇阅读与记批注',
      whenAndWhat: '不知道先看哪篇时，直接点击醒目的「▶ 开始按推荐顺序审阅」按钮。系统按「需求总纲 → 用户故事 → 领域与架构设计 → 场景与测试」的先后顺序定位到第一篇待审文档。阅读过程中看到需要调整的段落，填写批注并保存，该篇状态会自动点亮为蓝色的「🔵 审阅中」。',
      actionId: 'start-guided-review',
      actionLabel: '立即体验：按推荐顺序开始审阅 →',
    },
    {
      step: 4,
      title: '用「通过并审下一项」连贯走完审阅闭环',
      whenAndWhat: '读完当前篇后，若内容准确无误，直接点击「✓ 通过并审下一项 →」即可签收并自动跳到下一篇待审文档；若需要作者按批注返工，点击「需修改」；本轮暂不裁决可标为「暂缓」或点击「跳过看下一项 →」。',
      actionId: 'go-tab-review',
      actionLabel: '立即体验：进入逐项审阅工作台 →',
    },
    {
      step: 5,
      title: '在顶栏右侧胶囊查看汇总并导出验收单，或在「运行监控」排查卡点',
      whenAndWhat: '顶栏右侧常驻显示「审阅进度：已通过 X · 审阅中 Y · 需修改 Z / 共 N 项」，点击即可展开汇总抽屉，一键复制或下载 Markdown 验收单与 JSON 台账。若后台正在执行长程任务或门禁脚本，切到「⚡ 运行监控」即可实时查看 state-store 事件哈希链、token-lock 持锁时长预警与子进程退出诊断。',
      actionId: 'open-export-drawer',
      actionLabel: '立即体验：打开审阅汇总与导出 →',
    },
  ],
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
  runtimeTips: [
    '令牌锁（token-lock）看卡点：正常短事务锁会在几秒内释放；若某把锁活跃持锁超过阈值（默认 30 秒），界面会高亮为橙色「持锁超时预警」，并展示持有者标识与路径。',
    '事件哈希链（state-store）看完整性：状态为 VALID 表示从创世摘要（STATE_GENESIS_DIGEST）到最新序号的 SHA-256 链逐条吻合；若出现 CHAIN_BROKEN 则说明状态文件被外部非受管覆写。',
    '受管子进程（supervise-process）看退出原因：直接区分正常退出（EXITED）、监督运行中（RUNNING）、超时强杀（TIMED_OUT）与信号终止（TERMINATED）。若当前仓库暂无运行态任务，可点击页面上的「运行隔离沙箱演练」在系统临时目录体验真实锁与事件链。',
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
    '## 二、五分钟走通一次设计审阅的标准动线',
    '',
  ];
  for (const s of m.fiveSteps) {
    lines.push(`### 第 ${s.step} 步：${s.title}`, '', s.whenAndWhat, '');
  }
  lines.push(
    '## 三、四种审阅状态的准确含义与流转条件',
    '',
    '| 状态标识 | 触发与流转条件 | 业务含义 |',
    '| --- | --- | --- |',
    ...m.statusRules.map(r => `| **${r.badge}** (\`${r.code}\`) | ${r.trigger} | ${r.meaning} |`),
    '',
    '## 四、宽屏图谱与正文阅读操作技巧',
    '',
    ...m.widescreenTips.map(t => `- ${t}`),
    '',
    '## 五、运行态监控怎么看文件锁、哈希链与子进程卡点',
    '',
    ...m.runtimeTips.map(t => `- ${t}`),
    '',
    '## 六、常用命令行入口',
    '',
    '```bash',
    '# 启动单端口控制台（默认监听 127.0.0.1:57630）',
    'npx skill-family-studio serve --root /absolute/project/path --port 57630',
    '',
    '# 幂等守护启动（若已在线则直接复用，供技能与自动化脚本调用）',
    'npx skill-family-studio ensure --root /absolute/project/path --port 57630',
    '',
    '# 离线导出设计态 + 审阅台账 + 运行态聚合快照',
    'npx skill-family-studio snapshot --root /absolute/project/path',
    '',
    '# 检查本地 Node.js 版本、依赖包与离线前端资产完整性',
    'npx skill-family-studio doctor --root /absolute/project/path',
    '```',
  );
  return `${lines.join('\n')}\n`;
}
