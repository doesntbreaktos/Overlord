(() => {
  const PLUGIN_ID = "chat";
  const MAX_ATTACHMENT_SIZE = 64 * 1024 * 1024;
  const MAX_ATTACHMENT_BASE64_SIZE = Math.ceil(MAX_ATTACHMENT_SIZE / 3) * 4;
  const SAFE_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);

  const params = new URLSearchParams(window.location.search);

  const clientIdInput   = document.getElementById("client-id");
  const operatorNameIn  = document.getElementById("operator-name");
  const targetNameIn    = document.getElementById("target-name");
  const windowTitleIn   = document.getElementById("window-title");
  const optClosable     = document.getElementById("opt-closable");
  const optOnTop        = document.getElementById("opt-ontop");
  const btnOpen         = document.getElementById("btn-open");
  const btnClose        = document.getElementById("btn-close");
  const btnClear        = document.getElementById("btn-clear");
  const statusDot       = document.getElementById("status-dot");
  const statusText      = document.getElementById("status-text");
  const messagesEl      = document.getElementById("messages");
  const msgInput        = document.getElementById("msg-input");
  const btnSend         = document.getElementById("btn-send");
  const btnAttach       = document.getElementById("btn-attach");
  const fileInput       = document.getElementById("file-input");
  const configToggle    = document.getElementById("config-toggle");
  const configBody      = document.getElementById("config-body");

  let chatOpen = false;
  let sseStream = null;
  const attachmentUrlCache = new Map();

  clientIdInput.value = params.get("clientId") || "";

  function getClientId() {
    return clientIdInput.value.trim();
  }

  function setStatus(open) {
    chatOpen = open;
    statusDot.className = "chat-status-dot" + (open ? " open" : "");
    statusText.textContent = open ? "Chat is open" : "Chat not opened";
    btnOpen.disabled   = open;
    btnClose.disabled  = !open;
    msgInput.disabled  = !open;
    btnSend.disabled   = !open;
    btnAttach.disabled = !open;
    if (open) msgInput.focus();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = r.result;
        const i = s.indexOf(",");
        resolve(i < 0 ? s : s.slice(i + 1));
      };
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  async function loadAttachmentBlob(id, expectedMime) {
    if (attachmentUrlCache.has(id)) return attachmentUrlCache.get(id);
    const clientId = getClientId();
    if (!clientId) return null;
    const { ok, result } = await rpc("get_attachment", { id, clientId });
    if (
      !ok ||
      !result?.ok ||
      (SAFE_IMAGE_MIMES.has(expectedMime) && result.mime !== expectedMime) ||
      typeof result.dataB64 !== "string" ||
      result.dataB64.length === 0 ||
      result.dataB64.length > MAX_ATTACHMENT_BASE64_SIZE
    ) return null;
    let bin;
    try {
      bin = atob(result.dataB64);
    } catch {
      return null;
    }
    if (bin.length === 0 || bin.length > MAX_ATTACHMENT_SIZE) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], {
      type: SAFE_IMAGE_MIMES.has(expectedMime) ? expectedMime : "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    if (attachmentUrlCache.size >= 10) {
      const oldestId = attachmentUrlCache.keys().next().value;
      const oldestUrl = attachmentUrlCache.get(oldestId);
      if (oldestUrl) URL.revokeObjectURL(oldestUrl);
      attachmentUrlCache.delete(oldestId);
    }
    attachmentUrlCache.set(id, url);
    return url;
  }

  function showImagePreview(url, name) {
    const overlay = document.createElement("div");
    overlay.className = "chat-image-preview";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `Image preview: ${name}`);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "chat-image-preview-close";
    close.setAttribute("aria-label", "Close image preview");
    close.textContent = "×";

    const image = document.createElement("img");
    image.src = url;
    image.alt = name;

    const remove = () => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") remove();
    };
    close.addEventListener("click", remove);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) remove();
    });
    document.addEventListener("keydown", onKeyDown);

    overlay.append(image, close);
    document.body.appendChild(overlay);
    close.focus();
  }

  function renderAttachment(att, messageId) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg-attachment";
    const mime = String(att?.mime || "").trim().toLowerCase();
    const name = String(att?.name || "image").slice(0, 255);
    const sizeValue = Number(att?.size);
    const size = Number.isFinite(sizeValue) && sizeValue >= 0
      ? Math.min(sizeValue, MAX_ATTACHMENT_SIZE)
      : 0;
    const isImage = SAFE_IMAGE_MIMES.has(mime) && size > 0 && size <= MAX_ATTACHMENT_SIZE;

    if (isImage) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "chat-msg-file";
      view.textContent = `View image: ${name} (${humanSize(size)})`;
      view.addEventListener("click", async () => {
        view.disabled = true;
        const url = await loadAttachmentBlob(messageId, mime);
        if (url) showImagePreview(url, name);
        view.disabled = false;
      });
      wrap.appendChild(view);
    } else {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "chat-msg-file";
      download.textContent = `Download: ${name} (${humanSize(size)})`;
      download.addEventListener("click", async () => {
        download.disabled = true;
        const url = await loadAttachmentBlob(messageId, mime);
        if (url) {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = name;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }
        download.disabled = false;
      });
      wrap.appendChild(download);
    }
    return wrap;
  }

  function appendMessage(msg) {
    const isOut = msg.direction === "to_target";
    const div = document.createElement("div");
    div.className = "chat-msg " + (isOut ? "outgoing" : "incoming");

    const senderDiv = document.createElement("div");
    senderDiv.className = "chat-msg-sender";
    senderDiv.textContent = msg.sender;
    div.appendChild(senderDiv);

    if (msg.text) {
      const textDiv = document.createElement("div");
      textDiv.className = "chat-msg-text";
      textDiv.textContent = msg.text;
      div.appendChild(textDiv);
    }

    if (msg.attachment) {
      div.appendChild(renderAttachment(msg.attachment, msg.id));
    }

    const timeDiv = document.createElement("div");
    timeDiv.className = "chat-msg-time";
    timeDiv.textContent = formatTime(msg.timestamp || Date.now());
    div.appendChild(timeDiv);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function rpc(method, rpcParams) {
    const res = await fetch(`/api/plugins/${PLUGIN_ID}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: rpcParams }),
    });
    return res.json();
  }

  async function sendPluginEvent(clientId, event, payload) {
    const res = await fetch(
      `/api/clients/${encodeURIComponent(clientId)}/plugins/${PLUGIN_ID}/event`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, payload }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Event failed: ${res.status} ${t}`);
    }
  }

  async function loadHistory() {
    const cid = getClientId();
    if (!cid) return;
    const { ok, result } = await rpc("get_history", { clientId: cid });
    if (!ok || !result) return;
    for (const url of attachmentUrlCache.values()) URL.revokeObjectURL(url);
    attachmentUrlCache.clear();
    messagesEl.innerHTML = "";
    for (const m of result) appendMessage(m);
  }

  function connectSSE() {
    if (sseStream) sseStream.close();
    const clientId = getClientId();
    if (!clientId) return;
    sseStream = new EventSource(
      `/api/plugins/${PLUGIN_ID}/stream?clientId=${encodeURIComponent(clientId)}`,
    );

    sseStream.addEventListener("new_message", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      appendMessage(data);
    });

    sseStream.addEventListener("chat_status", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      setStatus(data.status === "opened");
    });

    sseStream.addEventListener("history_cleared", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      for (const url of attachmentUrlCache.values()) URL.revokeObjectURL(url);
      attachmentUrlCache.clear();
      messagesEl.innerHTML = "";
    });
  }

  // --- Event handlers ---

  btnOpen.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) { alert("Enter a Client ID first."); return; }
    try {
      await sendPluginEvent(cid, "open_chat", {
        operatorName: operatorNameIn.value.trim() || "Operator",
        targetName:   targetNameIn.value.trim()   || "User",
        title:        windowTitleIn.value.trim()   || "Chat",
        closable:     optClosable.checked,
        alwaysOnTop:  optOnTop.checked,
      });
      setStatus(true);
      loadHistory();
      connectSSE();
    } catch (err) {
      alert("Failed to open chat: " + err.message);
    }
  });

  btnClose.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) return;
    try {
      await sendPluginEvent(cid, "close_chat", {});
      setStatus(false);
    } catch (err) {
      alert("Failed to close chat: " + err.message);
    }
  });

  btnSend.addEventListener("click", async () => {
    const cid = getClientId();
    const text = msgInput.value.trim();
    if (!cid || !text) return;

    const sender = operatorNameIn.value.trim() || "Operator";
    msgInput.value = "";
    msgInput.focus();

    try {
      await rpc("store_message", { clientId: cid, sender, text });
      await sendPluginEvent(cid, "chat_message", { from: sender, text });
    } catch (err) {
      appendMessage({
        sender: "System",
        text: "Failed to send: " + err.message,
        direction: "from_target",
        timestamp: Date.now(),
      });
    }
  });

  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btnSend.click();
    }
  });

  btnAttach.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_SIZE) {
      alert(`File is too large (${humanSize(file.size)}). Max is ${humanSize(MAX_ATTACHMENT_SIZE)}.`);
      return;
    }
    const cid = getClientId();
    if (!cid) { alert("Enter a Client ID first."); return; }

    const sender = operatorNameIn.value.trim() || "Operator";
    const prevDisabled = btnAttach.disabled;
    btnAttach.disabled = true;
    try {
      const dataB64 = await readFileAsBase64(file);
      // Some platforms leave File.type blank for otherwise valid images. The
      // server detects the real raster format and returns its canonical MIME.
      const mime = file.type || "";
      const stored = await rpc("store_attachment", {
        clientId: cid,
        sender,
        name: file.name,
        mime,
        dataB64,
      });
      if (!stored.ok || !stored.result?.ok) {
        throw new Error(stored.result?.error || stored.error || "Attachment rejected");
      }
      await sendPluginEvent(cid, "chat_attachment", {
        from: sender,
        name: stored.result.name,
        mime: stored.result.mime,
        dataB64,
      });
    } catch (err) {
      appendMessage({
        sender: "System",
        text: "Failed to send file: " + err.message,
        direction: "from_target",
        timestamp: Date.now(),
      });
    } finally {
      btnAttach.disabled = prevDisabled;
    }
  });

  btnClear.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) return;
    await rpc("clear_history", { clientId: cid });
  });

  configToggle.addEventListener("click", () => {
    configToggle.classList.toggle("collapsed");
    configBody.classList.toggle("hidden");
  });

  // --- Init ---

  if (getClientId()) {
    loadHistory();
    connectSSE();
  }
})();
