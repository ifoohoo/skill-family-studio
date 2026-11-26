// @feature STU006
// @feature STU002

export const GLOSSARY = Object.freeze({
  // 顶栏与项目角色
  'role:portfolio': {
    title: '高阶规划仓',
    meaning: '负责总体业务需求拆解、跨仓分配清单（portfolio-allocations.json）与业务全景流程图的规划仓库。',
    rule: '在「📝 审阅与对齐」第 ① 步提供需求进展与双向对齐总览表，可一键跨仓跳入子项目详设。',
  },
  'role:subproject': {
    title: '详设子仓',
    meaning: '承接高阶需求并落地详细设计、源码与测试锁的具体技能族仓库（含 artifacts/upstream-bindings.json）。',
    rule: '正文阅读顶部会渲染「↖ 上游高阶来源」胶囊，点一下即可跳回高阶规划条目。',
  },
  'role:standalone': {
    title: '单项目仓',
    meaning: '独立维护“需求 / 故事 → 详设 → 代码与测试锁”全链路的仓库，无需额外全局配置。',
    rule: '默认支持直接审阅与单仓代码锁覆盖率体检。',
  },
  versionLock: {
    title: '版本锁新鲜度徽章',
    meaning: '汇总本仓 artifacts/traceability-version-lock.json 中代码实现/测试锁与制品关系锁的 SHA-256 一致性。',
    rule: '全部文件哈希匹配时显示绿色「锁新鲜 (X/Y)」；源码或详设修改后尚未刷新锁时显示漂移告警。',
  },
  progressCapsule: {
    title: '审阅进度与零侵入台账',
    meaning: '统计当前仓库的已通过、审阅中、需修改与暂缓条目数，点击可复制或下载全部受管仓库的 Markdown 验收单。',
    rule: '所有批注与结论仅写入启动根目录的 .skill-family-studio/reviews.json，绝不修改受审仓受 Git 跟踪的文件。',
  },

  // 制品图谱
  graphVsArchify: {
    title: '制品依赖图谱 vs Archify 业务逻辑图',
    meaning: '「制品依赖图谱」展示需求、故事、场景与架构文件的 6 层工程引用关系；「Archify 业务逻辑图」展示面向业务人员的流程与状态交互图。',
    rule: '点击图上任意节点，坐标均保持恒定不跳变，并立即定位右侧对应说明正文。',
  },
  'layer:requirements': { title: '第 1 层 · 需求与规格', meaning: '原始业务需求（REQ）与接口规格（SPEC），定义“要解决什么问题、成功标准是什么”。' },
  'layer:product': { title: '第 2 层 · 产品与故事', meaning: '用户故事（US）、生命周期讲解（LC）与功能特性（PRD Feature），说明“谁在什么情境下要做什么”。' },
  'layer:domain': { title: '第 3 层 · 领域与决策', meaning: '领域模型、术语表、业务专题与关键架构决策记录（ADR），明确概念口径与设计取舍。' },
  'layer:architecture': { title: '第 4 层 · 架构与契约', meaning: '系统总体架构、模块职责边界以及接口/数据/状态机契约。' },
  'layer:scenarios': { title: '第 5 层 · 场景剧本', meaning: '采用“前提条件 → 触发动作 → 预期结果”描述的可直接验收场景剧本。' },
  'layer:verification': { title: '第 6 层 · 测试与验证', meaning: '测试规划、黄金用例以及追溯到源码和自动化测试文件的验证记录。' },
  subgraphOnly: { title: '仅看上下游关联子图', meaning: '临时过滤掉与当前选中节点无直接/两跳依赖关系的节点，专注核对一条需求链路。' },
  'edge:implements': { title: '代码实现边 (implements)', meaning: '表示源码或 SKILL.md 入口文件通过追溯注解认领并实现了某个设计特性或场景。' },
  'edge:verifies': { title: '测试验证边 (verifies)', meaning: '表示自动化测试文件覆盖并验证了某个功能特性或验收场景。' },
  'edge:covers': { title: '场景覆盖边 (covers)', meaning: '表示功能特性或测试规格覆盖了对应的行为场景剧本。' },
  'edge:derives-from': { title: '派生边 (derives-from)', meaning: '表示详设条目或下游需求从上游高阶规划条目拆分或派生而来。' },

  // 逐项审阅与对齐
  'sat:verified_satisfied': {
    title: '✅ 已验证满足 (verified_satisfied)',
    meaning: '最高严格等级的机器派生状态：除静态双向摘要一致、implements/verifies 双锁新鲜外，还已核实真实测试执行通过收据（或上游引擎/只读冻结仓有效 verifiedReceiptPath 验收回执）。',
    rule: '绝不把仅静态有锁当成实测通过；若缺少实测运行通过收据，系统最高只显示「🔗 追溯双锁齐备」。',
  },
  'sat:traceability_locked': {
    title: '🔗 追溯双锁齐备 (traceability_locked)',
    meaning: '下游目标文件存在、上下游双向摘要一致，且 traceability-version-lock.json 中 implements 代码锁与非空 verifies 验证锁均完整且 SHA-256 新鲜；但当前尚未检测到全量通过的测试运行收据。',
    rule: '诚实边界：表示静态代码/测试追溯链已齐备，尚不等于“运行态实测已全部通过”，跑通发布测试或 sft 收据后将自动晋升为「✅ 已验证满足」。',
  },
  'sat:partially_allocated': {
    title: '🔵 部分覆盖 (partially_allocated)',
    meaning: '高阶需求已经拆分出部分下游承接，但 remainingScope 字段明确列出还有尚未拆派完的剩余范围。',
    rule: '下方会逐条列明待补拆的剩余子项。',
  },
  'sat:allocated_in_progress': {
    title: '⏳ 已派单推进中 (allocated_in_progress)',
    meaning: '已经指定给下游技能族仓，但下游目标尚在完善、存在摘要未同步，或下游还没有同时补齐新鲜的代码与测试锁。',
  },
  'sat:not_applicable': {
    title: '⚪ 按处置不计满足 (not_applicable)',
    meaning: '该条目被处置为暂缓（deferred）、合并（merged）或废弃（abandoned），不会混入已满足比例虚增完成度。',
  },
  'sat:unallocated': {
    title: '🔴 漏拆未派单 (unallocated)',
    meaning: '有效高阶需求尚未在 allocations 中登记任何承接子仓，需尽快补全拆分去向或调整处置。',
  },
  'disp:allocated': { title: '业务处置：已拆派 (allocated)', meaning: '当前高阶需求处于活跃交付中，已拆派或待拆派给下游子技能族仓库承接。' },
  'disp:deferred': { title: '业务处置：暂缓 (deferred)', meaning: '经决策推迟到后续波次再落地，当前不计入交付覆盖率。' },
  'disp:merged': { title: '业务处置：已合并 (merged)', meaning: '能力诉求已合并入另一条高阶需求中，避免重复建设。' },
  'disp:abandoned': { title: '业务处置：已废弃 (abandoned)', meaning: '需求经论证已取消或不再适用，归档留痕但不要求下游实现。' },
  'err:UNALLOCATED_ACTIVE_DEMAND': { title: '🔴 UNALLOCATED_ACTIVE_DEMAND', meaning: '高阶规划仓存在活跃需求，但 allocations 为空，没有任何子仓认领。' },
  'err:UPSTREAM_DESIGN_CHANGED': { title: '🟠 UPSTREAM_DESIGN_CHANGED', meaning: '上游高阶原文已修订，下游 upstream-bindings.json 摘要尚未同步更新。' },
  'err:DOWNSTREAM_DESIGN_EVOLVED': { title: '🟠 DOWNSTREAM_DESIGN_EVOLVED', meaning: '子仓详设已经演进修改，高阶 portfolio-allocations.json 中的 targetDigest 仍停在旧版。' },
  'err:UNRECIPROCATED_ALLOCATION': { title: '🔴 UNRECIPROCATED_ALLOCATION', meaning: '高阶仓单方面宣称拆给某子仓，但子仓缺少对应的 upstream-bindings.json 回指确认。' },
  'err:TARGET_MISSING': { title: '🔴 TARGET_MISSING', meaning: '高阶清单登记的下游仓库或目标详设文件路径已不存在，可能已被移动或删除。' },
  'err:SOURCE_ARTIFACT_MISSING': { title: '🔴 SOURCE_ARTIFACT_MISSING', meaning: '高阶清单引用的需求或故事源文件（sourcePath）在仓库磁盘上已不存在，请核对文件是否被重命名、移动或删除。' },
  'err:UNCLAIMED_IMPLEMENTATION_ENTRY': { title: '🟠 UNCLAIMED_IMPLEMENTATION_ENTRY', meaning: '单仓匹配 implementationSurface.entryGlobs 的核心源码或 SKILL.md 入口文件，尚未在版本锁中被任何 @feature/@scenario 认领。' },
  'lockCard:implements': { title: '代码实现锁 (implements)', meaning: '统计源码/技能入口文件通过 @feature/@scenario 注解并与版本锁绑定的一致条数。' },
  'lockCard:verifies': { title: '测试验证锁 (verifies)', meaning: '统计自动化测试文件通过追溯注解绑定需求/特性/场景的新鲜锁条数。' },
  'lockCard:entries': { title: '声明式代码/技能入口', meaning: '匹配 artifact-graph.config.yaml 中 implementationSurface.entryGlobs 的核心文件总数。' },
  'lockCard:unclaimed': { title: '未认领入口与锁漂移', meaning: '若 >0 表示有新代码/技能尚未绑定设计，或改完代码/文档后尚未运行 version-lock refresh。' },

  // 逐篇阅读与状态
  'catGroup:primary1': { title: '第 1 顺位：先看诉求（用户故事）', meaning: '建议优先阅读：理解业务痛点、角色诉求与差异承接背景，建立完整上下文。' },
  'catGroup:primary2': { title: '第 2 顺位：核对边界（需求与场景）', meaning: '理解诉求后核对需求总纲的范围边界与可验证的场景剧本动作期望。' },
  'catGroup:primary': { title: '首要阅读分组', meaning: '面向产品与需求审阅者的核心阅读顺序：用户故事（懂诉求）→ 需求总纲与场景剧本（核边界）。' },
  'catGroup:supporting': { title: '备查依据分组', meaning: '领域模型、架构设计、规格说明与测试追溯文档，可在理解诉求后按需对照查阅。' },
  'catGroup:contracts': { title: '附：机器契约 (.json/.yaml)', meaning: '供脚本、状态机检查与自动化门禁读取的数据文件，已与人读 Markdown 分离，「▶ 跳至下一项待审条目 →」会自动跳过它们。' },
  'docFmt:markdown': { title: 'Markdown 阅读稿', meaning: '面向人类读者的自然中文说明文档，支持章节锚点批注与内嵌流程图。' },
  'docFmt:json': { title: 'JSON / YAML 数据契约', meaning: '面向程序校验的结构化数据契约，默认展开结构化可读表格，顶部可切回源码或同名 Markdown 文档。' },
  'status:pending': { title: '⚪ 待审阅 (pending)', meaning: '未下终态结论且没有任何未解决批注；清空或解决全部批注后也会自动回退至此状态。' },
  'status:reviewing': { title: '🔵 审阅中 (reviewing)', meaning: '阅读书签/正在梳理意见（只要添加第 1 条未解决批注也会自动点亮；全部解决且未给终态结论时自动退回待审）。' },
  'status:changes_requested': { title: '🟠 需修改 (changes_requested)', meaning: '明确退回要求作者根据批注整改，在验收单中会被汇总进待处理项。' },
  'status:approved': { title: '🟢 已通过 (approved)', meaning: '审阅确认符合要求并签收；引导队列在跳到下一项时会自动跳过已通过条目。' },
  'status:deferred': { title: '🟣 暂缓 (deferred)', meaning: '本轮不做阻断或推迟到后续波次处理。' },

  // 运行监控
  'rt:scope': { title: '监控范围切换', meaning: '「聚焦当前项目」只展示顶栏当前所选仓库及沙箱运行源；「全工作区监控源聚合」汇总所有已发现仓库中的活跃任务与锁告警。' },
  'rt:view:tasks': { title: '🌳 任务推进树', meaning: '默认首屏：把波次 → 阶段/父任务 → 子步骤及 blockedBy 前置依赖收成可折叠树，顶部直接亮出当前执行焦点。' },
  'rt:view:fleet': { title: '🛰️ 智能体会话编队', meaning: '汇总本机真实多智能体日志或沙箱演练编队，左侧展示父子会话树，右上画跨会话委派/回报泳道，下方检查每次委派简报。' },
  'rt:view:stb': { title: '🛡️ STB 追溯与防伪红牌', meaning: '呈现 execution-driver 封存的 SessionTraceBundle 多会话轨迹、40% 上下文膨胀水位，以及由 skill-failure-auditor 对账驱动的「疑似伪造完成硬闸红牌」。' },
  'rt:view:diag': { title: '🩺 异常排障', meaning: '按需排障页：标签亮出「🟢 无卡死」时平时无需打开；仅在出现「⚠️ 告警」、任务停滞或怀疑排他锁超时时点击排查。' },
  'rt:taskStatus': { title: '任务节点状态', meaning: '🟢 已完成 · 🔵 进行中 · 🔴 异常阻断（含前置依赖 blockedBy）· ⚪ 待推进；父节点自动按子节点汇总百分比。' },
  'rt:sessionRole': { title: '会话编队角色', meaning: '「主控」负责拆解协调、「子会话」并行落地具体任务、「审阅」负责只读独立复核。' },
  'rt:tokenLock': { title: 'token-lock 排他文件锁', meaning: 'Foundation 写集保护锁，防止多个并行智能体同时覆写同一批文件；超过阈值（默认 30 秒）自动琥珀色预警，沙箱演练锁可在运行监控右上角一键释放。' },
  'rt:stateStore': { title: 'state-store 事件哈希链 & Fencing', meaning: '每一步状态变迁均以 SHA-256 链接到前序摘要并递增 Fencing 纪元，保证长任务断点续跑防脑裂；VALID 表示校验完整无篡改。' },
  'rt:processStatus': { title: '受管子进程状态 (EXITED / TIMED_OUT)', meaning: 'supervise-process 对子进程的看门狗记录：RUNNING 运行中、EXITED 正常退出、TIMED_OUT 触发超时强杀保护（SIGTERM/SIGKILL）。' },

  // Wave 14：表头统一字典与审阅签收总规则
  'col:alignItem': { title: '高阶需求与原文入口', meaning: '显示高阶需求或规划条目的中文标题、一句话摘要与源码入口，点击条目即可直接跳读正文。' },
  'col:alignDisposition': {
    title: '业务处置与承接去向规则',
    meaning: '定义高阶条目在本轮的去向：已拆派 (allocated) 表示已指派给下游技能族仓；暂缓 (deferred)、已合并 (merged)、已废弃 (abandoned) 表示不计入当前交付欠账。',
    rule: '每条拆派胶囊旁的徽章区分三态：「✅ 实测收据+双锁」「🔗 追溯双锁齐备（缺实测收据）」「待补代码/测试锁」。',
  },
  'col:alignSatisfaction': {
    title: '实际满足度（机器派生口径）',
    meaning: '严格由下游目标文件存在性、上下游摘要互锁、双锁新鲜度与实测运行收据分层派生，绝不把静态有锁误当实测已过：',
    rule: '✅ 已验证满足：双锁齐备且含实测通过收据（或只读有效回执）；🔗 追溯双锁齐备：目标存在 + 双向一致 + 新鲜 implements/verifies 双锁（尚无实测收据）；🔵 部分覆盖：仍有 remainingScope 未拆；⏳ 推进中：未补齐双锁；⚪ 不计满足：已按处置结案；🔴 漏拆：未派单。',
  },
  'foundation:alignment': {
    title: '仓库分层 (repoTier) 与底座版本对齐',
    meaning: '区分底层支撑仓 (support) 与业务仓 (business)，实时核对 package.json 锁定的 artifact-graph 与 Foundation（contracts / harness-node / engineering-kit）版本是否跟上工作区最新基线。',
    rule: '🟠 支撑仓底座待同批拉齐：支撑仓存在跨代落后，需在本批协同拉齐；ℹ️ 可选底座新版本：业务仓存在可选新版底座，不强制跨仓同批冻结升级。',
  },
  'col:alignHealth': {
    title: '双向对齐结论与漂移诊断',
    meaning: '核对高阶规划仓与详设子仓之间的 SHA-256 互指是否一致。出现 🟠 或 🔴 时，下方会列出具体缺失或漂移告警代码。',
  },
  'col:upstreamLocal': { title: '本仓详细设计条目', meaning: '显示本子仓 artifacts/upstream-bindings.json 登记的本地详设标题、摘要与文件路径，点击即可跳读本仓文档。' },
  'col:upstreamSource': { title: '上游高阶规划来源', meaning: '对应高阶规划仓中的来源需求标题与摘要，点击胶囊直接跨仓跳回高阶需求原文。' },
  'col:upstreamHealth': {
    title: '上下游双向同步状态',
    meaning: '🟢 双向一致表示本仓详设与高阶来源均未发生未同步修改；若高阶或详设任一方改动未回写，会直接标橙/标红提醒。',
  },
  'col:chainVer': { title: '哈希链单条校验结果', meaning: '实时核验每条事件的 recordDigest 与 prevDigest 是否连续无缝，防止状态日志中途损坏或被越界改写。' },
  'col:procGuard': { title: '看门狗退出与超时强杀标记', meaning: '标明子进程是受控正常退出（exitCode=0），还是因超过 maxSeconds 触发 SIGTERM/SIGKILL 超时强杀保护。' },
  'col:runtimeTargets': { title: '监控目标与运行计划进度规则', meaning: '汇总活跃监控源、自定义挂载计划及近期历史计划的完成步数、活跃写锁、状态哈希链与子进程监督记录。' },
  'review:statusRules': {
    title: '审阅签收 5 种状态流转规则',
    meaning: '⚪ 待审阅：未给终态且无未解决批注；🔵 审阅中：添加第 1 条未解决批注即自动点亮，清空或全部解决批注且无终态时自动退回待审；🟠 需修改：需至少写 1 条批注或备注后才可退回；🟢 已通过：签收并在队列中跳过；🟣 暂缓：留待后续波次。',
  },
  'repo:provenance': {
    title: '项目名称与说明的真实来源',
    meaning: '工作台按「自定义覆写 (.studio-workspace.json / workspace-projects.json) → .studio-workspace.json 标题 → package.json#description → README.md 首段」自动聚合项目身份，可随时点击查看来源或覆写更名。',
  },
});

let managerInitialized = false;
let activeTrigger = null;
let isPinned = false;
let hoverTimer = null;

function ensureTooltipBox(doc = document) {
  let box = doc.getElementById('st-global-tooltip');
  if (box) return box;
  box = doc.createElement('div');
  box.id = 'st-global-tooltip';
  box.className = 'st-tooltip-popover';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  box.addEventListener('mouseleave', ev => {
    if (isPinned) return;
    if (ev.relatedTarget && activeTrigger && activeTrigger.contains(ev.relatedTarget)) return;
    box.hidden = true;
  });
  doc.body.append(box);
  return box;
}

export function closeGlobalTooltip(doc = document) {
  const box = doc.getElementById('st-global-tooltip');
  if (box) box.hidden = true;
  isPinned = false;
  activeTrigger = null;
}

function positionTooltip(box, trigger, doc = document) {
  const rect = trigger.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth || window.innerWidth || 1280;
  const vh = doc.documentElement.clientHeight || window.innerHeight || 800;
  box.style.visibility = 'hidden';
  box.hidden = false;
  const bw = Math.min(340, box.offsetWidth || 300);
  const bh = box.offsetHeight || 120;
  let left = rect.left;
  if (left + bw > vw - 14) left = Math.max(12, vw - bw - 14);
  let top = rect.bottom + 8;
  if (top + bh > vh - 14 && rect.top - bh - 8 > 10) {
    top = rect.top - bh - 8;
  } else if (top + bh > vh - 14) {
    top = Math.max(10, vh - bh - 14);
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.style.visibility = 'visible';
}

function showTooltipFor(trigger, pin = false, doc = document) {
  const key = trigger?.dataset?.infoKey;
  const entry = key ? GLOSSARY[key] : null;
  if (!entry) return;
  const box = ensureTooltipBox(doc);
  box.replaceChildren();
  const head = doc.createElement('div');
  head.className = 'st-tooltip-head';
  const titleEl = doc.createElement('strong');
  titleEl.textContent = entry.title;
  head.append(titleEl);
  if (pin) {
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'st-tooltip-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '关闭说明');
    closeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      closeGlobalTooltip(doc);
    });
    head.append(closeBtn);
  }
  const body = doc.createElement('p');
  body.className = 'st-tooltip-body';
  body.textContent = entry.meaning;
  box.append(head, body);
  if (entry.rule) {
    const ruleEl = doc.createElement('p');
    ruleEl.className = 'st-tooltip-rule';
    ruleEl.textContent = entry.rule;
    box.append(ruleEl);
  }
  activeTrigger = trigger;
  isPinned = pin;
  box.classList.toggle('is-pinned', pin);
  positionTooltip(box, trigger, doc);
}

export function initTooltipManager(doc = document) {
  if (managerInitialized || typeof doc?.addEventListener !== 'function') return;
  managerInitialized = true;
  ensureTooltipBox(doc);

  doc.addEventListener('mouseover', ev => {
    const btn = ev.target?.closest?.('.st-info-btn');
    if (!btn || isPinned) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showTooltipFor(btn, false, doc), 70);
  });

  doc.addEventListener('mouseout', ev => {
    const btn = ev.target?.closest?.('.st-info-btn');
    if (!btn || isPinned) return;
    clearTimeout(hoverTimer);
    if (ev.relatedTarget && doc.getElementById('st-global-tooltip')?.contains(ev.relatedTarget)) return;
    const box = doc.getElementById('st-global-tooltip');
    if (box) box.hidden = true;
  });

  doc.addEventListener('focusin', ev => {
    const btn = ev.target?.closest?.('.st-info-btn');
    if (btn && !isPinned) showTooltipFor(btn, false, doc);
  });

  doc.addEventListener('click', ev => {
    const btn = ev.target?.closest?.('.st-info-btn');
    const box = doc.getElementById('st-global-tooltip');
    if (btn) {
      ev.stopPropagation();
      if (isPinned && activeTrigger === btn && box && !box.hidden) {
        closeGlobalTooltip(doc);
      } else {
        showTooltipFor(btn, true, doc);
      }
      return;
    }
    if (box && !box.hidden && !box.contains(ev.target)) {
      closeGlobalTooltip(doc);
    }
  });
}

export function infoTrigger(key, doc = document) {
  const entry = GLOSSARY[key];
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'st-info-btn';
  btn.dataset.infoKey = key;
  btn.textContent = 'ⓘ';
  btn.setAttribute('aria-label', entry ? `查看「${entry.title}」解释` : '查看概念说明');
  return btn;
}

export function isTooltipOpen(doc = document) {
  const box = doc.getElementById('st-global-tooltip');
  return Boolean(box && !box.hidden);
}

export function thWithInfo(doc, label, tipKey) {
  const th = doc.createElement('th');
  const wrap = doc.createElement('span');
  wrap.className = 'st-th-flex';
  const txt = doc.createElement('span');
  txt.textContent = label;
  wrap.append(txt);
  if (tipKey && GLOSSARY[tipKey]) wrap.append(infoTrigger(tipKey, doc));
  th.append(wrap);
  return th;
}

function appendSummaryWithInlineCode(sumEl, rawText, maxChars, doc) {
  const cleaned = String(rawText ?? '').replace(/\*{2,}/g, '').trim();
  if (!cleaned.includes('`')) {
    sumEl.textContent = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
    return;
  }
  const tokens = cleaned.split(/(`[^`\n]+`)/g).filter(Boolean);
  let remaining = maxChars;
  let truncated = false;
  for (const tok of tokens) {
    if (remaining <= 0) { truncated = true; break; }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) {
      const inner = tok.slice(1, -1);
      const codeEl = doc.createElement('code');
      codeEl.className = 'st-inline-code';
      if (inner.length > remaining) {
        codeEl.textContent = `${inner.slice(0, Math.max(1, remaining - 1))}…`;
        sumEl.append(codeEl);
        remaining = 0;
        break;
      }
      codeEl.textContent = inner;
      sumEl.append(codeEl);
      remaining -= inner.length;
    } else {
      const plain = tok.replace(/`/g, '');
      if (plain.length > remaining) {
        sumEl.append(doc.createTextNode(`${plain.slice(0, Math.max(1, remaining - 1))}…`));
        remaining = 0;
        break;
      }
      sumEl.append(doc.createTextNode(plain));
      remaining -= plain.length;
    }
  }
  if (truncated && remaining === 0) return;
}

export function renderEntityBrief(doc, entity = {}, options = {}) {
  const {
    compact = false,
    showPath = !compact,
    hideSummary = false,
    maxSummaryChars = compact ? 76 : 112,
  } = options;
  const wrap = doc.createElement('div');
  wrap.className = `st-entity-brief${compact ? ' is-compact' : ''}`;

  const rawTitle = String(entity.title || entity.name || entity.code || entity.uid || '未命名条目').replace(/\*{2,}/g, '').trim();
  const rawCode = String(entity.code || '').trim();
  const typeLabel = String(entity.typeLabel || '').trim();
  const badgeText = String(entity.badge || '').trim();

  const head = doc.createElement('div');
  head.className = 'st-entity-head';
  const titleEl = doc.createElement('strong');
  titleEl.className = 'st-entity-title';
  titleEl.textContent = rawTitle;
  head.append(titleEl);

  if (rawCode && rawCode !== rawTitle) {
    const codeSpan = doc.createElement('span');
    codeSpan.className = 'st-entity-code';
    codeSpan.textContent = rawCode;
    head.append(codeSpan);
  }
  if (typeLabel) {
    const typeSpan = doc.createElement('span');
    typeSpan.className = 'st-entity-type';
    typeSpan.textContent = typeLabel;
    head.append(typeSpan);
  }
  if (badgeText) {
    const badgeSpan = doc.createElement('span');
    badgeSpan.className = 'st-badge st-badge-zinc';
    badgeSpan.textContent = badgeText;
    head.append(badgeSpan);
  }
  wrap.append(head);

  if (!hideSummary && entity.summary) {
    const sumEl = doc.createElement('div');
    sumEl.className = 'st-entity-summary';
    appendSummaryWithInlineCode(sumEl, entity.summary, maxSummaryChars, doc);
    wrap.append(sumEl);
  }

  if (showPath && entity.path) {
    const pathEl = doc.createElement('div');
    pathEl.className = 'st-entity-path';
    pathEl.textContent = String(entity.path);
    pathEl.title = String(entity.path);
    wrap.append(pathEl);
  }

  return wrap;
}
