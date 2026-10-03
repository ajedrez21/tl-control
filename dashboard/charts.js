function barChart(el, items, onClick) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const w = Math.max(480, items.length * 72);
  const h = 180;
  const barW = 40;
  el.innerHTML = `<svg class="bar" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gráfico de barras">
    ${items.map((item, i) => {
      const x = 24 + i * 72;
      const bh = (item.value / max) * 120;
      const y = 140 - bh;
      return `<g data-key="${item.key}" tabindex="0" role="button">
        <rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="currentColor" rx="6"></rect>
        <text x="${x + barW / 2}" y="158" text-anchor="middle" font-size="11">${escapeHtml(item.label)}</text>
        <title>${escapeHtml(item.label)}: ${item.value}. ${item.hint || ""}</title>
      </g>`;
    }).join("")}
  </svg>`;
  el.querySelectorAll("g").forEach((g) => {
    g.addEventListener("click", () => onClick?.(g.getAttribute("data-key")));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") onClick?.(g.getAttribute("data-key")); });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
