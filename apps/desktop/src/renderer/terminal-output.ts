import type { DesktopTerminalSession } from "../shared.js";

export function formatTerminalOutput(
  session: Pick<DesktopTerminalSession, "output" | "state" | "outputTruncated" | "error">,
  language = "en",
): string {
  const chinese = language.toLowerCase().startsWith("zh");
  let text = session.output.length > 0 ? session.output : session.state === "starting"
    ? chinese ? "正在启动原生终端…" : "Starting native ConPTY…"
    : chinese ? "尚未捕获终端输出。" : "No terminal output captured.";
  if (session.outputTruncated) {
    const note = chinese ? "[部分较早的输出已省略，以下为最近保留的输出]" : "[Earlier output omitted; showing the latest retained output]";
    text = `${note}\n${text}`;
  }
  if (session.error !== null) text += `\n[error] ${session.error}`;
  return text;
}
