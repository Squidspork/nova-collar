/** Slash commands for the console. Chat text falls through. */

export function parseConsole(line) {
  const text = String(line || "").trim();
  if (!text) return { type: "empty" };
  if (text === "/help" || text === "/?") return { type: "help" };
  if (text === "/theme" || text === "/themes") return { type: "theme", name: "" };
  if (/^\/theme\s+/i.test(text)) return { type: "theme", name: text.replace(/^\/theme\s+/i, "").trim() };
  if (text === "/new") return { type: "new" };
  if (text === "/chats") return { type: "chats" };
  if (text === "/quit" || text === "/exit") return { type: "quit" };
  if (text === "/disk") return { type: "pack", name: "host_disk", args: {} };
  if (text === "/ports") return { type: "pack", name: "host_listen_ports", args: {} };
  if (text === "/load" || text === "/ps") return { type: "pack", name: "host_processes", args: { limit: 12 } };
  if (text === "/facts") return { type: "pack", name: "host_facts", args: {} };
  if (text === "/docker") return { type: "pack", name: "docker_ps", args: {} };
  if (text === "/goal") return { type: "goal", text: "/goal" };
  if (/^\/goal\b/i.test(text)) return { type: "goal", text };
  if (/^\/open\s+/i.test(text)) return { type: "open", query: text.replace(/^\/open\s+/i, "").trim() };
  if (/^\/http\s+/i.test(text)) return { type: "pack", name: "http_check", args: { url: text.replace(/^\/http\s+/i, "").trim() } };
  if (/^\/service\s+/i.test(text)) return { type: "pack", name: "host_service_status", args: { name: text.replace(/^\/service\s+/i, "").trim() } };
  if (/^\/logs\s+/i.test(text)) return { type: "pack", name: "host_tail_log", args: { path: text.replace(/^\/logs\s+/i, "").trim(), lines: 40 } };
  if (/^\/ping\s+/i.test(text)) return { type: "pack", name: "ping_check", args: { host: text.replace(/^\/ping\s+/i, "").trim() } };
  if (/^\/dns\s+/i.test(text)) return { type: "pack", name: "dns_lookup", args: { name: text.replace(/^\/dns\s+/i, "").trim(), type: "A" } };
  if (/^\/whois\s+/i.test(text)) return { type: "pack", name: "whois_lookup", args: { query: text.replace(/^\/whois\s+/i, "").trim() } };
  if (/^\/tcp\s+/i.test(text)) {
    const [host, port] = text.replace(/^\/tcp\s+/i, "").trim().split(/\s+/);
    return { type: "pack", name: "tcp_check", args: { host, port: Number(port) } };
  }
  if (/^\/cd\s+/i.test(text)) return { type: "cd", path: text.replace(/^\/cd\s+/i, "").trim() };
  if (/^\/model\b/i.test(text)) return { type: "model", name: text.replace(/^\/model\s*/i, "").trim() };
  if (text.startsWith("/")) return { type: "unknown", text };
  return { type: "chat", text };
}

export const HELP = [
  "Nova Collar console. Same chats as the window. This seat is the duty officer.",
  "Last writer wins if the window has the same chat open.",
  "/goal            show the standing goal",
  "/goal text       set it. /goal clear turns it off",
  "/new             new shared chat",
  "/chats           list chats the window can open",
  "/open 2          open a chat by the number in /chats",
  "/disk            disk on this machine",
  "/ports           listening ports",
  "/load            busiest processes",
  "/facts           OS, CPU, memory",
  "/service name    macOS launchd or brew, Linux systemd",
  "/logs path       last lines of a log",
  "/http URL        status code",
  "/ping host       three pings",
  "/dns name        A record",
  "/tcp host port   open or closed",
  "/docker          containers, if Docker is running",
  "/cd path         working folder for files",
  "/model           show or set the model",
  "/theme           coat list. Arrows pick, Enter sets. Tab completes.",
  "/quit            leave. Ctrl-C stops a turn, then leaves",
  "Anything else goes to Nova Collar.",
].join("\n");
