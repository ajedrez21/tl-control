const STATE_COLORS = {
  NEW: "#94a3b8", OTHER: "#667085", READY: "#2f7fd1", DOING: "#2f5bea",
  REVIEW: "#7c3aed", BLOCKED: "#c4262e", DEV_DONE: "#1a9b5c", QA: "#10b981",
  UAT: "#0d9488", PENDING_RELEASE: "#d9a400", PRODUCTION: "#1a9b5c", REMOVED: "#98a2b3"
};

function stateColor(key) {
  return STATE_COLORS[key] || "var(--accent)";
}

function donutChart(el, items, onClick) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const active = items.filter((i) => i.value > 0);
  let offset = 25;
  const circumference = 100;
  const rings = active.map((item) => {
    const pct = (item.value / (total || 1)) * circumference;
    const dash = `${pct.toFixed(3)} ${(circumference - pct).toFixed(3)}`;
    const ring = `<circle class="donut-seg" cx="21" cy="21" r="15.9155" fill="none" stroke="${stateColor(item.key)}" stroke-width="6" stroke-dasharray="${dash}" stroke-dashoffset="${offset.toFixed(3)}" data-key="${item.key}" tabindex="0" role="button"><title>${escapeHtml(item.label)}: ${item.value}</title></circle>`;
    offset -= pct;
    return ring;
  }).join("");
  const legend = active.map((item) => `
    <div class="legend-row" data-key="${item.key}" tabindex="0" role="button">
      <span class="dot" style="background:${stateColor(item.key)}"></span>
      ${escapeHtml(item.label)}: <b>${item.value}</b>
    </div>`).join("");
  el.innerHTML = `
    <div class="donut">
      <svg viewBox="0 0 42 42" role="img" aria-label="Distribución por estado">
        ${rings || `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--line)" stroke-width="6"/>`}
        <text x="21" y="22.5" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor">${total}</text>
        <text x="21" y="28" text-anchor="middle" font-size="3" fill="currentColor" opacity=".7">ítems</text>
      </svg>
      <div class="legend">${legend || "<span class='hint'>Sin datos</span>"}</div>
    </div>`;
  el.querySelectorAll("[data-key]").forEach((node) => {
    const key = node.getAttribute("data-key");
    node.addEventListener("click", () => onClick?.(key));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick?.(key);
      }
    });
  });
}

function hBarChart(el, items, onClick) {
  const visible = items.filter((i) => i.value > 0);
  const max = Math.max(1, ...visible.map((i) => i.value));
  el.innerHTML = visible.length
    ? visible.map((item) => `
    <div class="hbar" data-key="${item.key}" tabindex="0" role="button" title="${escapeHtml(item.label)}: ${item.value}">
      <em>${escapeHtml(item.label)}</em>
      <i style="width:${((item.value / max) * 100).toFixed(1)}%;background:${stateColor(item.key)}"></i>
      <b>${item.value}</b>
    </div>`).join("")
    : `<div class="empty">Sin ítems en el sprint.</div>`;
  el.querySelectorAll(".hbar").forEach((row) => {
    const key = row.getAttribute("data-key");
    row.addEventListener("click", () => onClick?.(key));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick?.(key);
      }
    });
  });
}

function stackChart(el, segments) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const legend = segments.map((s) => `
    <div class="legend-row">
      <span class="dot" style="background:${s.color}"></span>
      ${escapeHtml(s.label)}: <b>${s.value}</b>
    </div>`).join("");
  el.innerHTML = `
    <div class="stack">${segments.map((s) => {
      const w = (Math.max(0, s.value) / total) * 100;
      return `<span style="width:${w.toFixed(2)}%;background:${s.color}" title="${escapeHtml(s.label)}: ${s.value}"></span>`;
    }).join("")}</div>
    <div class="legend">${legend}</div>`;
}

/** @deprecated use donutChart or hBarChart */
function barChart(el, items, onClick) {
  hBarChart(el, items, onClick);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
