const main = document.getElementById("main");
const statusBar = document.getElementById("status-bar");
const FILTER_KEY = "tl-control.filters";

const routes = {
  home: renderHome,
  grid: renderGrid,
  story: renderStory,
  sp: renderSp,
  team: renderTeam,
  releases: renderReleases,
  security: renderSecurity,
  history: renderHistory
};

window.addEventListener("hashchange", boot);
document.getElementById("theme-btn").addEventListener("click", toggleTheme);
document.getElementById("refresh-btn").addEventListener("click", showSyncModal);
document.getElementById("modal-close").addEventListener("click", () => document.getElementById("modal").classList.add("hidden"));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    document.getElementById("q")?.focus();
  }
  if (e.key === "Escape") document.getElementById("modal").classList.add("hidden");
});
if (localStorage.getItem("tl-theme") === "dark") document.documentElement.dataset.theme = "dark";
boot();

function parseHash() {
  const raw = (location.hash || "#/home").replace(/^#\/?/, "");
  const [name, id] = raw.split("/");
  return { name: name || "home", id };
}

async function boot() {
  const { name, id } = parseHash();
  document.querySelectorAll("nav a").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  try {
    await (routes[name] || renderHome)(id);
  } catch (err) {
    status("error", `Error: ${err.message}. ¿Está el servidor local?`);
    main.innerHTML = `<section class="panel"><h1>No se pudo cargar</h1><p>Comprobá que el dashboard corre en loopback.</p></section>`;
  }
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

function status(kind, text) {
  statusBar.className = `status ${kind}`;
  statusBar.textContent = text;
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "" : "dark";
  localStorage.setItem("tl-theme", dark ? "light" : "dark");
  document.getElementById("theme-btn").setAttribute("aria-pressed", String(!dark));
}

async function showSyncModal() {
  const home = await api("/api/home");
  document.getElementById("sync-cmd").textContent = home.syncCommand;
  document.getElementById("modal").classList.remove("hidden");
}

async function renderHome() {
  const data = await api("/api/home");
  paintMeta(data);
  main.innerHTML = `
    <h1>Control del día</h1>
    <p class="hint">Unidad de tarjetas y gráficos: historias, salvo que se indique tareas. Fuente: SQLite local. Zona ${data.timezone}. Aging: ${data.agingUnit}.</p>
    <section class="cards">${data.cards.map(cardHtml).join("")}</section>
    <section class="panel">
      <h2>Requiere atención</h2>
      ${data.alerts.length ? data.alerts.map((a) => `
        <article class="card alert">
          <p class="badge"><span class="dot ${a.severity === "alta" ? "bad" : "warn"}"></span>${esc(a.severity)} · ${esc(a.ruleId)}</p>
          <h3><a href="${a.workItemId ? `#/story/${a.workItemId.split("/").pop()}` : "#/grid"}">${esc(a.title)}</a></h3>
          <p>${esc(a.explanation)}</p>
        </article>`).join("") : "<p>Sin alertas.</p>"}
    </section>
    <section class="grid-2" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <article class="panel">
        <h2>Distribución por estado</h2>
        <p class="hint">Click filtra la grilla. Fuente: work_items.state_normalized</p>
        <div id="chart-states" class="chart"></div>
        <table><tbody>${data.charts.states.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.value}</td></tr>`).join("")}</tbody></table>
      </article>
      <article class="panel">
        <h2>Scope</h2>
        <p>${data.charts.scope.initial} + ${data.charts.scope.added} − ${data.charts.scope.removed} = ${data.charts.scope.current} ${data.charts.scope.unit}</p>
        <p class="hint">${esc(data.charts.scope.formula)}. Cobertura: ${data.charts.scope.coverage}. Crecimiento neto: ${data.charts.scope.netGrowth === null ? "N/A" : (data.charts.scope.netGrowth * 100).toFixed(1) + "%"}</p>
        <p>Carry-over: ${data.charts.scope.carryOver}. Producción confirmada: ${data.metrics.production} (deploy PROD, no Done/merge).</p>
      </article>
    </section>
  `;
  barChart(document.getElementById("chart-states"), data.charts.states.map((s) => ({ ...s, hint: "unidad: historias" })), (key) => {
    location.hash = `#/grid`;
    sessionStorage.setItem("grid-state", key);
  });
}

function cardHtml(c) {
  return `<article class="card"><h2>${esc(c.label)}</h2><p class="value">${c.value}</p><p class="hint">${esc(c.unit)} · ${esc(c.source)}</p></article>`;
}

function paintMeta(data) {
  const dates = data.dates ? `${data.dates.name ?? ""} ${data.dates.start_date ?? ""} → ${data.dates.finish_date ?? ""}` : data.iteration;
  const sync = data.lastSync;
  const cov = sync?.coverage_json ? JSON.parse(sync.coverage_json) : {};
  document.getElementById("sprint-meta").textContent = `${dates} · sync ${sync?.finished_at ?? "nunca"} · ${sync?.status ?? ""}`;
  if (data.demo) status("demo", `${data.demoWarning || "Modo demo"} · cobertura PR=${cov.pullRequests || "?"} deploy=${cov.deployments || "?"}`);
  else if (!sync) status("offline", "Sin sincronización. El dashboard muestra el último snapshot local.");
  else status("", `Última sync ${sync.finished_at}. Botón Actualizar muestra el comando CLI (no live).`);
}

async function renderGrid() {
  const home = await api("/api/home");
  paintMeta(home);
  const { rows } = await api("/api/grid");
  const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
  if (sessionStorage.getItem("grid-state")) saved.state = sessionStorage.getItem("grid-state");
  main.innerHTML = `
    <h1>Grilla del sprint</h1>
    <div class="toolbar">
      <label>Buscar <input id="q" value="${esc(saved.q || "")}" placeholder="ID o texto"/></label>
      <label>Estado <select id="f-state">${opts(["", ...new Set(rows.map((r) => r.state))], saved.state)}</select></label>
      <label>Dev <select id="f-owner">${opts(["", ...new Set(rows.map((r) => r.owner))], saved.owner)}</select></label>
      <label>SP <select id="f-sp">${opts(["", ...new Set(rows.map((r) => r.sp))], saved.sp)}</select></label>
      <label>PROD <select id="f-prod">${opts(["", "PROD", "no"], saved.prod)}</select></label>
      <button type="button" id="reset-f">Restablecer filtros</button>
    </div>
    <table>
      <thead><tr>
        <th>Historia</th><th>Pantalla</th><th>Prioridad</th><th>Contexto</th>
        <th>SP</th><th>BE</th><th>FE</th><th>Review</th><th>QA/UAT</th><th>Release/PROD</th><th>Responsable</th>
      </tr></thead>
      <tbody id="grid-body"></tbody>
    </table>
  `;
  const draw = () => {
    const f = {
      q: document.getElementById("q").value.toLowerCase(),
      state: document.getElementById("f-state").value,
      owner: document.getElementById("f-owner").value,
      sp: document.getElementById("f-sp").value,
      prod: document.getElementById("f-prod").value
    };
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    const filtered = rows.filter((r) => {
      if (f.q && !`${r.azureId} ${r.title}`.toLowerCase().includes(f.q)) return false;
      if (f.state && r.state !== f.state) return false;
      if (f.owner && r.owner !== f.owner) return false;
      if (f.sp && r.sp !== f.sp) return false;
      if (f.prod && r.prod !== f.prod) return false;
      return true;
    });
    document.getElementById("grid-body").innerHTML = filtered.map((r) => `
      <tr tabindex="0" data-id="${r.azureId}">
        <td>#${r.azureId} ${esc(r.title)}</td>
        <td>${esc(r.screen || r.module || "")}</td>
        <td>${r.priority}</td>
        <td>${esc(r.context)}</td>
        <td>${esc(r.sp)}</td>
        <td>${esc(r.be)}</td>
        <td>${esc(r.fe)}</td>
        <td>${esc(r.review)}</td>
        <td><span class="badge"><span class="dot"></span>${esc(r.stateLabel)}</span></td>
        <td>${esc(r.release)} / ${esc(r.prod)}</td>
        <td>${esc(r.owner)}</td>
      </tr>`).join("") || `<tr><td colspan="11">Sin filas. ${rows.length ? "Probá restablecer filtros." : "Vacío."}</td></tr>`;
    document.querySelectorAll("#grid-body tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", () => location.hash = `#/story/${tr.dataset.id}`);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = `#/story/${tr.dataset.id}`; });
    });
  };
  ["q", "f-state", "f-owner", "f-sp", "f-prod"].forEach((id) => document.getElementById(id).addEventListener("input", draw));
  document.getElementById("reset-f").addEventListener("click", () => {
    localStorage.removeItem(FILTER_KEY);
    sessionStorage.removeItem("grid-state");
    location.reload();
  });
  draw();
}

function opts(values, selected) {
  return values.map((v) => `<option ${v === selected ? "selected" : ""} value="${esc(v)}">${esc(v || "(todos)")}</option>`).join("");
}

async function renderStory(id) {
  const data = await api(`/api/story/${id}`);
  if (data.error) {
    main.innerHTML = `<section class="panel"><h1>Historia no encontrada</h1></section>`;
    return;
  }
  const s = data.story;
  const tabs = [
    ["resumen", "Resumen"],
    ["evidencia", "Evidencia"],
    ["analisis", "Análisis IA"],
    ["tecnico", "Contexto FE/BE"],
    ["contratos", "Contratos"],
    ["gaps", "Gaps"],
    ["deps", "Dependencias"],
    ["tareas", "Subtareas"],
    ["kit", "OpenSpec / kit"],
    ["prs", "PR / deploys"]
  ];
  main.innerHTML = `
    <p><a href="#/grid">← Grilla</a></p>
    <h1>#${s.azure_id} ${esc(s.title)}</h1>
    <p class="hint">${esc(s.screen || "")} · estado original ${esc(s.state_original)} → ${esc(s.state_normalized)} · rev ${s.source_revision}</p>
    <div class="tabs">${tabs.map((t, i) => `<button type="button" data-tab="${t[0]}" aria-selected="${i === 0}">${t[1]}</button>`).join("")}</div>
    <section id="tab-resumen" class="panel">${s.description_html || "<p>Sin descripción.</p>"}<h2>AC</h2><p>${esc(s.acceptance_criteria || "UNKNOWN")}</p><h2>Nota TL</h2><p>${esc(data.note?.note || "—")}</p></section>
    <section id="tab-evidencia" class="panel hidden">
      ${data.attachments.map((a) => `<p><img class="evidence" alt="${esc(a.file_name)}" src="/attachments/${a.id}"/></p>`).join("")}
      <ul>${data.evidence.map((e) => `<li><strong>${esc(e.classification)}</strong> ${esc(e.summary)} <span class="hint">${esc(e.source)} · ${esc(e.observed_at)}</span></li>`).join("")}</ul>
      <h3>Comentarios</h3>${data.comments.map((c) => `<article>${c.text_html}<p class="hint">${esc(c.author_name)} ${esc(c.created_at)}</p></article>`).join("") || "<p>Sin comentarios.</p>"}
    </section>
    <section id="tab-analisis" class="panel hidden">${data.analyses.map((a) => `<p>${esc(a.kind)} · ${esc(a.created_at)} · sha ${esc(a.base_sha || "n/a")} ${a.stale ? "· DESACTUALIZADO" : ""}</p>`).join("") || "<p>Sin análisis aún. Skill /analyze-story.</p>"}</section>
    <section id="tab-tecnico" class="panel hidden"><p>Repos y SHA en análisis. Archivos no verificados no se muestran como enlace.</p></section>
    <section id="tab-contratos" class="panel hidden"><pre>${esc(JSON.stringify(data.contracts, null, 2))}</pre></section>
    <section id="tab-gaps" class="panel hidden"><ul>${data.questions.map((q) => `<li>${q.blocking ? "BLOQUEA · " : ""}${esc(q.question)}</li>`).join("") || "<li>Sin preguntas</li>"}</ul></section>
    <section id="tab-deps" class="panel hidden"><pre>${esc(JSON.stringify(data.dependencies, null, 2))}</pre></section>
    <section id="tab-tareas" class="panel hidden"><p>Asignación sólo manual.</p><pre>${esc(JSON.stringify(data.drafts, null, 2))}</pre></section>
    <section id="tab-kit" class="panel hidden">
      <h2>Contextos</h2><ul>${data.packages.map((p) => `<li>v${p.context_version} ${p.stale ? "stale" : ""} ${esc(p.context_hash)}</li>`).join("") || "<li>N/A</li>"}</ul>
      <h2>Resultados kit</h2><ul>${data.results.map((r) => `<li>${esc(r.origin)} rev ${r.revision} · última evidencia reportada (no implica PROD)</li>`).join("") || "<li>N/A</li>"}</ul>
    </section>
    <section id="tab-prs" class="panel hidden">
      <p>Release: ${data.release.inPackage ? "en paquete" : "sin paquete"}. PROD: ${data.release.production ? "sí" : "no"}.</p>
      <p>Último deploy: ${esc(JSON.stringify(data.release.lastDeploy))}</p>
    </section>
  `;
  main.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      main.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      tabs.forEach((t) => document.getElementById(`tab-${t[0]}`).classList.toggle("hidden", t[0] !== btn.dataset.tab));
    });
  });
}

async function renderSp() {
  const data = await api("/api/sp");
  main.innerHTML = `
    <h1>Dependencias SP</h1>
    <p class="hint">Aging en ${data.agingUnit}, zona ${data.timezone}. Contrato confirmado ≠ disponible en ambiente.</p>
    <table><thead><tr><th>Historia</th><th>SP</th><th>Estado</th><th>Aging</th><th>Equipo</th></tr></thead>
    <tbody>${data.items.map((i) => `<tr data-id="${i.story?.azure_id || ""}">
      <td>#${i.story?.azure_id ?? ""} ${esc(i.story?.title || "")}</td>
      <td>${esc(i.name)}</td><td>${esc(i.lifecycle || i.status)}</td>
      <td>${i.agingDays} días corridos</td><td>${esc(i.responsible_team || "")}</td>
    </tr>`).join("")}</tbody></table>`;
  main.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.id) location.hash = `#/story/${tr.dataset.id}`; }));
}

async function renderTeam() {
  const data = await api("/api/team");
  main.innerHTML = `<h1>Equipo (composición configurable)</h1>
    <p class="hint">No hay ranking de productividad. WIP = tareas DOING/REVIEW.</p>
    <section class="cards">${data.members.map((m) => `<article class="card"><h2>${esc(m.displayName)} · ${esc(m.role)}</h2><p class="value">${m.wip}</p><p>WIP</p><ul>${m.tasks.map((t) => `<li>#${t.azure_id} ${esc(t.title)} (${t.state_normalized})</li>`).join("")}</ul></article>`).join("")}</section>
    <h2>Sin asignar</h2>
    <ul>${data.unassigned.map((t) => `<li>#${t.azure_id} ${esc(t.title)}</li>`).join("") || "<li>Nada</li>"}</ul>`;
}

async function renderReleases() {
  const data = await api("/api/releases");
  main.innerHTML = `<h1>Releases</h1>
    ${data.releases.map((r) => `<section class="panel">
      <h2>${esc(r.name)}</h2>
      <p>${esc(r.notes || "")}</p>
      <h3>Componentes</h3>
      <ul>${r.components.map((c) => `<li>${esc(c.component)} ${esc(c.version)} sha ${esc(c.sha || "")} build ${esc(c.buildId || "")}</li>`).join("")}</ul>
      <h3>Work items y pantallas</h3>
      <ul>${r.workItems.map((w) => `<li><a href="#/story/${(w.id || "").split("/").pop()}">${esc(w.title || w.id)}</a> · ${esc(w.screens || "")}</li>`).join("")}</ul>
      <h3>Deployments</h3>
      <ul>${r.deployments.map((d) => `<li>${esc(d.at)} ${esc(d.environment)} ${esc(d.status)} fuente ${esc(d.source)}${d.source === "MANUAL_CONFIRMED" ? " (no es verificación automática)" : ""}</li>`).join("")}</ul>
    </section>`).join("")}`;
}

async function renderSecurity() {
  const data = await api("/api/security");
  main.innerHTML = `<h1>Seguridad</h1>
    <p>${esc(data.note)}</p>
    <p>Gate vigente: ${esc(data.currentGate?.gate_status || "NOT_AVAILABLE")} (${esc(data.currentGate?.id || "—")})</p>
    <h2>Reportes</h2>
    <ul>${data.reports.map((r) => `<li>${esc(r.id)} ${esc(r.gate_status)} gate=${r.current_gate ? "vigente" : "histórico"} ${esc(r.checked_at || "")}</li>`).join("")}</ul>
    <h2>Findings</h2>
    <ul>${data.findings.map((f) => `<li>${esc(f.severity)} ${esc(f.status)} ${esc(f.title)} ${esc(f.path || "")}</li>`).join("")}</ul>`;
}

async function renderHistory() {
  const data = await api("/api/history");
  main.innerHTML = `<h1>Historial</h1>
    <h2>Snapshots</h2>
    <ul>${data.snapshots.map((s) => `<li>${esc(s.captured_at)} ${esc(s.kind)} ${s.closed ? "cerrado" : ""} ${esc(s.report_path || "")}</li>`).join("") || "<li>Sin historial suficiente</li>"}</ul>
    <h2>Sync</h2>
    <ul>${data.syncRuns.map((s) => `<li>${esc(s.started_at)} ${esc(s.status)} ${esc(s.error || "")}</li>`).join("")}</ul>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
