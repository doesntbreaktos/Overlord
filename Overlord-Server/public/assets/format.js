export function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatBytes(bytes, fractionDigits = 2) {
  const value = Number(bytes) || 0;
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024)));
  const scaled = value / Math.pow(1024, unitIndex);
  return `${parseFloat(scaled.toFixed(fractionDigits))} ${units[unitIndex]}`;
}

export function formatDate(timestamp, empty = "") {
  const ts = Number(timestamp) || 0;
  if (!ts) return empty;
  return new Date(ts).toLocaleString();
}

export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - Number(timestamp || 0)) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
