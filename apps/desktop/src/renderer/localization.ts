import { PHRASES } from "./localization-messages.js";
import {
  translateTaskBoardPattern,
} from "./task-board-localization.js";

export type UiLanguage = "en" | "zh-CN";

const EN_TO_ZH = new Map<string, string>(PHRASES);
const LOCALIZABLE_ATTRIBUTES = ["title", "aria-label", "placeholder"] as const;
type LocalizableAttribute = (typeof LOCALIZABLE_ATTRIBUTES)[number];

interface LocalizedSource {
  source: string;
  rendered: string;
}

const TEXT_SOURCES = new WeakMap<Text, LocalizedSource>();
const ATTRIBUTE_SOURCES = new WeakMap<Element, Map<LocalizableAttribute, LocalizedSource>>();
const SKIP_SELECTOR =
  "code, pre:not([data-i18n-placeholder]), script, style, [data-no-i18n]";
// Editable text belongs to the document; editor labels remain interface copy.
const USER_TEXT_SELECTOR = `${SKIP_SELECTOR}, textarea, [contenteditable]:not([contenteditable="false"])`;

function translatePattern(value: string): string {
  const patterns: readonly (readonly [RegExp, (...matches: string[]) => string])[] = [
    [/^Allow connected web agent to run (.+)\?$/u, (_all, action) => `允许已连接的网页 Agent 执行 ${action} 吗？`],
    [/^L3 Consequential · (.+)$/u, (_all, detail) => `L3 高影响 · ${detail}`],
    [/^Step (\d+) kind$/u, (_all, step) => `步骤 ${step} 类型`],
    [/^(\d+) trusted keys?$/u, (_all, count) => `${count} 个可信密钥`],
    [/^(\d+) installed · (\d+) in inbox · highest accepted sequence #(\d+)\. Last failure: (.+)$/u, (_all, installed, inbox, sequence, failure) => `${installed} 个已安装 · ${inbox} 个在收件箱 · 已接受的最高序列号 #${sequence}。最近失败：${failure}`],
    [/^(\d+) installed · (\d+) in inbox · highest accepted sequence #(\d+)\. Install a signed inbox release, then activate the verified immutable slot\.$/u, (_all, installed, inbox, sequence) => `${installed} 个已安装 · ${inbox} 个在收件箱 · 已接受的最高序列号 #${sequence}。先安装收件箱中的已签名版本，再激活经过验证的不可变槽位。`],
    [/^(.+) · (Installed · Inbox|Installed|Inbox)$/u, (_all, release, location) => `${release} · ${EN_TO_ZH.get(location) ?? location}`],
    [/^(\d+) items?$/u, (_all, count) => `${count} 项`],
    [/^(\d+) setup items?$/u, (_all, count) => `${count} 项待设置`],
    [/^(\d+) projects? · (\d+) active · (\d+) need attention$/u, (_all, projects, active, attention) => `${projects} 个项目 · ${active} 个进行中 · ${attention} 个需要关注`],
    [/^(\d+) projects? · (\d+) active$/u, (_all, projects, active) => `${projects} 个项目 · ${active} 个进行中`],
    [/^(\d+) projects? · (\d+) tasks?$/u, (_all, projects, tasks) => `${projects} 个项目 · ${tasks} 个任务`],
    [/^(Queued|Planning|Running|Waiting for you|Blocked|Succeeded|Failed|Cancelled) · (.+)$/u, (_all, status, elapsed) => `${EN_TO_ZH.get(status) ?? status} · ${translatePattern(elapsed)}`],
    [/^Activity inferred from tool calls · (.+)$/u, (_all, elapsed) => `根据工具调用推断活动 · ${translatePattern(elapsed)}`],
    [/^(\d+) waiting messages?$/u, (_all, count) => `${count} 条等待中的消息`],
    [/^(\d+) automatic activit(?:y|ies) and (\d+) Agent tasks? do not have a numeric total yet\.$/u, (_all, automatic, agents) => `${automatic} 个自动归纳活动和 ${agents} 个 Agent 任务尚无数值总量。`],
    [/^Showing the latest (\d+) of (\d+) messages\.$/u, (_all, shown, total) => `显示最近 ${shown} 条，共 ${total} 条消息。`],
    [/^(\d+) Agent tasks?$/u, (_all, count) => `${count} 个 Agent 任务`],
    [/^(\d+) seconds ago$/u, (_all, count) => `${count} 秒前`],
    [/^(\d+) minutes? ago$/u, (_all, count) => `${count} 分钟前`],
    [/^(\d+) hours? ago$/u, (_all, count) => `${count} 小时前`],
    [/^(\d+) days? ago$/u, (_all, count) => `${count} 天前`],
    [/^(.+) · The Agent is waiting for your reply\.(?: (.+))?$/u, (_all, project, step) => `${project} · Agent 正在等待你的回复。${step === undefined ? "" : ` ${step}`}`],
    [/^(.+) · The task reported a failure\.(?: (.+))?$/u, (_all, project, step) => `${project} · 任务报告了失败。${step === undefined ? "" : ` ${step}`}`],
    [/^(.+) · The task is blocked\.(?: (.+))?$/u, (_all, project, step) => `${project} · 任务已阻塞。${step === undefined ? "" : ` ${step}`}`],
    [/^(.+) · The Agent is (stale|offline)\.(?: (.+))?$/u, (_all, project, presence, step) => `${project} · Agent ${presence === "stale" ? "心跳过期" : "离线"}。${step === undefined ? "" : ` ${step}`}`],
    [/^Agent (online|stale|offline|unknown)$/u, (_all, presence) => `Agent ${presence === "online" ? "在线" : presence === "stale" ? "心跳过期" : presence === "offline" ? "离线" : "状态未知"}`],
    [/^(.+) · (online|heartbeat stale|offline|not checked in)$/u, (_all, name, presence) => `${name} · ${presence === "online" ? "在线" : presence === "heartbeat stale" ? "心跳过期" : presence === "offline" ? "离线" : "尚未报到"}`],
    [/^(\d+) sessions?$/u, (_all, count) => `${count} 个会话`],
    [/^(\d+) active sessions?$/u, (_all, count) => `${count} 个活动会话`],
    [/^(\d+) tasks? running$/u, (_all, count) => `${count} 个任务运行中`],
    [/^(\d+) running$/u, (_all, count) => `${count} 个运行中`],
    [/^(\d+) runs?$/u, (_all, count) => `${count} 条运行记录`],
    [/^(\d+) receipts?$/u, (_all, count) => `${count} 条回执`],
    [/^(\d+) processes?$/u, (_all, count) => `${count} 个进程`],
    [/^(\d+) capabilities?$/u, (_all, count) => `${count} 项能力`],
    [/^(\d+) elements?$/u, (_all, count) => `${count} 个元素`],
    [/^(\d+) blocked requests?$/u, (_all, count) => `${count} 个请求被阻止`],
    [/^(\d+) steps?$/u, (_all, count) => `${count} 个步骤`],
    [/^(\d+) active · (\d+) failed$/u, (_all, active, failed) => `${active} 个活动 · ${failed} 个失败`],
    [/^(\d+) active · (\d+) total$/u, (_all, active, total) => `${active} 个活动 · 共 ${total} 条`],
    [/^(\d+) activit(?:y|ies) running$/u, (_all, count) => `${count} 个活动进行中`],
    [/^(\d+) activit(?:y|ies) running · (.+)$/u, (_all, count, elapsed) => `${count} 个活动进行中 · ${elapsed}`],
    [/^Connected · (\d+) sessions?$/u, (_all, count) => `已连接 · ${count} 个会话`],
    [/^(\d+) active (?:runs?|tasks?)$/u, (_all, count) => `${count} 个活动任务`],
    [/^Web Agent connected · (\d+)$/u, (_all, count) => `网页 Agent 已连接 · ${count}`],
    [/^ChatGPT connected · (\d+)$/u, (_all, count) => `ChatGPT 已连接 · ${count}`],
    [/^Generation (\d+) · active$/u, (_all, generation) => `第 ${generation} 代 · 有效`],
    [/^(\d+) primitives? missing$/u, (_all, count) => `缺少 ${count} 项基础能力`],
    [/^Workspace: (.+)$/u, (_all, workspace) => `工作区：${workspace}`],
    [/^Updated (.+)$/u, (_all, timestamp) => `更新于 ${translatePattern(timestamp)}`],
    [/^(\d+) active · 1 recent failure$/u, (_all, active) => `${active} 个进行中 · 最近 1 个失败`],
    [/^(\d+) active · (\d+) recent failures$/u, (_all, active, failed) => `${active} 个进行中 · 最近 ${failed} 个失败`],
    [/^(Terminal|Files|Search|Git|Python|Workflow|Browser|Computer|System|Other|Validation) · running · (.+)$/u, (_all, category, elapsed) => `${EN_TO_ZH.get(category) ?? category} · 运行中 · ${elapsed}`],
    [/^(Terminal|Files|Search|Git|Python|Workflow|Browser|Computer|System|Other|Validation) · (.+)$/u, (_all, category, operation) => `${EN_TO_ZH.get(category) ?? category} · ${EN_TO_ZH.get(operation) ?? operation}`],
    [/^Saved with Windows DPAPI · (.+)\. Only OpenAI control-plane requests use it; local MCP remains direct\.$/u, (_all, display) => `已使用 Windows DPAPI 保存 · ${display}。仅 OpenAI 控制平面请求使用此代理；本机 MCP 保持直连。`],
    [/^Available for this session only · (.+)\. Re-enter it after restart; local MCP remains direct\.$/u, (_all, display) => `仅在本次会话可用 · ${display}。请在重启后重新输入；本机 MCP 保持直连。`],
    [/^Saved with Windows DPAPI · (.+)\. Use an independent service or exit when possible\.$/u, (_all, display) => `已使用 Windows DPAPI 保存 · ${display}。请尽可能使用独立服务或独立出口。`],
    [/^Available for this session only · (.+)\. Re-enter it after restart\.$/u, (_all, display) => `仅在本次会话可用 · ${display}。请在重启后重新输入。`],
    [/^Recovery attempt (\d+) is scheduled for (.+)\.$/u, (_all, attempt, timestamp) => `恢复尝试 ${attempt} 已安排在 ${timestamp}。`],
    [/^Connector restart attempt (\d+) is scheduled for (.+)\. Stop the tunnel to cancel supervision\.$/u, (_all, attempt, timestamp) => `连接器重启尝试 ${attempt} 已安排在 ${timestamp}。停止隧道可取消监控。`],
    [/^(.+) · (\d+) switches?(?: · last (.+))?\.$/u, (_all, route, count, timestamp) => `${EN_TO_ZH.get(route) ?? translatePattern(route)} · 已切换 ${count} 次${timestamp === undefined ? "" : ` · 最近一次 ${timestamp}`}。`],
    [/^(Primary proxy|Backup proxy|Direct fallback) · (.+)$/u, (_all, route, target) => `${EN_TO_ZH.get(route) ?? route} · ${target}`],
    [/^Saved bridge · (.+)$/u, (_all, target) => `已保存网桥 · ${target}`],
    [/^Fallback ChatGPT bundle target · (.+)$/u, (_all, target) => `备用 ChatGPT 连接包目标 · ${target}`],
    [/^Without confirmation is active\. Switching levels returns to (.+)\.$/u, (_all, profile) => `免确认已启用。切换级别后恢复为 ${EN_TO_ZH.get(profile) ?? profile}。`],
    [/^Without confirmation is active\. Select to return to (.+)\.$/u, (_all, profile) => `免确认已启用。选择后恢复为 ${EN_TO_ZH.get(profile) ?? profile}。`],
    [/^(.+) · Open ChatGPT Connection$/u, (_all, status) => `${EN_TO_ZH.get(status) ?? translatePattern(status)} · 打开 ChatGPT 连接`],
    [/^(.+) · Change ChatGPT permission$/u, (_all, profile) => `${EN_TO_ZH.get(profile) ?? translatePattern(profile)} · 更改 ChatGPT 权限`],
    [/^Confirmation bypass is active · L4 · Revoke returns to (.+)\.$/u, (_all, profile) => `免确认模式已启用 · L4 · 撤销后恢复为 ${EN_TO_ZH.get(profile) ?? profile}。`],
    [/^Revoke L4 and return to (.+)$/u, (_all, profile) => `撤销 L4 并恢复为 ${EN_TO_ZH.get(profile) ?? profile}`],
    [/^Workspace restore (enabled|disabled) · L4 remains active · revoke fallback is (.+)\.$/u, (_all, action, profile) => `工作区恢复已${action === "enabled" ? "启用" : "关闭"} · L4 仍然生效 · 撤销后回退为 ${EN_TO_ZH.get(profile) ?? profile}。`],
    [/^Workspace restore (enabled|disabled) · active permission remains (.+)\.$/u, (_all, action, profile) => `工作区恢复已${action === "enabled" ? "启用" : "关闭"} · 当前权限仍为 ${EN_TO_ZH.get(profile) ?? profile}。`],
    [/^L4 active · revoke fallback is (.+)$/u, (_all, profile) => `L4 已启用 · 撤销后回退为 ${EN_TO_ZH.get(profile) ?? profile}`],
    [/^Tunnel ready · Open Web Agent connection$/u, () => "隧道已就绪 · 打开网页 Agent 连接"],
  ];
  for (const [pattern, replacement] of patterns) {
    const match = value.match(pattern);
    if (match !== null) {
      return replacement(...match);
    }
  }
  return translateTaskBoardPattern(value) ?? value;
}

function translateValue(value: string, language: UiLanguage): string {
  if (language === "en") {
    return value;
  }
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);
  if (core.length === 0) {
    return value;
  }
  const translated = EN_TO_ZH.get(core) ?? translatePattern(core);
  return `${leading}${translated}${trailing}`;
}

function textSource(node: Text): LocalizedSource {
  const current = node.nodeValue ?? "";
  const existing = TEXT_SOURCES.get(node);
  if (existing !== undefined && current === existing.rendered) {
    return existing;
  }
  const source = { source: current, rendered: current };
  TEXT_SOURCES.set(node, source);
  return source;
}

function localizeTextNode(node: Text, language: UiLanguage): void {
  const parent = node.parentElement;
  if (parent === null || parent.closest(USER_TEXT_SELECTOR) !== null) {
    return;
  }
  const state = textSource(node);
  const translated = translateValue(state.source, language);
  state.rendered = translated;
  if ((node.nodeValue ?? "") !== translated) {
    node.nodeValue = translated;
  }
}

function attributeSource(
  element: Element,
  attribute: LocalizableAttribute,
  current: string,
): LocalizedSource {
  let records = ATTRIBUTE_SOURCES.get(element);
  if (records === undefined) {
    records = new Map<LocalizableAttribute, LocalizedSource>();
    ATTRIBUTE_SOURCES.set(element, records);
  }
  const existing = records.get(attribute);
  if (existing !== undefined && current === existing.rendered) {
    return existing;
  }
  const source = { source: current, rendered: current };
  records.set(attribute, source);
  return source;
}

function localizeElementAttributes(element: Element, language: UiLanguage): void {
  if (element.closest(SKIP_SELECTOR) !== null) {
    return;
  }
  for (const attribute of LOCALIZABLE_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    if (current === null) {
      continue;
    }
    const state = attributeSource(element, attribute, current);
    const translated = translateValue(state.source, language);
    state.rendered = translated;
    if (translated !== current) {
      element.setAttribute(attribute, translated);
    }
  }
}

export function localizeSubtree(root: Node, language: UiLanguage): void {
  document.documentElement.lang = language;
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root as Text, language);
    return;
  }
  if (root instanceof Element) {
    localizeElementAttributes(root, language);
  }
  const elementRoot = root instanceof Document ? root.documentElement : root;
  if (elementRoot instanceof Element) {
    for (const element of elementRoot.querySelectorAll("*")) {
      localizeElementAttributes(element, language);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    localizeTextNode(node as Text, language);
    node = walker.nextNode();
  }
}

export function observeLocalization(
  root: HTMLElement,
  language: () => UiLanguage,
): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        localizeSubtree(mutation.target, language());
        continue;
      }
      if (mutation.type === "attributes") {
        if (mutation.target instanceof Element) {
          localizeElementAttributes(mutation.target, language());
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        localizeSubtree(node, language());
      }
    }
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: [...LOCALIZABLE_ATTRIBUTES],
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => observer.disconnect();
}
