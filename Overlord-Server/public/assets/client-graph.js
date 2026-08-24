import cytoscape from "/vendor/cytoscape/cytoscape.esm.min.mjs";

const container = document.getElementById("client-graph");
const searchInput = document.getElementById("graph-search");
const statusSelect = document.getElementById("graph-status");
const layoutSelect = document.getElementById("graph-layout");
const refreshBtn = document.getElementById("graph-refresh");
const fitBtn = document.getElementById("graph-fit");
const summaryEl = document.getElementById("graph-summary");
const detailTitle = document.getElementById("graph-detail-title");
const detailMeta = document.getElementById("graph-detail-meta");
const detailActions = document.getElementById("graph-detail-actions");

let cy = null;
let currentGraph = null;
let searchTimer = null;
let graphPageActive = true;
const LARGE_GRAPH_ANIMATION_CLIENTS = 30000;

const typeColors = {
  client: "#38bdf8",
  group: "#a78bfa",
  build: "#f59e0b",
  os: "#22c55e",
  country: "#f472b6",
  subnet: "#60a5fa",
  user: "#f97316",
  status: "#64748b",
};

function flagEmoji(country) {
  const cc = String(country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "ZZ") return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + cc.charCodeAt(0) - 65,
    base + cc.charCodeAt(1) - 65,
  );
}

function osSymbol(osRaw) {
  const os = String(osRaw || "").toLowerCase();
  if (os.includes("win")) return "⊞";
  if (os.includes("mac") || os.includes("darwin")) return "⌘";
  if (os.includes("android")) return "▣";
  if (os.includes("ubuntu")) return "◌";
  if (os.includes("debian")) return "◆";
  if (os.includes("fedora")) return "●";
  if (os.includes("freebsd")) return "◇";
  if (os.includes("linux")) return "⬢";
  return "◯";
}

function nodeDisplayLabel(data) {
  const label = String(data.label || data.id || "");
  if (data.type === "country") {
    const flag = flagEmoji(label);
    return flag ? `${flag} ${label} ${flag}` : label;
  }
  if (data.type === "os") return `${osSymbol(label)}\n${label}`;
  if (data.type === "status") return `${data.online ? "●" : "○"}\n${label}`;
  if (data.type === "group") return `◫\n${label}`;
  if (data.type === "build") return `⬡\n${label}`;
  if (data.type === "subnet") return `⌁\n${label}`;
  if (data.type === "user") return `@\n${label}`;
  return label;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setSummary(summary) {
  if (!summaryEl) return;
  const total = summary.totalClients && summary.totalClients !== summary.clients
    ? ` of ${summary.totalClients}`
    : "";
  summaryEl.textContent = `${summary.clients}${total} clients, ${summary.online} online, ${summary.relationships} relationships`;
}

function graphElements(graph) {
  return [
    ...graph.nodes.map((node) => ({
      group: "nodes",
      data: {
        ...node.data,
        color: node.data.color || typeColors[node.data.type] || "#94a3b8",
        displayLabel: nodeDisplayLabel(node.data),
      },
    })),
    ...graph.edges.map((edge) => ({ group: "edges", data: edge.data })),
  ];
}

function shouldAnimateLayout(graph = currentGraph) {
  const total = Number(graph?.summary?.totalClients || graph?.summary?.clients || 0);
  return total < LARGE_GRAPH_ANIMATION_CLIENTS;
}

function layoutOptions(name, graph = currentGraph) {
  const animate = shouldAnimateLayout(graph);
  if (name === "grid") {
    return { name, animate, animationDuration: animate ? 260 : 0, padding: 36 };
  }
  if (name === "circle") {
    return { name, animate, animationDuration: animate ? 260 : 0, padding: 36 };
  }
  if (name === "breadthfirst") {
    return { name, directed: false, animate, animationDuration: animate ? 260 : 0, padding: 36, spacingFactor: 1.15 };
  }
  return {
    name: "cose",
    animate,
    animationDuration: animate ? 360 : 0,
    padding: 40,
    idealEdgeLength: 110,
    nodeRepulsion: 5200,
    gravity: 0.28,
    numIter: 900,
  };
}

function showSelection(node) {
  if (!detailTitle || !detailMeta || !detailActions) return;
  if (!node) {
    detailTitle.textContent = "Nothing selected";
    detailMeta.innerHTML = "";
    detailActions.innerHTML = "";
    return;
  }

  const data = node.data();
  const meta = data.meta || {};
  const countryFlag = flagEmoji(meta.country || (data.type === "country" ? data.label : ""));
  detailTitle.textContent = data.type === "country" && countryFlag
    ? `${countryFlag} ${data.label || data.id} ${countryFlag}`
    : data.label || data.id;
  const rows = [
    ["Type", data.type],
    ["Count", data.type === "client" ? "" : data.count || 1],
    ["Online", data.type === "client" ? (data.online ? "Yes" : "No") : data.onlineCount || 0],
    ["Client ID", data.clientId || meta.id || ""],
    ["Host", meta.host || ""],
    ["User", meta.user || ""],
    ["OS", meta.os || ""],
    ["IP", meta.ip || ""],
    ["Country", meta.country ? `${countryFlag ? `${countryFlag} ` : ""}${meta.country}${countryFlag ? ` ${countryFlag}` : ""}` : ""],
    ["Group", meta.groupName || ""],
    ["Build", meta.buildTag || ""],
  ].filter(([, value]) => value !== "" && value !== undefined && value !== null);

  detailMeta.innerHTML = rows.map(([label, value]) => `
    <div class="graph-meta-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");

  if (data.clientId) {
    const id = encodeURIComponent(data.clientId);
    const online = data.online === true;
    const disabled = online ? "" : " disabled aria-disabled=\"true\" title=\"Client is offline\"";
    const disabledNote = online
      ? ""
      : `<div class="graph-action-note"><i class="fa-solid fa-plug-circle-xmark"></i><span>Client is offline</span></div>`;
    detailActions.innerHTML = `
      ${disabledNote}
      <button class="graph-action graph-action--remote" data-graph-action="/remotedesktop?clientId=${id}"${disabled}>
        <i class="fa-solid fa-desktop"></i><span>Remote Desktop</span>
      </button>
      <button class="graph-action graph-action--console" data-graph-action="/${id}/console"${disabled}>
        <i class="fa-solid fa-terminal"></i><span>Console</span>
      </button>
      <button class="graph-action graph-action--files" data-graph-action="/${id}/files"${disabled}>
        <i class="fa-solid fa-folder-tree"></i><span>File Browser</span>
      </button>
      <button class="graph-action graph-action--copy" data-graph-copy="${escapeHtml(data.clientId)}">
        <i class="fa-solid fa-copy"></i><span>Copy ID</span>
      </button>
    `;
  } else {
    detailActions.innerHTML = "";
  }
}

function bindInspectorActions() {
  detailActions?.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
    const href = button.dataset.graphAction;
    if (href) {
      window.open(href, "_blank", "noopener");
      return;
    }
    const copyValue = button.dataset.graphCopy;
    if (copyValue) {
      await navigator.clipboard?.writeText(copyValue);
    }
  });
}

function selectNode(node) {
  if (!cy) return;
  cy.elements().removeClass("graph-dim graph-focus");
  if (!node) {
    showSelection(null);
    return;
  }
  const neighborhood = node.closedNeighborhood();
  cy.elements().difference(neighborhood).addClass("graph-dim");
  neighborhood.addClass("graph-focus");
  showSelection(node);
}

function renderGraph(graph) {
  if (!graphPageActive || !container?.isConnected) return;
  currentGraph = graph;
  setSummary(graph.summary);

  if (!cy) {
    cy = cytoscape({
      container,
      elements: graphElements(graph),
      minZoom: 0.18,
      maxZoom: 5,
      wheelSensitivity: 1.8,
      style: [
        {
          selector: "node",
          style: {
            label: "data(displayLabel)",
            "background-color": "data(color)",
            "border-color": "#020617",
            "border-width": 2,
            color: "#dbeafe",
            "font-family": "Inter, Segoe UI, sans-serif",
            "font-size": 11,
            "font-weight": 600,
            "text-outline-color": "#020617",
            "text-outline-width": 3,
            "text-valign": "center",
            "text-halign": "center",
            "line-height": 1.15,
            "text-wrap": "wrap",
            "text-max-width": 88,
            width: "mapData(weight, 1, 12, 28, 74)",
            height: "mapData(weight, 1, 12, 28, 74)",
          },
        },
        {
          selector: 'node[type = "client"]',
          style: {
            shape: "round-rectangle",
            "border-color": "data(color)",
            "border-width": 3,
          },
        },
        {
          selector: 'node[online = true]',
          style: {
            "border-color": "#22c55e",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.35,
            "line-color": "rgba(148, 163, 184, 0.42)",
            "target-arrow-shape": "none",
            "curve-style": "bezier",
          },
        },
        {
          selector: ".graph-dim",
          style: {
            opacity: 0.12,
          },
        },
        {
          selector: ".graph-focus",
          style: {
            opacity: 1,
          },
        },
      ],
    });

    cy.on("tap", "node", (event) => selectNode(event.target));
    cy.on("tap", (event) => {
      if (event.target === cy) selectNode(null);
    });
  } else {
    cy.elements().remove();
    cy.add(graphElements(graph));
  }

  cy.layout(layoutOptions(layoutSelect?.value || "cose", graph)).run();
  setTimeout(() => cy?.fit(undefined, 32), 420);
}

async function loadGraph() {
  if (!graphPageActive || !container) return;
  if (summaryEl) summaryEl.textContent = "Loading...";
  const params = new URLSearchParams({
    limit: "350",
    q: searchInput?.value || "",
    status: statusSelect?.value || "all",
  });
  const res = await fetch(`/api/client-graph?${params}`, { credentials: "include" });
  if (!res.ok) {
    if (!graphPageActive) return;
    if (summaryEl) summaryEl.textContent = `Graph unavailable (${res.status})`;
    return;
  }
  const graph = await res.json();
  if (graphPageActive) renderGraph(graph);
}

function debounceLoad() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadGraph, 220);
}

layoutSelect?.addEventListener("change", () => {
  if (cy) cy.layout(layoutOptions(layoutSelect.value, currentGraph)).run();
});
searchInput?.addEventListener("input", debounceLoad);
statusSelect?.addEventListener("change", loadGraph);
refreshBtn?.addEventListener("click", loadGraph);
fitBtn?.addEventListener("click", () => cy?.fit(undefined, 32));
const handleResize = () => {
  cy?.resize();
  cy?.fit(undefined, 32);
};
window.addEventListener("resize", handleResize);

window.addEventListener("pagehide", () => {
  graphPageActive = false;
  clearTimeout(searchTimer);
  window.removeEventListener("resize", handleResize);
  cy?.destroy();
  cy = null;
}, { once: true });

bindInspectorActions();
loadGraph();
