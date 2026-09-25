export const TASK_BOARD_PHRASES: readonly (readonly [string, string])[] = [
  ["This project's working directory", "此项目的工作目录"],
  ["Change directory", "更改目录"],
  ["Retry", "重试"],
  ["Choose a task", "选择一个任务"],
  ["Open a task to see its conversation and steps.", "打开任务，查看对话与步骤。"],
  ["Task list", "任务列表"],
  ["Back to task list", "返回任务列表"],
  ["Resize navigation", "调整导航栏宽度"],
  ["Resize task list", "调整任务列表宽度"],
  ["Task steps", "任务步骤"],
  ["Details", "详情"],
  ["Close steps", "关闭步骤"],
  ["Close details", "关闭详情"],
  ["Message the Agent…", "发送消息给 Agent…"],
  ["Enter to send · Shift+Enter for a new line", "Enter 发送 · Shift+Enter 换行"],
  ["Retry message sync", "重试消息同步"],
  ["Syncing message acknowledgements… Loaded messages remain visible.", "正在同步消息确认状态，已加载内容会保留。"],
  ["Message acknowledgements synchronized.", "消息确认状态已同步。"],
  ["Could not sync message acknowledgements. Loaded messages were retained; try again.", "消息确认状态同步失败，已保留现有内容，请重试。"],
  ["Open terminal in working directory", "在工作目录打开终端"],
  ["New desktop operations use this directory. Connected Agents keep their existing workspace and permissions.", "新的桌面操作使用此目录，已连接的 Agent 保持原有工作目录和权限。"],
  ["Choose a working directory for this project before opening a terminal.", "请先为这个项目选择工作目录，再打开终端。"],
  ["Reliable task queues", "可信任务队列"],
  ["Task Board", "任务面板"],
  [
    "Follow your projects, review unfinished work, and continue the conversation.",
    "跟进项目、查看未完成工作，并继续对话。",
  ],
  ["Task details", "任务详情"],
  ["Load earlier messages", "加载更早的消息"],
  ["Loading earlier messages…", "正在加载更早的消息…"],
  ["Earlier messages loaded.", "更早的消息已加载。"],
  ["All available messages are shown.", "已显示全部可用消息。"],
  ["Could not load earlier messages. Loaded messages were retained; try again.", "无法加载更早的消息，已加载内容保留，请重试。"],
  ["Conversation changed. Earlier messages can be loaded again.", "对话已更新，可重新加载更早的消息。"],
  ["Working directory", "工作目录"],
  ["No working directory selected", "尚未选择工作目录"],
  ["Choose directory", "选择目录"],
  ["Directory permissions", "目录权限"],
  ["Access for this directory", "此目录的访问权限"],
  ["L1 · Read only", "L1 · 只读查看"],
  ["L2 · Work in this folder", "L2 · 在此目录工作"],
  ["L3 · Ask before sensitive actions", "L3 · 敏感操作前确认"],
  ["L4 · Bypass approvals", "L4 · 跳过操作审批"],
  ["Loading project workspace…", "正在加载项目工作区…"],
  ["Choose a working directory for this project.", "请为此项目选择工作目录。"],
  ["New desktop operations use this directory. Existing sessions keep their original directory.", "桌面的新操作使用此目录，已有会话继续使用原目录。"],
  ["This project's saved directory is not active.", "此项目记住的工作目录尚未启用。"],
  ["Connected Agents keep their existing workspace and permissions.", "已连接的 Agent 保留原有工作目录和权限。"],
  ["Project workspaces could not be loaded. Try again.", "无法加载项目工作区，请重试。"],
  [
    "Unfinished work stays here until it is completed or cancelled.",
    "未完成工作会保留在这里，直到完成或取消。",
  ],
  [
    "0 current · 0 need action · 0 history",
    "0 个当前任务 · 0 个待处理 · 0 条历史",
  ],
  ["Task queues", "任务队列"],
  ["Needs action", "需要处理"],
  ["History", "历史"],
  ["Automatic activity", "自动活动"],
  ["Unclaimed tool activity", "未认领的工具活动"],
  ["All records", "全部记录"],
  ["Audit view", "审计视图"],
  ["Current view", "当前视图"],
  [
    "Only formal tasks with an active bound Agent session are shown here.",
    "此处只显示已绑定有效 Agent 会话的正式任务。",
  ],
  ["Snapshot not loaded", "尚未加载快照"],
  ["Current work without structured progress", "缺少结构化进度的当前工作"],
  [
    "Active Agent work without a numeric total is shown without a misleading percentage.",
    "有效 Agent 工作尚无数值总量时，不会显示误导性的百分比。",
  ],
  ["Search this queue", "搜索当前队列"],
  ["Clear filters", "清除筛选"],
  ["Task cards", "任务卡"],
  ["Project filter", "项目筛选"],
  ["Task projects", "任务项目"],
  [
    "Filter Tasks by one existing project root or show all projects.",
    "按一个现有项目根目录筛选任务，或显示全部项目。",
  ],
  ["All projects", "全部项目"],
  ["All task project roots", "全部任务项目根目录"],
  ["Single project", "单个项目"],
  ["Organize projects", "整理项目"],
  ["Group project directories in this view. Tasks and directory access stay the same.", "将同一项目的目录归在一起。任务记录和目录权限保持原样。"],
  ["Group name", "项目名称"],
  ["Projects to group", "选择要归入此项目的目录"],
  ["Edit group", "编辑归组"],
  ["Ungroup", "解除归组"],
  ["Save group", "保存归组"],
  ["Cancel edit", "取消编辑"],
  ["Project group saved.", "项目归组已保存。"],
  ["Project group removed.", "项目归组已解除。"],
  ["Saved project groups could not be read. Projects are shown separately.", "无法读取已保存的归组，当前分别显示原始项目。"],
  ["Choose at least two available projects, a group name, and no overlapping groups.", "请填写名称，选择至少两个可用目录，并避免重复归组。"],
  ["Could not save project groups. Your project list is unchanged.", "无法保存项目归组，项目列表保持原样。"],
  ["Open terminal in project", "在项目目录打开终端"],
  ["current tasks shown", "个当前任务已显示"],
  ["action items shown", "个待处理事项已显示"],
  ["history records shown", "条历史记录已显示"],
  ["activity records shown", "条活动记录已显示"],
  ["records shown", "条记录已显示"],
  ["Board state", "面板状态"],
  ["Recorded status", "底层记录状态"],
  ["Task state not verified", "任务状态尚未验证"],
  ["Unverified", "未验证"],
  ["Follow-up pending", "待确认跟进"],
  ["Observed activity", "已观察到活动"],
  ["Activity ended", "活动已结束"],
  [
    "The Agent connection is not confirmed. This work remains unfinished.",
    "Agent 连接待确认，此工作仍未完成。",
  ],
  [
    "No Agent is assigned. This work remains unfinished.",
    "尚未分配 Agent，此工作仍未完成。",
  ],
  [
    "A user message is waiting for acknowledgement. The recorded task status has not changed.",
    "有用户消息等待确认，已记录的任务状态未改变。",
  ],
  [
    "The Agent heartbeat has not been confirmed. This work remains unfinished.",
    "尚未确认 Agent 心跳，此工作仍未完成。",
  ],
  [
    "This work is blocked and needs review before it can continue.",
    "此工作已阻塞，需要检查后才能继续。",
  ],
  [
    "This work failed and stays in Needs action until it is reviewed.",
    "此工作已失败，在完成复核前会保留在“需要处理”中。",
  ],
  [
    "Automatic activity is separate from tasks until an Agent claims it.",
    "自动活动会与正式任务分开，直到 Agent 认领。",
  ],
  [
    "Automatic activity ended and is retained separately for audit.",
    "自动活动已结束，并单独保留以供审计。",
  ],
  ["Completed work is retained in History.", "已完成工作保留在历史中。"],
  ["Cancelled work is retained in History.", "已取消工作保留在历史中。"],
  ["The latest Agent heartbeat is current.", "最近一次 Agent 心跳正常。"],
  [
    "The Agent heartbeat is delayed. This work remains unfinished.",
    "Agent 心跳延迟，此工作仍未完成。",
  ],
  ["No confirmed current work", "没有已确认的当前工作"],
  ["No current work", "当前没有进行中的工作"],
  ["Queued, planned and running work. Agent connection status is shown separately.", "显示排队、规划和执行中的工作；Agent 连接状态单独显示。"],
  ["Queued, planned and running tasks will appear here, including work whose Agent connection is not confirmed.", "排队、规划和执行中的任务会显示在这里，连接待确认时仍保留。"],
  ["Review requests for your reply, blockers, failures and follow-up messages awaiting acknowledgement.", "查看需要你回复、排查阻塞、复核失败或确认跟进的工作。"],
  ["No task needs a response, blocker review, failure review or follow-up acknowledgement.", "没有任务需要回复、排查阻塞、复核失败或确认跟进。"],
  [
    "Tasks with a confirmed recent Agent heartbeat appear here. Unfinished work with an uncertain connection stays in Needs action.",
    "此处显示近期 Agent 心跳已确认的任务；连接待确认的未完成工作保留在“需要处理”中。",
  ],
  ["Nothing needs action", "没有需要处理的事项"],
  [
    "No task needs a response, connection check, blocker review, failure review or follow-up acknowledgement.",
    "没有任务需要回复、检查连接、排查阻塞、复核失败或确认跟进。",
  ],
  [
    "Review unfinished work with a delayed or unconfirmed Agent connection, blockers, failures and messages awaiting acknowledgement.",
    "查看 Agent 连接延迟或待确认的未完成工作、阻塞、失败，以及等待确认的消息。",
  ],
  ["No task history", "尚无任务历史"],
  [
    "Completed and cancelled tasks without pending user messages will appear here.",
    "已完成或已取消且没有待处理用户消息的任务会显示在这里。",
  ],
  [
    "Completed and cancelled tasks are retained here. Unfinished work stays visible even when its Agent connection is not confirmed.",
    "此处保留已完成和已取消的任务；Agent 连接待确认时，未完成工作仍会保持可见。",
  ],
  ["No automatic activity", "没有自动活动"],
  [
    "Unclaimed tool activity will appear here without being presented as formal current work.",
    "未认领的工具活动会显示在这里，但不会被呈现为正式的当前工作。",
  ],
  [
    "Tool activity inferred by Sovereign stays separate until a task Agent explicitly claims it.",
    "Sovereign 推断的工具活动会保持独立，直到任务 Agent 明确认领。",
  ],
  ["No task records", "尚无任务记录"],
  [
    "Agents can register formal work. Sovereign also retains meaningful automatic activity separately.",
    "Agent 可以登记正式工作；Sovereign 也会单独保留有意义的自动活动。",
  ],
  [
    "Audit every formal task and automatic activity record without changing their derived board state.",
    "审计全部正式任务和自动活动记录，而不改变面板推导状态。",
  ],
  ["Shown", "已显示"],
  ["Current", "当前"],
  ["Waiting messages", "等待中的消息"],
  ["Loading tasks…", "正在加载任务…"],
  ["Loading task records", "正在加载任务记录"],
  ["Loading projects and tasks…", "正在加载项目和任务…"],
  ["Tasks unavailable", "任务不可用"],
  ["Refresh to try again.", "请刷新后重试。"],
  ["Loading snapshot…", "正在加载快照…"],
  ["Snapshot unavailable", "快照不可用"],
  ["Task board unavailable", "任务面板不可用"],
  [
    "Task data could not be loaded. Use Refresh to retry.",
    "无法加载任务数据，请使用“刷新”重试。",
  ],
  [
    "Task board refresh failed. No task data is available.",
    "任务面板刷新失败，当前没有可用的任务数据。",
  ],
  ["Refreshing task board…", "正在刷新任务面板…"],
  ["Task board refreshed. No changes.", "任务面板已刷新，没有变化。"],
  [
    "Task board refresh failed. Existing task data was not replaced.",
    "任务面板刷新失败，现有任务数据未被替换。",
  ],
  [
    "Task board unavailable. Showing the last successful snapshot.",
    "任务面板暂不可用，正在显示上次成功快照。",
  ],
  [
    "Task board unavailable. No successful snapshot is available.",
    "任务面板暂不可用，当前没有可用的成功快照。",
  ],
  ["Sending message…", "正在发送消息…"],
  ["Message saved.", "消息已保存。"],
  ["Message not sent. Draft preserved.", "消息未发送，草稿已保留。"],
  ["Delivery uncertain. Draft preserved.", "送达结果不确定，草稿已保留。"],
  [
    "Message may have been saved, but the returned snapshot failed integrity checks. Draft preserved; refresh before retrying.",
    "消息可能已保存，但返回的快照未通过完整性校验。草稿已保留；请先刷新再重试。",
  ],
  [
    "These live Agent tasks have not reported a numeric total yet.",
    "这些在线 Agent 任务尚未报告数值总量。",
  ],
  ["Agent coordination", "Agent 协调"],
  ["Coordination count unavailable", "协调计数尚不可用"],
  ["Coordination unread count unavailable", "协调未读计数尚不可用"],
  ["Coordination status unavailable.", "协调状态不可用。"],
  ["Last known: No coordination pending", "上次已知：没有待处理协调消息"],
  ["Last known: No unread coordination", "上次已知：没有未读协调消息"],
  ["Refresh coordination", "刷新协调消息"],
  ["Coordination inbox", "协调收件箱"],
  ["No coordination pending", "没有待处理协调消息"],
  ["No unread coordination", "没有未读协调消息"],
  [
    "Separate from Task conversation. Viewing here does not change Agent delivery, read or acknowledgement state.",
    "此处与普通任务对话分离；在这里查看不会改变 Agent 的送达、读取或确认状态。",
  ],
  ["Loading coordination…", "正在加载协调消息…"],
  ["Could not load coordination messages.", "无法加载协调消息。"],
  ["No coordination messages.", "暂无协调消息。"],
  ["Load earlier coordination", "加载更早的协调消息"],
  ["Loading earlier coordination…", "正在加载更早的协调消息…"],
  ["Earlier coordination messages loaded.", "已加载更早的协调消息。"],
  [
    "Could not load earlier coordination messages. Loaded messages were retained.",
    "无法加载更早的协调消息，已加载的消息已保留。",
  ],
  ["Needs Agent acknowledgement", "等待 Agent 确认"],
  ["Message", "消息"],
  ["Question", "问题"],
  ["Request", "请求"],
  ["Handoff", "交接"],
  ["Decision", "决定"],
  ["Notice", "通知"],
  ["Freeze", "冻结"],
  ["Release request", "发布请求"],
  ["Release result", "发布结果"],
  ["Delivered", "已送达"],
  ["Read", "已读取"],
  ["Acknowledged", "已确认"],
  ["Replied", "已回复"],
  ["Expired", "已过期"],
  ["Recipient changed", "收件方已变更"],
];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  Queued: "排队中",
  Planning: "规划中",
  Running: "运行中",
  "Waiting for you": "等待你的回复",
  Blocked: "已阻塞",
  Succeeded: "已完成",
  Failed: "失败",
  Cancelled: "已取消",
  "Follow-up pending": "待确认跟进",
  "Observed activity": "已观察到活动",
  "Activity ended": "活动已结束",
};

function translateRelativeTime(value: string): string {
  if (value === "Just now") return "刚刚";
  if (value === "Never") return "从未";
  const match = value.match(/^(\d+) (seconds?|minutes?|hours?|days?) ago$/u);
  if (match === null) return value;
  const unit = match[2]?.startsWith("second")
    ? "秒"
    : match[2]?.startsWith("minute")
      ? "分钟"
      : match[2]?.startsWith("hour")
        ? "小时"
        : "天";
  return `${match[1]} ${unit}前`;
}

export function translateTaskBoardPattern(value: string): string | null {
  let match = value.match(
    /^(\d+) current · (\d+) need action · (\d+) history$/u,
  );
  if (match !== null) {
    return `${match[1]} 个当前任务 · ${match[2]} 个待处理 · ${match[3]} 条历史`;
  }
  match = value.match(/^(\d+) records · refreshed (.+)$/u);
  if (match !== null) {
    return `${match[1]} 条记录 · 刷新于 ${translateRelativeTime(match[2] ?? "")}`;
  }
  match = value.match(/^Completed (.+)$/u);
  if (match !== null) {
    return `完成于 ${match[1] ?? ""}`;
  }
  match = value.match(
    /^Coordination messages and counts may be out of date\. Last updated (.+)\.$/u,
  );
  if (match !== null) {
    return `协调消息和计数可能已过期，上次更新于 ${match[1] ?? ""}。`;
  }
  match = value.match(/^Coordination messages and counts updated (.+)\.$/u);
  if (match !== null) {
    return `协调消息和计数更新于 ${match[1] ?? ""}。`;
  }
  match = value.match(/^Last known: (\d+) coordination unread$/u);
  if (match !== null) {
    return `上次已知：${match[1] ?? ""} 条协调消息未读`;
  }
  match = value.match(/^Last known: (\d+) coordination pending$/u);
  if (match !== null) {
    return `上次已知：${match[1] ?? ""} 条协调消息待处理`;
  }
  match = value.match(/^(\d+) coordination unread$/u);
  if (match !== null) {
    return `${match[1]} 条协调消息未读`;
  }
  match = value.match(/^(\d+) coordination pending$/u);
  if (match !== null) {
    return `${match[1]} 条协调消息待处理`;
  }
  match = value.match(/^(\d+) of (\d+) characters$/u);
  if (match !== null) {
    return `${match[1]} / ${match[2]} 个字符`;
  }
  match = value.match(
    /^Task board refreshed\. (\d+) (record|records) loaded\.$/u,
  );
  if (match !== null) {
    return `任务面板已刷新，已加载 ${match[1]} 条记录。`;
  }
  match = value.match(
    /^(Queued|Planning|Running|Waiting for you|Blocked|Succeeded|Failed|Cancelled|Follow-up pending|Observed activity|Activity ended) · (.+)$/u,
  );
  if (match !== null) {
    return `${STATUS_LABELS[match[1] ?? ""] ?? match[1]} · ${translateRelativeTime(match[2] ?? "")}`;
  }
  return null;
}
