const main = document.getElementById("main");
const statusBar = document.getElementById("status-bar");
const FILTER_KEY = "tl-control.filters";
let knownSyncAt;

const routes = {
  home: renderHome,
  seguimiento: renderSeguimiento,
  card: renderCard,
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
document.getElementById("refresh-btn").addEventListener("click", syncNow);
setInterval(() => { void watchAutoSync(); }, 60_000);
document.getElementById("modal-close").addEventListener("click", () => document.getElementById("modal").classList.add("hidden"));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    document.getElementById("q")?.focus();
  }
  if (e.key === "Escape") document.getElementById("modal").classList.add("hidden");
});
if (localStorage.getItem("tl-theme") === "dark") document.documentElement.dataset.theme = "dark";
paintThemeButton();
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

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

function status(kind, text) {
  statusBar.className = `status ${kind}`;
  statusBar.textContent = text;
}

function moonIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>`;
}

function sunIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
}

function paintThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  const btn = document.getElementById("theme-btn");
  btn.setAttribute("aria-pressed", String(dark));
  btn.setAttribute("aria-label", dark ? "Cambiar a tema claro" : "Cambiar a tema oscuro");
  btn.title = dark ? "Tema claro" : "Tema oscuro";
  btn.innerHTML = dark ? sunIconSvg() : moonIconSvg();
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "" : "dark";
  localStorage.setItem("tl-theme", dark ? "light" : "dark");
  paintThemeButton();
}

async function syncNow() {
  const btn = document.getElementById("refresh-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Sincronizando…";
  status("ok", "Sincronizando con Azure…");
  try {
    let body = await postSync();
    if (body.busy) {
      status("ok", "Ya hay una sincronización en curso. Esperando a que termine…");
      body = await waitForSync();
    }
    if (body.finishedAt) knownSyncAt = body.finishedAt;
    if (!body.ok) throw new Error(body.error || "La sincronización falló");
    await boot();
  } catch (err) {
    status("error", `No se pudo actualizar: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sincronizar";
  }
}

async function postSync() {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "x-tl-control": "local", "Content-Type": "application/json" },
    body: "{}"
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(body.error || `${res.status} /api/sync`);
  return body;
}

async function waitForSync() {
  for (let i = 0; i < 150; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const state = await api("/api/sync");
    if (!state.running) {
      return {
        ok: state.last?.ok === true,
        error: state.last?.error,
        finishedAt: state.last?.finishedAt
      };
    }
  }
  throw new Error("La sincronización sigue en curso. Recargá en unos minutos.");
}

async function watchAutoSync() {
  const btn = document.getElementById("refresh-btn");
  if (btn?.disabled) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  try {
    const state = await api("/api/sync");
    const finished = state.last?.finishedAt ?? null;
    if (!finished || finished === knownSyncAt) return;
    knownSyncAt = finished;
    if (!state.last?.ok) {
      status("error", `Sync automático: ${state.last?.error || "falló"}`);
      return;
    }
    await boot();
  } catch {
    /* el servidor puede estar cerrándose */
  }
}

async function renderHome() {
  const data = await api("/api/home");
  paintMeta(data);
  main.innerHTML = `
    <h1>Control del día</h1>
    <p class="hint">${esc(data.iteration)} · zona ${esc(data.timezone)} · aging ${esc(data.agingUnit)}. Cada tarjeta cuenta la historia principal o la tarea sin padre. Tocá una para ver cuáles son.</p>
    <div class="toolbar">
      <button type="button" id="daily-report" class="primary">Informe de daily</button>
    </div>
    <section class="cards">${data.cards.map(cardHtml).join("")}</section>
    <section class="panel sql-gaps">
      <h2>Falta definición SQL</h2>
      <p class="hint">No es el estado Bloqueado. Analyze SP abre Cursor con el id para cargar el contrato, reanalizar historia/tareas (por si lo subieron ahí) o marcar que no hace falta. La traza y el PDF están en <a href="#/sp">SP</a>.</p>
      ${data.sqlGaps?.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Ítem</th><th>Pantalla</th><th>SP</th><th>Pedido</th><th></th><th>Texto</th></tr></thead>
        <tbody>${data.sqlGaps.map((gap, index) => `
          <tr>
            <td class="item"><a href="#/story/${gap.azureId}">#${gap.azureId} ${esc(gap.title)}</a></td>
            <td>${esc(gap.screen || "—")}</td>
            <td>${esc(gap.spName || "Nuevo")}</td>
            <td>${esc(sqlChangeLabel(gap))}</td>
            <td class="sql-actions">
              ${cmdSkillButton("analyze-sp", gap.azureId)}
              <button type="button" class="sql-dismiss" data-sql-dismiss="${gap.azureId}">No hace falta</button>
            </td>
            <td class="sql-copy">
              <button type="button" class="cmd-copy" data-sql-copy="${index}" title="Copiar texto">${copyIconSvg()}<span class="sr">Copiar</span></button>
              <p>${esc(gap.copyText)}</p>
            </td>
          </tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty">Ninguna historia analizada está frenada por definición SQL.</div>`}
    </section>
    <section class="panel func-questions">
      <h2>Faltan definiciones funcionales</h2>
      <p class="hint">Preguntas que salieron del análisis. El texto se copia para pegarlo en la historia, o se publica como comentario. Siguen acá hasta marcarlas respondidas, o hasta que alguien responda en Azure después de publicarlas.</p>
      ${data.functionalQuestions?.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Ítem</th><th>Preguntas</th></tr></thead>
        <tbody>${data.functionalQuestions.map((group, index) => `
          <tr>
            <td class="item"><a href="#/story/${group.targetAzureId}">#${group.azureId} ${esc(group.title)}</a></td>
            <td class="sql-copy func-copy">
              <button type="button" class="cmd-copy" data-func-copy="${index}" title="Copiar preguntas">${copyIconSvg()}<span class="sr">Copiar</span></button>
              <div>
                <p>${esc(group.copyText)}</p>
                <div class="func-actions">
                  ${group.postedAt
                    ? `<span class="hint">Ya está en la historia</span>`
                    : `<button type="button" data-func-post="${esc(group.workItemId)}" data-func-target="${group.targetAzureId}">En la historia</button>`}
                </div>
                <ul>${group.questions.map((question) => `
                  <li>${esc(question.question)} <button type="button" data-func-answer="${esc(question.id)}">Respondida</button></li>
                `).join("")}</ul>
              </div>
            </td>
          </tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty">Ninguna historia analizada tiene preguntas funcionales pendientes.</div>`}
    </section>
    <section class="grid-2 chart-row">
      <article class="panel chart-card">
        <h2>Distribución por estado</h2>
        <p class="hint">Click en un segmento o barra filtra la grilla.</p>
        <div id="chart-states-donut" class="chart"></div>
        <div id="chart-states-bars" class="chart chart-bars"></div>
      </article>
      <article class="panel chart-card">
        <h2>Scope del sprint</h2>
        <p class="scope-formula">${data.charts.scope.initial} + ${data.charts.scope.added} − ${data.charts.scope.removed} = <strong>${data.charts.scope.current}</strong> ${data.charts.scope.unit}</p>
        <div id="chart-scope" class="chart"></div>
        <p class="hint">${esc(data.charts.scope.formula)} · Cobertura: ${data.charts.scope.coverage} · Neto: ${data.charts.scope.netGrowth === null ? "N/A" : (data.charts.scope.netGrowth * 100).toFixed(1) + "%"}</p>
        <p class="hint">Carry-over: ${data.charts.scope.carryOver} · PROD confirmada: ${data.metrics.production}</p>
      </article>
    </section>
    <section class="panel attention">
      <h2>Requiere atención</h2>
      ${data.alerts.length ? data.alerts.map((a) => `
        <article class="card alert">
          <p class="badge"><span class="dot ${a.severity === "alta" ? "bad" : "warn"}"></span>${esc(a.severity)} · ${esc(a.ruleId)}</p>
          <h3><a href="${a.workItemId ? `#/story/${a.workItemId.split("/").pop()}` : "#/grid"}">${esc(a.title)}</a></h3>
          <p>${esc(a.explanation)}</p>
        </article>`).join("") : `<div class="empty">Sin alertas del sprint actual.</div>`}
    </section>
  `;
  wireDaily(data);
}

async function renderSeguimiento() {
  const data = await api("/api/home");
  paintMeta(data);
  main.innerHTML = `
    <h1>Seguimiento</h1>
    <p class="hint">Cada tarjeta queda asociada a una tarea. Si esa tarea está Active / In Progress en Azure, pasa sola a In progress. Evidencia y Terminando las movés vos.</p>
    ${boardHtml(data.board)}
  `;
  wireBoard(data.board);
}

function wireDaily(data) {
  const states = data.charts.states.map((s) => ({ ...s, hint: "unidad: ítems del sprint" }));
  const goGrid = (key) => {
    location.hash = `#/grid`;
    sessionStorage.setItem("grid-state", key);
  };
  donutChart(document.getElementById("chart-states-donut"), states, goGrid);
  hBarChart(document.getElementById("chart-states-bars"), states, goGrid);
  const scope = data.charts.scope;
  stackChart(document.getElementById("chart-scope"), [
    { label: "Inicial", value: scope.initial, color: "var(--accent)" },
    { label: "Agregado", value: scope.added, color: "var(--ok)" },
    { label: "Removido", value: scope.removed, color: "var(--bad)" }
  ]);
  document.getElementById("daily-report")?.addEventListener("click", () => {
    window.open("/api/daily-report", "_blank");
  });
  main.querySelectorAll("[data-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = `#/card/${btn.dataset.card}`;
    });
  });
  wireCmdCopyButtons(main);
  main.querySelectorAll("[data-sql-dismiss]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const azureId = btn.dataset.sqlDismiss;
      if (!azureId) {
        status("error", "No pude leer el id de la tarea.");
        return;
      }
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      btn.disabled = true;
      const previous = btn.textContent;
      btn.textContent = "Sacando…";
      try {
        await postLocal("/api/sql-gaps/dismiss", { azureId });
        status("ok", `#${azureId} ya no figura como falta de contrato SP`);
        await renderHome();
      } catch (error) {
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = previous;
        status("error", error instanceof Error ? error.message : "No se pudo sacar el faltante.");
      }
    });
  });
  main.querySelectorAll("[data-sql-copy]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const gap = data.sqlGaps[Number(btn.dataset.sqlCopy)];
      if (!gap) return;
      try {
        await navigator.clipboard.writeText(gap.copyText);
        status("ok", `Copiado el pedido de #${gap.azureId}`);
      } catch {
        status("error", "No se pudo copiar. Permití acceso al portapapeles.");
      }
    });
  });
  main.querySelectorAll("[data-func-copy]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const group = data.functionalQuestions[Number(btn.dataset.funcCopy)];
      if (!group) return;
      try {
        await navigator.clipboard.writeText(group.copyText);
        status("ok", `Copiadas las preguntas de #${group.azureId}`);
      } catch {
        status("error", "No se pudo copiar. Permití acceso al portapapeles.");
      }
    });
  });
  main.querySelectorAll("[data-func-post]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const target = btn.dataset.funcTarget;
      if (!window.confirm(`Se publica el comentario con las preguntas en #${target}.`)) return;
      btn.disabled = true;
      try {
        await apiPost("/api/questions/post", { workItemId: btn.dataset.funcPost });
        status("ok", `Preguntas publicadas en #${target}`);
        await renderHome();
      } catch (error) {
        btn.disabled = false;
        status("error", error instanceof Error ? error.message : "No se pudo publicar.");
      }
    });
  });
  main.querySelectorAll("[data-func-answer]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      try {
        await apiPost("/api/questions/answer", { id: btn.dataset.funcAnswer });
        status("ok", "Pregunta marcada como respondida");
        await renderHome();
      } catch (error) {
        btn.disabled = false;
        status("error", error instanceof Error ? error.message : "No se pudo marcar.");
      }
    });
  });
}

function sqlChangeLabel(gap) {
  if (gap.change === "NEW") return "Nuevo";
  if (gap.change === "ADD") return "Alta";
  if (gap.usage === "alta") return "Update alta";
  return "Update consulta";
}

async function renderCard(key) {
  const data = await api("/api/home");
  paintMeta(data);
  const card = data.cards.find((item) => item.key === key);
  if (!card) {
    location.hash = "#/home";
    return;
  }
  const note = key === "devtasks"
    ? "Tareas que creaste vos para el equipo. Si el padre está bloqueado, la tarea igual aparece acá."
    : key === "priority1"
      ? "Historias y tareas sueltas con prioridad 1. No incluye subtareas."
      : "Historia principal o tarea sin padre. No incluye subtareas.";
  main.innerHTML = `
    <p><a href="#/home">← Inicio</a></p>
    <h1>${esc(card.label)}</h1>
    <p class="hint">${card.value} ítems. ${esc(note)}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tipo</th><th>Ítem</th><th>Estado</th><th>Padre</th><th>Responsable</th></tr></thead>
        <tbody>
          ${card.items.length ? card.items.map((item) => `
            <tr>
              <td>${pillType(item.type)}</td>
              <td class="item"><a href="#/story/${item.azureId}">#${item.azureId} ${esc(item.title)}</a></td>
              <td>${pillState(item.state, item.stateLabel)}</td>
              <td>${item.parentAzureId ? `<a href="#/story/${item.parentAzureId}">#${item.parentAzureId} ${esc(item.parentTitle || "")}</a>${item.parentBlocked ? " · padre bloqueado" : ""}` : "—"}</td>
              <td>${esc(item.assignee || "sin asignar")}</td>
            </tr>`).join("") : `<tr><td colspan="5"><div class="empty">Esta tarjeta no tiene ítems.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function cardHtml(c) {
  return `<button type="button" class="card tone-${esc(c.tone || "accent")}" data-card="${esc(c.key)}"><h2>${esc(c.label)}</h2><p class="value">${c.value}</p></button>`;
}

function boardHtml(board) {
  if (!board?.columns?.length) return "";
  const byCol = Object.fromEntries(board.columns.map((col) => [col.id, []]));
  for (const member of board.members) {
    (byCol[member.columnId] || byCol.inicio).push(member);
  }
  return `<section class="panel kanban-wrap" id="kanban-wrap">
    <h2>Tablero del equipo</h2>
    <p class="hint">La tarjeta se ata a la tarea que elijas. In progress sigue a Azure (Active / In Progress). Evidencia y Terminando las arrastrás vos.</p>
    <div class="kanban">${board.columns.map((col) => `
      <div class="kanban-col" data-column="${esc(col.id)}">
        <header class="kanban-col-head">
          <h3>${esc(col.label)}</h3>
          <span class="kanban-count">${byCol[col.id].length}</span>
        </header>
        <div class="kanban-list">${byCol[col.id].length ? byCol[col.id].map(boardCardHtml).join("") : `<p class="kanban-empty">Vacío</p>`}</div>
      </div>`).join("")}</div>
  </section>`;
}

function boardCardHtml(member) {
  const task = member.active;
  const selected = member.workItemId || task?.id || "";
  const started = member.startedAt ? `Arrancó ${formatWhen(member.startedAt)}` : "Todavía no arrancó";
  return `<article class="kanban-card" draggable="true" data-member="${esc(member.id)}">
    <div class="member-head">
      <div class="avatar">${esc(initials(member.shortName || member.displayName))}</div>
      <div>
        <h3>${esc(member.shortName || member.displayName)}</h3>
        <p class="hint">${esc(member.role)}${member.wip ? ` · WIP ${member.wip}` : ""}</p>
      </div>
    </div>
    ${task
      ? `<p class="kanban-task"><a href="#/story/${task.azureId}">#${task.azureId} ${esc(task.title)}</a> ${pillState(task.state, task.stateLabel)}</p>`
      : `<p class="hint">Sin tarea activa en Azure</p>`}
    <label class="kanban-field">Tarea asociada
      <select data-board-task>
        <option value="">Sin asociar</option>
        ${member.assigned.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? "selected" : ""}>#${item.azureId} ${esc(item.title)}</option>`).join("")}
      </select>
    </label>
    <label class="kanban-field">Nota de arranque
      <textarea data-board-note rows="2" maxlength="400" placeholder="Qué arrancó, bloqueo, con quién habla…">${esc(member.note)}</textarea>
    </label>
    <p class="hint">${esc(started)}</p>
    <div class="kanban-actions">
      ${member.columnId === "inicio" || !member.startedAt ? `<button type="button" class="primary" data-board-start>Arrancar</button>` : ""}
      <button type="button" data-board-save>Guardar</button>
    </div>
  </article>`;
}

function boardCardPayload(card) {
  return {
    memberId: card.dataset.member,
    workItemId: card.querySelector("[data-board-task]")?.value || null,
    note: card.querySelector("[data-board-note]")?.value || ""
  };
}

function paintKanban(board) {
  const wrap = document.getElementById("kanban-wrap");
  if (!wrap) return;
  wrap.outerHTML = boardHtml(board);
  wireBoard(board);
}

async function saveBoard(body) {
  try {
    const result = await postLocal("/api/board", body);
    status("ok", body.start ? "Arrancó. Quedó en In progress." : "Tablero actualizado.");
    paintKanban(result.board);
  } catch (err) {
    status("error", err.message);
  }
}

function wireBoard(board) {
  const wrap = document.getElementById("kanban-wrap");
  if (!wrap || !board) return;
  wrap.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      if (event.target.closest("textarea, select, button, a, label")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", card.dataset.member);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  wrap.querySelectorAll(".kanban-col").forEach((col) => {
    col.addEventListener("dragover", (event) => {
      event.preventDefault();
      col.classList.add("drop");
    });
    col.addEventListener("dragleave", (event) => {
      if (!col.contains(event.relatedTarget)) col.classList.remove("drop");
    });
    col.addEventListener("drop", (event) => {
      event.preventDefault();
      col.classList.remove("drop");
      const memberId = event.dataTransfer.getData("text/plain");
      if (!memberId) return;
      void saveBoard({ memberId, columnId: col.dataset.column });
    });
  });
  wrap.querySelectorAll("[data-board-save]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void saveBoard(boardCardPayload(btn.closest(".kanban-card")));
    });
  });
  wrap.querySelectorAll("[data-board-task]").forEach((sel) => {
    sel.addEventListener("change", () => {
      void saveBoard(boardCardPayload(sel.closest(".kanban-card")));
    });
  });
  wrap.querySelectorAll("[data-board-start]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void saveBoard({ ...boardCardPayload(btn.closest(".kanban-card")), start: true });
    });
  });
}

function paintMeta(data) {
  const dates = data.dates ? `${data.dates.name ?? ""} ${data.dates.start_date ?? ""} → ${data.dates.finish_date ?? ""}` : data.iteration;
  const sync = data.lastSync;
  const cov = sync?.coverage_json ? JSON.parse(sync.coverage_json) : {};
  document.getElementById("sprint-meta").textContent = `${dates} · sync ${formatWhen(sync?.finished_at)} · ${sync?.status ?? ""}`;
  if (knownSyncAt === undefined) knownSyncAt = sync?.finished_at ?? null;
  if (data.demo) status("demo", `${data.demoWarning || "Modo demo"} · cobertura PR=${cov.pullRequests || "?"} deploy=${cov.deployments || "?"}`);
  else if (data.hasPat === false) status("error", "Sin PAT en este proceso. Sincronizar no puede hablar con Azure. Definí AZURE_DEVOPS_EXT_PAT o un .env local y reiniciá el dashboard.");
  else if (!sync) status("offline", "Sin sincronización. El dashboard muestra el último snapshot local.");
  else status("ok", `Azure NCSLite · última sync ${formatWhen(sync.finished_at)}. PR/deploys no se sincronizan aún.`);
}

function formatWhen(iso) {
  if (!iso) return "nunca";
  try {
    return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function typeLabel(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("bug")) return "Bug";
  if (t === "task" || t.includes("tarea")) return "Tarea";
  if (t.includes("backlog") || t.includes("user story") || t.includes("historia") || t === "story") return "Historia";
  return type || "Ítem";
}

function pillType(type) {
  const key = String(type || "").toLowerCase().includes("bug") ? "bug"
    : String(type || "").toLowerCase() === "task" || String(type || "").toLowerCase().includes("tarea") ? "task" : "story";
  return `<span class="pill type-${key}">${esc(typeLabel(type))}</span>`;
}

function pillState(state, label) {
  return `<span class="pill st-${esc(state)}">${esc(label || state)}</span>`;
}

function copyIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function playIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
}

function checkIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
}

function skillCommand(kind, azureId) {
  if (kind === "analyze-sp") {
    return `/analyze-sp ${azureId}\n\nRevisá #${azureId}. Sincronizá si hace falta y mirá la historia y las subtareas: puede que hayan subido el contrato ahí. Si te paso el contrato, cargalo (sin inventar firma). Si al final no hace falta SP, sacalo de Falta definición SQL.`;
  }
  return kind === "analyze" ? `/analyze-story ${azureId}` : `/prepare-story ${azureId}`;
}

function skillLabel(kind) {
  if (kind === "analyze-sp") return "Analyze SP";
  return kind === "analyze" ? "Analyze" : "Prepare";
}

function cursorPromptHref(text) {
  return `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(text)}`;
}

function skillTimesFromStory(data) {
  const analyzed = (data.analyses || []).find((a) => a.kind === "functional");
  const sp = (data.analyses || []).find((a) => a.kind === "sp");
  const prepared = data.packages?.[0];
  const spOpen = (data.contracts || []).some((c) => c.kind === "SP" && !["CONFIRMED", "CONTRACT_CONFIRMED", "AVAILABLE", "VALIDATED", "NOT_APPLICABLE"].includes(c.status));
  return {
    analyzedAt: analyzed?.created_at || null,
    preparedAt: prepared?.created_at || null,
    spAnalyzedAt: sp?.created_at || null,
    spNeeded: spOpen
  };
}

function cmdSkillButton(kind, azureId, doneAt) {
  const text = skillCommand(kind, azureId);
  const done = Boolean(doneAt);
  const when = done ? formatWhen(doneAt) : "";
  const title = done
    ? `${skillLabel(kind)} ya está hecho (${when}). Clic para regenerar. Shift: solo copiar`
    : `Ejecutar ${text} en Cursor (Shift: solo copiar)`;
  return `<a class="cmd-copy ${kind}${done ? " done" : ""}" data-cmd="${kind}" data-id="${azureId}" data-done="${done ? "1" : "0"}" data-done-at="${esc(doneAt || "")}" href="${cursorPromptHref(text)}" title="${esc(title)}">${done ? checkIconSvg() : playIconSvg()}<span class="sr">${done ? `${skillLabel(kind)} hecho` : skillLabel(kind)}</span></a>`;
}

function cmdCopyButtons(azureId, times = {}) {
  return `<span class="cmd-actions" role="group" aria-label="Ejecutar skills en Cursor">
    ${cmdSkillButton("analyze", azureId, times.analyzedAt)}
    ${cmdSkillButton("prepare", azureId, times.preparedAt)}
    ${times.spNeeded ? cmdSkillButton("analyze-sp", azureId, times.spAnalyzedAt) : ""}
  </span>`;
}

function skillStatusBanner(times) {
  const parts = [];
  if (times.analyzedAt) {
    parts.push(`<p><strong>Analyze ya está hecho</strong> (${esc(formatWhen(times.analyzedAt))}). No hace falta correrlo de nuevo salvo que haya cambiado el pedido.</p>`);
  }
  if (times.preparedAt) {
    parts.push(`<p><strong>Prepare ya está hecho</strong> (${esc(formatWhen(times.preparedAt))}). Regenerar crea otra versión del paquete.</p>`);
  }
  if (!parts.length) return "";
  return `<aside class="skill-banner" role="status">${parts.join("")}<p class="hint">Si igual querés regenerar, tocá el tilde y confirmá.</p></aside>`;
}

async function copySkillCommand(kind, azureId) {
  const text = skillCommand(kind, azureId);
  try {
    await navigator.clipboard.writeText(text);
    status("ok", `Copiado: ${text}`);
  } catch {
    status("error", "No se pudo copiar. Permití acceso al portapapeles.");
  }
}

function wireCmdCopyButtons(root) {
  root.querySelectorAll(".cmd-copy[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = skillCommand(btn.dataset.cmd, btn.dataset.id);
      if (e.shiftKey || e.altKey) {
        e.preventDefault();
        copySkillCommand(btn.dataset.cmd, btn.dataset.id);
        return;
      }
      if (btn.dataset.done === "1") {
        const when = formatWhen(btn.dataset.doneAt);
        const ok = window.confirm(`${skillLabel(btn.dataset.cmd)} ya está hecho (${when}).\n\n¿Volver a generarlo?`);
        if (!ok) {
          e.preventDefault();
          return;
        }
      }
      void navigator.clipboard.writeText(text).catch(() => {});
      status("ok", `En Cursor: ${text}. Confirmá con Enter en el chat.`);
    });
  });
}

async function renderGrid() {
  const home = await api("/api/home");
  paintMeta(home);
  const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
  if (sessionStorage.getItem("grid-state")) saved.state = sessionStorage.getItem("grid-state");
  const teamOnly = saved.team !== false;
  const { rows } = await api(`/api/grid${teamOnly ? "" : "?scope=all"}`);
  main.innerHTML = `
    <h1>Grilla del sprint</h1>
    <p class="hint">Orden: bugs → historias/PBI → tareas sueltas. Las hijas quedan debajo de su padre. No se muestran ítems bloqueados ni hijas de una historia bloqueada. ${teamOnly ? "Solo ítems de tu equipo (config)." : "Mostrando todo el sprint."} <strong>Pendientes de generar</strong> = subtareas IA sin asignar, por aprobar o sin publicar en Azure.</p>
    <div class="toolbar">
      <label class="check"><input type="checkbox" id="f-team" ${teamOnly ? "checked" : ""}/> Solo equipo</label>
      <label>Buscar <input id="q" value="${esc(saved.q || "")}" placeholder="ID o texto"/></label>
      <label>Tipo <select id="f-type">${opts(["", ...new Set(rows.map((r) => r.type))], saved.type, typeLabel)}</select></label>
      <label>Estado <select id="f-state">${opts(["", ...new Set(rows.map((r) => r.state))], saved.state)}</select></label>
      <label>Dev <select id="f-owner">${opts(["", ...new Set(rows.map((r) => r.owner))], saved.owner)}</select></label>
      <label>SP <select id="f-sp">${opts(["", ...new Set(rows.map((r) => r.sp))], saved.sp)}</select></label>
      <label>PROD <select id="f-prod">${opts(["", "PROD", "no"], saved.prod)}</select></label>
      <label>Borradores <select id="f-drafts">${opts(["", "pending", "assign", "publish"], saved.drafts, draftFilterLabel)}</select></label>
      <button type="button" id="reset-f">Restablecer filtros</button>
    </div>
    <div class="table-wrap page-flow">
    <table>
      <thead><tr>
        <th>Tipo</th><th>Ítem</th><th>Estado</th><th>Prioridad</th><th>Responsable</th>
        <th>Hijos</th><th>SP</th><th>Release/PROD</th><th>IA</th>
      </tr></thead>
      <tbody id="grid-body"></tbody>
    </table>
    </div>
  `;
  const groupTitle = { bugs: "Bugs", stories: "Historias", loose: "Tareas sueltas" };
  const draw = () => {
    const f = {
      q: document.getElementById("q").value.toLowerCase(),
      type: document.getElementById("f-type").value,
      state: document.getElementById("f-state").value,
      owner: document.getElementById("f-owner").value,
      sp: document.getElementById("f-sp").value,
      prod: document.getElementById("f-prod").value,
      drafts: document.getElementById("f-drafts").value,
      team: document.getElementById("f-team").checked
    };
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    const matched = rows.filter((r) => {
      if (f.q && !`${r.azureId} ${r.title}`.toLowerCase().includes(f.q)) return false;
      if (f.type && r.type !== f.type) return false;
      if (f.state && r.state !== f.state) return false;
      if (f.owner && r.owner !== f.owner) return false;
      if (f.sp && r.sp !== f.sp) return false;
      if (f.prod && r.prod !== f.prod) return false;
      if (f.drafts && !matchesDraftFilter(r, f.drafts)) return false;
      return true;
    });
    const keep = new Set(matched.map((r) => r.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of matched) {
      let pid = r.parentId;
      while (pid && byId.has(pid)) {
        keep.add(pid);
        pid = byId.get(pid).parentId;
      }
    }
    if (f.drafts) {
      for (const r of rows) {
        if (r.parentId && keep.has(r.parentId)) keep.add(r.id);
      }
    }
    const filtered = rows.filter((r) => keep.has(r.id));
    let lastGroup = "";
    const html = [];
    for (const r of filtered) {
      if (!r.depth && r.group && r.group !== lastGroup) {
        lastGroup = r.group;
        html.push(`<tr class="section"><td colspan="9">${groupTitle[r.group] || r.group}</td></tr>`);
      }
      html.push(`
      <tr tabindex="0" data-id="${r.azureId}" class="${r.depth ? "child" : "parent"}">
        <td>${pillType(r.type)}</td>
        <td class="item"><span class="tree" style="padding-left:${(r.depth || 0) * 22}px">${r.depth ? "<span class='branch'>└</span>" : ""}#${r.azureId} ${esc(r.title)}</span></td>
        <td>${pillState(r.state, r.stateLabel)}</td>
        <td>${r.priority ?? ""}</td>
        <td>${esc(r.owner)}</td>
        <td>${r.depth ? "—" : (r.children || "—")}</td>
        <td>${esc(r.sp)}</td>
        <td>${esc(r.release)} / ${esc(r.prod)}</td>
        <td class="actions">${!r.depth ? `${draftQueueBadge(r)}${cmdCopyButtons(r.azureId, { analyzedAt: r.analyzedAt, preparedAt: r.preparedAt })}` : ""}</td>
      </tr>`);
    }
    document.getElementById("grid-body").innerHTML = html.join("") || `<tr><td colspan="9"><div class="empty">${rows.length ? "Sin filas. Probá restablecer filtros o desmarcar Solo equipo." : "Vacío. Corré sync y recargá."}</div></td></tr>`;
    document.querySelectorAll("#grid-body tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".cmd-copy, .cmd-actions")) return;
        location.hash = `#/story/${tr.dataset.id}`;
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.target.closest(".cmd-copy, .cmd-actions")) location.hash = `#/story/${tr.dataset.id}`;
      });
    });
    wireCmdCopyButtons(document.getElementById("grid-body"));
  };
  document.getElementById("f-team").addEventListener("change", () => {
    const cur = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
    cur.team = document.getElementById("f-team").checked;
    localStorage.setItem(FILTER_KEY, JSON.stringify(cur));
    renderGrid();
  });
  ["q", "f-type", "f-state", "f-owner", "f-sp", "f-prod", "f-drafts"].forEach((id) => document.getElementById(id).addEventListener("input", draw));
  document.getElementById("reset-f").addEventListener("click", () => {
    localStorage.removeItem(FILTER_KEY);
    sessionStorage.removeItem("grid-state");
    location.reload();
  });
  draw();
}

function opts(values, selected, labelFn) {
  return values.map((v) => `<option ${v === selected ? "selected" : ""} value="${esc(v)}">${esc(v ? (labelFn ? labelFn(v) : v) : "(todos)")}</option>`).join("");
}

function draftFilterLabel(value) {
  if (value === "pending") return "Pendientes de generar";
  if (value === "assign") return "Falta asignar";
  if (value === "publish") return "Falta publicar";
  return value;
}

function matchesDraftFilter(row, value) {
  if (value === "assign") return Number(row.draftsNeedAssign) > 0;
  if (value === "publish") return Number(row.draftsNeedPublish) > 0;
  if (value === "pending") return Number(row.draftsPending) > 0;
  return true;
}

function draftQueueBadge(row) {
  const assign = Number(row.draftsNeedAssign) || 0;
  const publish = Number(row.draftsNeedPublish) || 0;
  const pending = Number(row.draftsPending) || 0;
  if (!pending) return "";
  const parts = [];
  if (assign) parts.push(`${assign} sin asignar`);
  if (publish) parts.push(`${publish} por publicar`);
  const review = pending - assign - publish;
  if (review > 0) parts.push(`${review} por aprobar`);
  return `<span class="pill st-OTHER draft-queue" title="Subtareas IA pendientes">${esc(parts.join(" · "))}</span>`;
}

async function renderStory(id) {
  const data = await api(`/api/story/${id}`);
  if (data.error) {
    main.innerHTML = `<section class="panel"><h1>Historia no encontrada</h1></section>`;
    return;
  }
  const s = data.story;
  const pkg = data.packages?.[0]?.payload || null;
  const times = skillTimesFromStory(data);
  const tabs = [
    ["resumen", "Resumen"],
    ["tareas", "Subtareas"],
    ["paquete", "Paquete"],
    ["evidencia", "Evidencia"],
    ["analisis", "Análisis IA"],
    ["tecnico", "Contexto FE/BE"],
    ["contratos", "Contratos"],
    ["gaps", "Gaps"],
    ["deps", "Dependencias"],
    ["prs", "PR / deploys"]
  ];
  main.innerHTML = `
    <p><a href="#/grid">← Grilla</a></p>
    <h1>#${s.azure_id} ${esc(s.title)}</h1>
    <p class="toolbar cmd-toolbar">${cmdCopyButtons(s.azure_id, times)}</p>
    ${skillStatusBanner(times)}
    <p class="hint">${esc(s.screen || "")} · estado original ${esc(s.state_original)} → ${esc(s.state_normalized)} · rev ${s.source_revision}</p>
    <div class="tabs">${tabs.map((t, i) => `<button type="button" data-tab="${t[0]}" aria-selected="${i === 0}">${t[1]}</button>`).join("")}</div>
    <section id="tab-resumen" class="panel">
      ${briefHtml(pkg, data.packages?.[0])}
      <h2>Azure</h2>
      ${azureHtml(s.description_html) || "<p>Sin descripción.</p>"}
      <h2>AC en Azure</h2>
      <p>${esc(s.acceptance_criteria || "UNKNOWN")}</p>
      <h2>Nota TL</h2>
      <p>${esc(data.note?.note || "—")}</p>
    </section>
    <section id="tab-tareas" class="panel hidden">
      <h2>Qué tiene que hacer el dev</h2>
      <p class="hint">${data.writesEnabled ? "Revisá, asigná y aprobá. Publicar crea en Azure las aprobadas que todavía no existen." : "Revisá, asigná y aprobá. Escritura Azure apagada: publicar solo guarda un preview local."}</p>
      ${data.drafts?.length ? sortDrafts(data.drafts).map((d) => draftHtml(d, data.team, data.defaultOwnerId)).join("") : `<div class="empty">Sin borradores. Ejecutá Prepare en Cursor.</div>`}
      ${publishBarHtml(data.drafts, data.writesEnabled)}
      <h2>Hijos en Azure</h2>
      ${data.children?.length ? `<ul>${data.children.map((c) => `<li>#${c.azure_id} ${esc(c.title)} · ${esc(c.state_normalized)} · ${esc(c.assigned_to_name || "sin asignar")}${c.description_html ? `<div class="hint">${azureHtml(c.description_html)}</div>` : ""}</li>`).join("")}</ul>` : "<p>Sin hijos vinculados en este sync.</p>"}
    </section>
    <section id="tab-paquete" class="panel hidden">${packageHtml(pkg, data.packages?.[0], data.results)}</section>
    <section id="tab-evidencia" class="panel hidden">
      ${data.attachments.map((a) => `<p><img class="evidence" alt="${esc(a.file_name)}" src="/attachments/${a.id}"/></p>`).join("")}
      <ul>${data.evidence.map((e) => `<li><strong>${esc(e.classification)}</strong> ${esc(e.summary)} <span class="hint">${esc(e.source)} · ${esc(e.observed_at)}</span></li>`).join("")}</ul>
      <h3>Comentarios</h3>${data.comments.map((c) => `<article>${azureHtml(c.text_html)}<p class="hint">${esc(c.author_name)} ${esc(c.created_at)}</p></article>`).join("") || "<p>Sin comentarios.</p>"}
    </section>
    <section id="tab-analisis" class="panel hidden">${analysesHtml(data.analyses)}</section>
    <section id="tab-tecnico" class="panel hidden">${techHtml(pkg)}</section>
    <section id="tab-contratos" class="panel hidden">${contractsHtml(data.contracts, pkg)}</section>
    <section id="tab-gaps" class="panel hidden"><ul>${data.questions.map((q) => `<li>${q.blocking ? "BLOQUEA · " : ""}${esc(q.question)}</li>`).join("") || "<li>Sin preguntas</li>"}</ul></section>
    <section id="tab-deps" class="panel hidden">${data.dependencies?.length ? `<ul>${data.dependencies.map((d) => `<li>${esc(d.kind)} · ${esc(d.name || d.id)} · ${esc(d.status)}</li>`).join("")}</ul>` : "<p>Sin dependencias.</p>"}</section>
    <section id="tab-prs" class="panel hidden">
      <p>Release: ${data.release.inPackage ? "en paquete" : "sin paquete"}. PROD: ${data.release.production ? "sí" : "no"}.</p>
      <p>Último deploy: ${esc(JSON.stringify(data.release.lastDeploy))}</p>
    </section>
  `;
  main.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      main.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      tabs.forEach((t) => document.getElementById(`tab-${t[0]}`).classList.toggle("hidden", t[0] !== btn.dataset.tab));
      sessionStorage.setItem("story-tab", btn.dataset.tab);
    });
  });
  const wanted = sessionStorage.getItem("story-tab");
  if (wanted && tabs.some((t) => t[0] === wanted)) {
    main.querySelector(`.tabs button[data-tab="${wanted}"]`)?.click();
  }
  wireCmdCopyButtons(main);
  wireDraftActions(s.azure_id, Boolean(data.writesEnabled));
}

async function renderSp() {
  const data = await api("/api/sp");
  const gapIds = new Set((data.gaps || []).map((gap) => gap.azureId));
  const missing = (data.traces || []).filter((trace) =>
    gapIds.has(trace.azureId) ||
    (trace.gap && gapIds.has(trace.gap.azureId)) ||
    gapIds.has(trace.workContract?.story?.azureId) ||
    (trace.workContract?.tasks || []).some((task) => gapIds.has(task.azureId))
  );
  main.innerHTML = `
    <h1>Dependencias SP</h1>
    <p class="hint">Solo los ítems de Inicio → Falta definición SQL. Aging en ${esc(data.agingUnit)}, zona ${esc(data.timezone)}. Cadena: captura → pantalla FE → API mostrar/guardar → controller/model → SP. El código es hipótesis hasta confirmar contrato.</p>
    <div class="toolbar">
      <button type="button" id="sp-report" class="primary">Informe SP (PDF)</button>
    </div>
    <section class="panel sql-gaps">
      <h2>Falta definición SQL</h2>
      <p class="hint">Historias o tareas a las que les falta el contrato. Cada fila recorre el front hasta el back y separa SP de lectura y de envío.</p>
      ${missing.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Ítem</th><th>Capturas</th><th>Pantalla</th><th>Mostrar</th><th>Guardar</th><th>Frontend</th><th>Backend</th><th>Leer</th><th>Mandar</th><th>Pedido</th></tr></thead>
        <tbody>${missing.map((trace) => spTraceRow(trace)).join("")}</tbody>
      </table></div>` : `<div class="empty">Ninguna historia analizada está frenada por definición SQL.</div>`}
    </section>
    <section class="panel sp-report-preview">
      <h2>Informe para mandar</h2>
      <p class="hint">Pedido a SQL: texto de lo que falta, contrato de la historia/tareas con capturas, y SP de lectura/envío. El botón abre la versión imprimible.</p>
      ${missing.length ? missing.map((trace) => `
        <article class="mini-card">
          <h3>#${trace.azureId} ${esc(trace.title)}</h3>
          <p>${esc(sqlPedido(trace))}</p>
          ${sqlContractHtml(trace)}
          <p class="hint">SP para leer: ${esc(spNames(trace.sqlReads || trace.reads))} · SP para mandar: ${esc(spNames(trace.sqlWrites || trace.writes))}</p>
        </article>`).join("") : `<div class="empty">No hay ítems SP para explicar en este sprint.</div>`}
    </section>`;
  document.getElementById("sp-report")?.addEventListener("click", () => {
    window.open(`/api/sp-report?t=${Date.now()}`, "_blank");
  });
  main.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.id) location.hash = `#/story/${tr.dataset.id}`; }));
}

function spTraceRow(trace, withPedido = true) {
  return `<tr data-id="${trace.azureId}">
    <td class="item"><a href="#/story/${trace.azureId}">#${trace.azureId} ${esc(trace.title)}</a></td>
    <td class="sp-thumb">${captureThumbs(trace.captures)}</td>
    <td>${esc(screenCell(trace))}</td>
    <td>${esc(apiSummary((trace.apis || []).filter((a) => a.usage === "lectura")))}</td>
    <td>${esc(apiSummary((trace.apis || []).filter((a) => a.usage === "envio")))}</td>
    <td>${esc(layerSummary(trace.frontend, trace.frontendPages?.length ? trace.frontendPages : trace.filesFe))}</td>
    <td>${esc(layerSummary(trace.backend, trace.filesBe))}</td>
    <td>${esc(spNames(trace.reads))}</td>
    <td>${esc(spNames(trace.writes))}</td>
    ${withPedido ? `<td>${esc(trace.gap?.copyText || (trace.missingContract ? "Falta contrato confirmado." : "—"))}</td>` : ""}
  </tr>`;
}

function layerSummary(items, files) {
  const tasks = (items || []).map((item) => {
    const id = item.azureId ? `#${item.azureId} ` : item.source === "draft" ? "(borrador) " : "";
    return `${id}${item.title}`;
  });
  if (files?.length) tasks.push(files.join(", "));
  return tasks.join(" · ") || "—";
}

function spNames(refs) {
  if (!refs?.length) return "—";
  return refs.map((sp) => sp.name || "SP sin nombre").join(", ");
}

function sqlPedido(trace) {
  if (trace.gap?.copyText) return trace.gap.copyText;
  if (trace.missingContract) return `Para #${trace.azureId} ${trace.title} falta la definición del contrato SP.`;
  return `Contrato en evidencia para #${trace.azureId} ${trace.title}.`;
}

function sqlContractHtml(trace) {
  const story = trace.workContract?.story;
  const tasks = trace.workContract?.tasks || [];
  const html = [
    story ? sqlContractItem(story, tasks.length ? "Historia" : (/task/i.test(story.type) ? "Tarea" : "Historia")) : "",
    ...tasks.map((task) => sqlContractItem(task, "Subtarea"))
  ].filter(Boolean).join("");
  const used = `${story?.descriptionHtml || ""}${tasks.map((t) => t.descriptionHtml || "").join("")}`.toLowerCase();
  const extras = (trace.captures || []).filter((c) => {
    if (!c.url?.startsWith("/attachments/")) return false;
    if (used.includes(c.url.toLowerCase())) return false;
    const guid = `${c.url} ${c.fileName || ""} ${c.id || ""}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return !(guid && used.includes(guid[0].toLowerCase()));
  });
  const caps = extras.length
    ? `<div class="sp-captures">${extras.map((c) => `<figure><img src="${esc(c.url)}" alt="${esc(c.alt || c.fileName)}" loading="lazy"/><figcaption>${esc(c.inferredScreen || c.fileName)}</figcaption></figure>`).join("")}</div>`
    : "";
  return html || caps ? `<div class="sql-contract">${html}${caps}</div>` : "";
}

function sqlContractItem(item, kind) {
  const body = item.descriptionHtml?.trim();
  const ac = item.acceptanceCriteria?.trim();
  return `<section class="sql-wi">
    <h4>${esc(kind)} #${item.azureId} ${esc(item.title)}</h4>
    ${body ? `<div class="sql-wi-body">${body}</div>` : `<p class="hint">Sin descripción en Azure.</p>`}
    ${ac ? `<p class="hint"><strong>AC:</strong> ${esc(ac)}</p>` : ""}
  </section>`;
}

function screenCell(trace) {
  if (!trace.screen) return "—";
  return trace.screenSource ? `${trace.screen} (${trace.screenSource})` : trace.screen;
}

function apiSummary(apis) {
  if (!apis?.length) return "—";
  return apis.map((api) => {
    const sp = api.sps?.length
      ? ` → ${api.sps.join(", ")}`
      : api.via === "http"
        ? " → HTTP middleware/NCSL"
        : api.via === "ef"
          ? " → EF"
          : "";
    const model = api.models?.[0] ? ` (${api.models[0]})` : "";
    return `${api.method ? `${api.method} ` : ""}${api.path}${model}${sp}`;
  }).join(" · ");
}

function captureThumbs(captures) {
  if (!captures?.length) return "—";
  return captures
    .filter((c) => c.url?.startsWith("/attachments/"))
    .slice(0, 2)
    .map((c) => `<img class="sp-cap" src="${esc(c.url)}" alt="${esc(c.fileName)}" title="${esc(c.inferredScreen || c.note)}" loading="lazy"/>`)
    .join("") || `${captures.length} sin archivo local`;
}

function initials(name) {
  return String(name || "?").split(/[,\s]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

async function renderTeam() {
  const data = await api("/api/team");
  main.innerHTML = `<h1>Equipo</h1>
    <p class="hint">Composición desde config. WIP = tareas DOING/REVIEW. No hay ranking de productividad.</p>
    <section class="cards">${data.members.map((m) => `<article class="card member-card">
      <div class="member-head"><div class="avatar">${esc(initials(m.displayName))}</div><div><h2>${esc(m.displayName)}</h2><p class="hint">${esc(m.role)}</p></div></div>
      <p class="value">${m.wip}</p><p class="hint">WIP</p>
      <ul>${m.tasks.map((t) => `<li>#${t.azure_id} ${esc(t.title)} (${t.state_normalized})</li>`).join("") || "<li class='hint'>Sin ítems asignados</li>"}</ul>
    </article>`).join("")}</section>
    <h2>Sin asignar</h2>
    ${data.unassigned.length ? `<ul>${data.unassigned.map((t) => `<li>#${t.azure_id} ${esc(t.title)}</li>`).join("")}</ul>` : `<div class="empty">Nada sin asignar.</div>`}`;
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

function sortDrafts(drafts) {
  return [...drafts].sort((a, b) => {
    const blockedA = a.payload?.blocked ? 1 : 0;
    const blockedB = b.payload?.blocked ? 1 : 0;
    if (blockedA !== blockedB) return blockedA - blockedB;
    if (a.layer === b.layer) return 0;
    return a.layer === "FE" ? -1 : 1;
  });
}

function ul(items, mapFn) {
  if (!items?.length) return "<p class=\"hint\">N/A</p>";
  return `<ul>${items.map(mapFn).join("")}</ul>`;
}

function ol(items, mapFn) {
  if (!items?.length) return "";
  return `<ol class="steps">${items.map(mapFn).join("")}</ol>`;
}

function briefHtml(pkg, meta) {
  if (!pkg) {
    return `<div class="empty">Todavía no hay paquete prepare. Ejecutá Prepare en Cursor.</div>`;
  }
  const r = pkg.readiness || {};
  const st = r.status || "DRAFT";
  return `<article class="brief">
    <div class="brief-head">
      <h2>Brief para el equipo</h2>
      <span class="pill st-${esc(st === "READY" ? "READY" : st === "BLOCKED" ? "BLOCKED" : "OTHER")}">${esc(st)}</span>
    </div>
    <p class="hint">v${esc(meta?.context_version)} · ${esc(pkg.artifactId || "")} · ${esc(formatWhen(pkg.generatedAt || meta?.created_at))}</p>
    <dl class="brief-dl">
      <dt>Objetivo</dt><dd>${esc(pkg.summary?.functionalGoal || "—")}</dd>
      <dt>Hoy</dt><dd>${esc(pkg.summary?.currentBehavior || "—")}</dd>
      <dt>Esperado</dt><dd>${esc(pkg.summary?.expectedBehavior || "—")}</dd>
    </dl>
    ${(r.reasons || []).length ? `<p class="hint">${(r.reasons || []).map(esc).join(" · ")}</p>` : ""}
    <p class="hint">Detalle de pasos en Subtareas. Archivos y plan de prueba en Paquete.</p>
  </article>`;
}

function packageHtml(pkg, meta, results) {
  if (!pkg) return `<div class="empty">Sin paquete team-ai. No hay brief generado.</div>`;
  const ac = pkg.acceptanceCriteria || [];
  const tests = pkg.testPlan || [];
  const gaps = pkg.gaps || [];
  const included = pkg.scope?.included || [];
  const excluded = pkg.scope?.excluded || [];
  return `
    <p class="hint">${esc(pkg.artifactId)} · hash ${esc(String(meta?.context_hash || pkg.contextHash || "").slice(0, 12))}… ${meta?.stale ? "· stale" : ""}</p>
    <h2>Alcance</h2>
    <p><strong>Incluye</strong></p>${ul(included, (x) => `<li>${esc(x)}</li>`)}
    <p><strong>Fuera</strong></p>${ul(excluded, (x) => `<li>${esc(x)}</li>`)}
    <h2>Criterios de aceptación</h2>
    ${ac.length ? ul(ac, (a) => `<li><strong>${esc(a.id)}</strong> ${esc(a.text)}</li>`) : "<p class=\"hint\">Sin AC en el paquete.</p>"}
    <h2>Plan de prueba</h2>
    ${tests.length ? tests.map((t) => `<article class="mini-card"><h3>${esc(t.id)} · ${esc(t.title)}</h3><p class="hint">${esc(t.kind)}</p>${ol(t.steps || [], (s) => `<li>${esc(s)}</li>`)}</article>`).join("") : "<p class=\"hint\">Sin plan.</p>"}
    <h2>Gaps</h2>
    ${ul(gaps, (g) => `<li>${g.blocking ? "<strong>BLOQUEA · </strong>" : ""}${esc(g.question)}</li>`)}
    <h2>Archivos candidatos</h2>
    ${filesHtml(pkg.scope?.candidateFiles)}
    <h2>Resultados kit</h2>
    <ul>${(results || []).map((r) => `<li>${esc(r.origin)} rev ${r.revision} · última evidencia reportada (no implica PROD)</li>`).join("") || "<li>N/A</li>"}</ul>
  `;
}

function draftHtml(d, team, defaultOwnerId) {
  const p = d.payload || {};
  const blocked = Boolean(p.blocked);
  const files = p.files || p.archivosReferencia || [];
  const pasos = p.pasos || [];
  const dod = p.dod || [];
  const repo = p.base ? `${p.base.repo} @ ${p.base.ref} (${String(p.base.sha || "").slice(0, 8)})` : (p.repo || "");
  const review = d.review_status || "pending";
  const assigned = d.assigned_to_id || p.assignedTo || "";
  const owner = (team || []).find((m) => m.id === defaultOwnerId);
  const ownerName = owner?.displayName || "dueño por defecto";
  const members = (team || []).filter((m) => {
    if (m.id === assigned || m.id === defaultOwnerId) return true;
    if (d.layer === "FE") return m.role === "frontend";
    if (d.layer === "BE") return m.role === "backend";
    return true;
  });
  const reviewLabel = review === "approved" ? "aprobada" : review === "rejected" ? "descartada" : "pendiente";
  const reviewPill = review === "approved" ? "st-READY" : review === "rejected" ? "st-BLOCKED" : "st-OTHER";
  const fallbackNote = p.assignmentFallback
    ? `<p class="hint">${esc(p.assignmentFallback)}</p>`
    : "";
  return `<article class="draft-card">
    <div class="brief-head">
      <h3>${esc(d.title || p.title)}</h3>
      <span class="pill type-${d.layer === "FE" ? "story" : "task"}">${esc(d.layer)}</span>
      <span class="pill ${blocked ? "st-BLOCKED" : "st-READY"}">${blocked ? "no iniciar" : "para tomar"}</span>
      <span class="pill ${reviewPill}">${reviewLabel}</span>
    </div>
    <div class="draft-actions" data-draft-id="${esc(d.id)}">
      <label>Asignar
        <select data-action="assign">
          <option value="">Sin asignar</option>
          ${members.map((m) => {
            const invalid = m.azureIdValid === false;
            const label = invalid ? `${m.displayName} (sin ID Azure → ${ownerName})` : m.displayName;
            return `<option value="${esc(m.id)}" ${m.id === assigned ? "selected" : ""}>${esc(label)}</option>`;
          }).join("")}
        </select>
      </label>
      <button type="button" class="primary" data-action="review" data-status="approved" ${review === "approved" ? "disabled" : ""}>Aprobar</button>
      <button type="button" data-action="review" data-status="rejected" ${review === "rejected" ? "disabled" : ""}>Descartar</button>
      ${review !== "pending" ? `<button type="button" data-action="review" data-status="pending">Volver a pendiente</button>` : ""}
    </div>
    <p class="hint">${esc(assigned || "UNASSIGNED")} · ${esc(d.publish_status || "local")} · ${esc(repo)}</p>
    ${fallbackNote}
    ${p.objetivo ? `<p><strong>Objetivo.</strong> ${esc(p.objetivo)}</p>` : ""}
    ${p.expected && p.expected !== "UNKNOWN" ? `<p><strong>Esperado.</strong> ${esc(p.expected)}</p>` : ""}
    ${p.contract ? `<p class="hint">Contrato: ${esc(p.contract)}</p>` : ""}
    ${sourceContextHtml(p.sourceContext)}
    ${pasos.length ? `<h4>Pasos</h4>${ol(pasos, (step) => `<li>${esc(step)}</li>`)}` : ""}
    ${files.length ? `<h4>Archivos</h4>${ul(files, (f) => `<li><code>${esc(f)}</code></li>`)}` : ""}
    ${dod.length ? `<h4>DoD</h4>${ul(dod, (item) => `<li>${esc(item)}</li>`)}` : ""}
  </article>`;
}

function sourceContextHtml(items) {
  if (!items?.length) return "";
  return `<h4>Más info (historia y subtareas)</h4>${items.map((item) => {
    const images = (item.attachments || []).filter((a) => a.image || String(a.contentType || "").startsWith("image/"));
    const other = (item.attachments || []).filter((a) => !images.includes(a));
    const imgTags = images.map((a) => {
      const src = a.id && !String(a.id).startsWith("rel-") ? `/attachments/${a.id}` : azureHtml(a.sourceUrl || "");
      if (!src) return `<p class="hint">Imagen: ${esc(a.fileName)}</p>`;
      return `<p><img class="evidence" alt="${esc(a.fileName)}" src="${esc(src)}"/></p>`;
    }).join("");
    return `<div class="source-ctx">
      <p class="hint">#${item.azureId} ${esc(item.title)} (${esc(item.type)})</p>
      ${item.descriptionHtml ? azureHtml(item.descriptionHtml) : (item.descriptionText ? `<p>${esc(item.descriptionText)}</p>` : "")}
      ${item.acceptanceCriteria ? `<p><strong>AC.</strong> ${esc(item.acceptanceCriteria)}</p>` : ""}
      ${(item.comments || []).map((c) => `<article>${c.html ? azureHtml(c.html) : esc(c.text || "")}<p class="hint">${esc(c.author || "")} ${esc(c.at || "")}</p></article>`).join("")}
      ${imgTags}
      ${other.map((a) => `<p class="hint">Adjunto: ${esc(a.fileName)}</p>`).join("")}
    </div>`;
  }).join("")}`;
}

function publishBarHtml(drafts, writesEnabled) {
  const list = drafts || [];
  if (!list.length) return "";
  const approved = list.filter((d) => d.review_status === "approved").length;
  return `<div class="publish-bar">
    <p><strong>${approved}</strong> aprobada(s) de ${list.length}. Escritura Azure: ${writesEnabled ? "habilitada" : "apagada (solo preview local)"}.</p>
    <button type="button" class="primary" id="publish-drafts" ${approved ? "" : "disabled"}>Publicar aprobadas</button>
  </div>`;
}

async function postLocal(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "x-tl-control": "local", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || data.reason || `${res.status} ${path}`);
  return data;
}

function wireDraftActions(azureId, writesEnabled) {
  main.querySelectorAll(".draft-actions").forEach((box) => {
    const draftId = box.dataset.draftId;
    box.querySelector("select[data-action='assign']")?.addEventListener("change", async (e) => {
      e.stopPropagation();
      try {
        const result = await postLocal("/api/drafts/assign", { draftId, memberId: e.target.value || null });
        status("ok", result.fallback && result.reason ? result.reason : "Asignación guardada.");
        sessionStorage.setItem("story-tab", "tareas");
        await renderStory(azureId);
      } catch (err) {
        status("error", err.message);
      }
    });
    box.querySelectorAll("button[data-action='review']").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await postLocal("/api/drafts/review", { draftId, status: btn.dataset.status });
          status("ok", btn.dataset.status === "approved" ? "Tarea aprobada." : btn.dataset.status === "rejected" ? "Tarea descartada." : "Volvió a pendiente.");
          sessionStorage.setItem("story-tab", "tareas");
          await renderStory(azureId);
        } catch (err) {
          status("error", err.message);
        }
      });
    });
  });
  document.getElementById("publish-drafts")?.addEventListener("click", async () => {
    const ask = writesEnabled
      ? "¿Publicar en Azure? Las que ya existen se actualizan (asignado, título, descripción); las nuevas se crean."
      : "Escritura Azure apagada. Solo se guarda un preview local y no se crea nada en Azure. ¿Continuar?";
    if (!confirm(ask)) return;
    try {
      const result = await postLocal(`/api/story/${azureId}/publish`, { confirm: true });
      status(result.published ? "ok" : "error", result.reason || "No se pudo publicar.");
      sessionStorage.setItem("story-tab", "tareas");
      await renderStory(azureId);
    } catch (err) {
      status("error", err.message);
      sessionStorage.setItem("story-tab", "tareas");
      await renderStory(azureId);
    }
  });
}

function filesHtml(files) {
  if (!files?.length) return `<p class="hint">Sin archivos verificados en el paquete.</p>`;
  return `<div class="file-list">${files.map((f) => `
    <div class="file-row">
      <code>${esc(f.path)}</code>
      ${f.verified ? `<span class="pill st-DEV_DONE">verificado</span>` : `<span class="pill st-OTHER">hipótesis</span>`}
      ${f.symbol ? `<span class="hint">${esc(f.symbol)}</span>` : ""}
      <p>${esc(f.reason || "")}</p>
      ${f.sha ? `<p class="hint">${esc(String(f.sha).slice(0, 12))}…</p>` : ""}
    </div>`).join("")}</div>`;
}

function techHtml(pkg) {
  const repos = pkg?.repositories || [];
  if (!pkg) return `<p>Todavía no hay SHA ni archivos del prepare. Repos se anclan al correr analyze/prepare.</p>`;
  return `
    ${repos.length ? `<ul>${repos.map((r) => `<li><strong>${esc(r.role)}</strong> ${esc(r.repoId)} · ${esc(r.baseRef)} @ ${esc(String(r.baseSha || "").slice(0, 12))}</li>`).join("")}</ul>` : ""}
    ${filesHtml(pkg.scope?.candidateFiles)}
    <p class="hint">Archivos no verificados no se muestran como evidencia de código.</p>
  `;
}

function contractsHtml(contracts, pkg) {
  const fromPkg = pkg?.contracts || [];
  const rows = (contracts || []).length ? contracts : fromPkg;
  if (!rows.length) return "<p>Sin contratos.</p>";
  return rows.map((c) => {
    const def = c.definition || {};
    return `<article class="mini-card">
      <h3>${esc(c.name || c.id)} · ${esc(c.kind)} · ${esc(c.status)}</h3>
      ${def.example ? `<p><code>${esc(def.example)}</code></p>` : ""}
      ${def.compatibilityNotes ? `<p>${esc(def.compatibilityNotes)}</p>` : ""}
      ${def.inputs?.length ? `<p><strong>In</strong></p>${ul(def.inputs, (i) => `<li><code>${esc(i.name)}</code> ${esc(i.type)} — ${esc(i.meaning)}</li>`)}` : ""}
      ${def.outputs?.length ? `<p><strong>Out</strong></p>${ul(def.outputs, (o) => `<li><code>${esc(o.name)}</code> ${esc(o.type)} — ${esc(o.meaning)}</li>`)}` : ""}
      ${def.errors?.length ? `<p><strong>Errores</strong></p>${ul(def.errors, (e) => `<li>${esc(e)}</li>`)}` : ""}
    </article>`;
  }).join("");
}

function analysesHtml(analyses) {
  if (!analyses?.length) return "<p>Sin análisis aún. Skill /analyze-story.</p>";
  return analyses.map((a) => {
    const p = a.payload || {};
    const fn = p.functional || {};
    const rd = p.readiness || {};
    return `<article class="mini-card">
      <h3>${esc(a.kind)} · ${esc(formatWhen(a.created_at))} ${a.stale ? "· DESACTUALIZADO" : ""}</h3>
      <p class="hint">sha ${esc(a.base_sha || "n/a")} · ${esc(a.repo_id || "")}</p>
      ${p.scope ? `<p class="hint">Alcance: ${esc(p.scope.mode)} · ${Number(p.scope.childrenCount || p.children?.length || 0)} subtarea(s)</p>` : ""}
      ${fn.problem ? `<p><strong>Problema.</strong> ${esc(fn.problem)}</p>` : ""}
      ${fn.currentBehavior && fn.currentBehavior !== "UNKNOWN" ? `<p><strong>Hoy.</strong> ${esc(fn.currentBehavior)}</p>` : ""}
      ${fn.expectedBehavior && fn.expectedBehavior !== "UNKNOWN" ? `<p><strong>Esperado.</strong> ${esc(fn.expectedBehavior)}</p>` : ""}
      ${(p.children || []).length ? `<p><strong>Subtareas revisadas.</strong></p><ul>${p.children.map((c) => `<li>#${c.azureId} ${esc(c.title)}</li>`).join("")}</ul>` : ""}
      ${rd.status ? `<p>Readiness análisis: ${esc(rd.status)}</p>` : ""}
    </article>`;
  }).join("");
}

function azureHtml(value) {
  return String(value ?? "").replace(
    /https:\/\/dev\.azure\.com\/[^"'>\s]+\/_apis\/wit\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\?[^"'>\s]*)?/gi,
    (_match, guid) => `/attachments/azure/${String(guid).toLowerCase()}`
  );
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
