import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/xterm/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.mjs";
import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";

const containerEl = document.getElementById("terminal");
const statusPill = document.getElementById("status-pill");
const clientLabel = document.getElementById("client-label");
const hostLabel = document.getElementById("host-label");
const userLabel = document.getElementById("user-label");
const osLabel = document.getElementById("os-label");
const reconnectBtn = document.getElementById("reconnect-btn");
const clearBtn = document.getElementById("clear-btn");
const interruptBtn = document.getElementById("interrupt-btn");

const clientId = decodeURIComponent(
  location.pathname.split("/").filter(Boolean)[0] || "",
);
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProto}://${location.host}/api/clients/${encodeURIComponent(clientId)}/console/ws`;

const THEME = {
  background: "#050913",
  foreground: "#e8edf2",
  cursor: "#6ee7b7",
  cursorAccent: "#050913",
  selectionBackground: "rgba(110, 231, 183, 0.25)",
  black: "#1a1d29",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e8edf2",
  brightBlack: "#475569",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

let term = null;
let fit = null;
let ws = null;
let connected = false;
let sessionClosed = false;
let offlineNotified = false;
let lastSize = { cols: 0, rows: 0 };
let resizeTimer = 0;
let pendingSystem = [];

function isWindowsOs(os) {
  return typeof os === "string" && /win/i.test(os);
}

function initTerminal(os) {
  if (term) return;
  const opts = {
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEME,
  };
  if (isWindowsOs(os)) {
    opts.windowsPty = { backend: "conpty", buildNumber: 22621 };
  }

  term = new Terminal(opts);
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(containerEl);

  term.onData((d) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (sessionClosed) return;
    ws.send(encodeMsgpack({ type: "input", data: d }));
  });

  term.onResize(() => {
    sendResize();
  });

  for (const msg of pendingSystem) term.writeln(msg);
  pendingSystem.length = 0;

  tryFit();
}

function tryFit() {
  if (!fit) return;
  try {
    fit.fit();
  } catch {
    /* ignore: container not yet measured */
  }
}

function setStatus(label, tone = "pill-offline") {
  if (!statusPill) return;
  statusPill.className = `pill ${tone}`;
  statusPill.innerHTML = '<i class="fa-solid fa-circle"></i>';
  statusPill.appendChild(document.createTextNode(` ${String(label || "")}`));
}

function writeSystem(msg) {
  const line = `\x1b[2m[${msg}]\x1b[0m`;
  if (term) {
    term.writeln(line);
  } else {
    pendingSystem.push(line);
  }
}

function sendResize() {
  if (sessionClosed) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!term) return;
  const cols = term.cols;
  const rows = term.rows;
  if (!cols || !rows) return;
  if (cols === lastSize.cols && rows === lastSize.rows) return;
  lastSize = { cols, rows };
  ws.send(encodeMsgpack({ type: "resize", cols, rows }));
}

function applyOutput(data) {
  if (!data || !term) return;
  if (data instanceof Uint8Array) {
    term.write(data);
  } else if (typeof data === "string") {
    term.write(data);
  } else if (data?.buffer instanceof ArrayBuffer) {
    term.write(new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength));
  }
}

function connect() {
  sessionClosed = false;
  setStatus("Connecting...", "pill-ghost");
  writeSystem("Connecting...");

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    connected = true;
    setStatus("Connected", "pill-online");
  });

  ws.addEventListener("message", (event) => {
    const payload = decodeMsgpack(event.data);
    if (!payload) return;

    switch (payload.type) {
      case "ready":
        if (clientLabel) {
          const full = payload.clientId || "unknown";
          clientLabel.textContent = full.length > 7 ? full.slice(0, 7) + "…" : full;
          clientLabel.title = full;
        }
        if (hostLabel) hostLabel.textContent = payload.host || "unknown";
        if (userLabel) userLabel.textContent = payload.user || "unknown";
        if (osLabel) osLabel.textContent = payload.os || "unknown";
        initTerminal(payload.os);
        if (term) term.options.disableStdin = false;
        tryFit();
        sendResize();
        setStatus("Live", "pill-online");
        break;
      case "status":
        if (payload.status === "offline") {
          setStatus("Offline", "pill-offline");
          if (!offlineNotified) {
            offlineNotified = true;
            writeSystem(payload.reason || "Client offline");
          }
          sessionClosed = true;
          if (term) term.options.disableStdin = true;
        } else if (payload.status === "closed") {
          setStatus("Closed", "pill-offline");
          writeSystem(payload.reason || "Console closed");
          sessionClosed = true;
          if (term) term.options.disableStdin = true;
        } else if (payload.status === "online") {
          offlineNotified = false;
        }
        break;
      case "output":
        applyOutput(payload.data);
        if (payload.error) writeSystem(payload.error);
        if (typeof payload.exitCode === "number") {
          if (term) term.writeln(`\r\n\x1b[33m[Process exited (${payload.exitCode})]\x1b[0m`);
          setStatus("Closed", "pill-offline");
          sessionClosed = true;
          if (term) term.options.disableStdin = true;
        }
        break;
      default:
        break;
    }
  });

  ws.addEventListener("close", () => {
    if (!connected) return;
    connected = false;
    setStatus("Disconnected", "pill-offline");
    if (!sessionClosed) writeSystem("Connection closed");
    if (term) term.options.disableStdin = true;
  });

  ws.addEventListener("error", () => {
    setStatus("Error", "pill-offline");
  });
}

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(tryFit, 120);
});

reconnectBtn?.addEventListener("click", () => {
  try { ws?.close(); } catch { /* ignore */ }
  if (term) term.reset();
  lastSize = { cols: 0, rows: 0 };
  connect();
});

clearBtn?.addEventListener("click", () => {
  if (term) term.clear();
});

interruptBtn?.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (sessionClosed) return;
  ws.send(encodeMsgpack({ type: "input", data: "\x03" }));
  if (term) term.focus();
});

requestAnimationFrame(() => {
  checkFeatureAccess("console", clientId).then((ok) => ok && connect());
});

const prefilledCommand = new URLSearchParams(window.location.search).get("cmd");
if (prefilledCommand) {
  setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN && !sessionClosed) {
      ws.send(encodeMsgpack({ type: "input", data: prefilledCommand + "\r" }));
    }
  }, 1200);
}
