---
name: tl-analyze-sp
description: Analiza contratos y bloqueos de Stored Procedures de una historia. Usar con /analyze-sp o cuando haya que arreglar o pedir un SP.
---

# /analyze-sp

## Entradas

ID de historia (o de la tarea SP, subiendo al padre).

## Verificación obligatoria (cada vez que haga falta un arreglo de SP)

No alcanza con el nombre del SP ni con el título. Recorrer **siempre** esta cadena y dejarla en el informe:

1. **Capturas.** Leer las imágenes de la historia y subtareas (`attachments[].storedPath` o `data/attachments/<id>-*`). Identificar la pantalla real (título del modal, grilla, botón Guardar).
2. **Pantalla FE.** En el repo `repositories.frontend.localPath`, ubicar el page/popup que renderiza esa pantalla.
3. **API para mostrar.** En ese archivo (y sus imports), anotar `api.get` / `axios.get`: path, método, archivo FE.
4. **API al guardar.** Igual para `api.post` / `put` / `delete` del botón Save/Apply/Send.
5. **Backend.** Con cada path, buscar `[Route("api/...")]` en `Controllers`, bajar al model/repository inyectado.
6. **SP.** En el model, leer `currentStoredProc = "..."` (o `sp = "..."`). Separar el SP de **lectura** (`readDB`) del de **escritura** (`impactDB`). Si el endpoint pega a HTTP middleware/NCSL o a EF, decilo: no inventes un SP.
7. **Informe.** Persistir la cadena en el dossier/PDF (`/api/sp-report`) y en el payload de `analyze-sp`.

Si falta `localPath` de frontend o backend, **avisar** y no completar rutas. Sin captura, no afirmar la pantalla.

## Procedimiento CLI

1. Si venís de Inicio → Falta definición SQL, el id ya viene en el prompt. Sincronizá Azure si puede haber contrato nuevo en la historia o subtareas.
2. `npx tsx src/cli/index.ts analyze-sp <id>` y, si cambió el texto, también `analyze-story <id>`.
3. El JSON trae `chain` / `trace`: capturas, `frontendPages`, `loadApis`, `saveApis`, SPs de leer/mandar.
4. Contrastar esos paths **abriendo los archivos**. El tracer es hipótesis de código, no contrato.
5. No inferir firma sólo por el nombre del SP.
6. Si el usuario pega el contrato o está en la descripción: `npx tsx src/cli/index.ts analyze-sp <id> --confirm --name <SP> --note "<resumen>"`. No inventar inputs/outputs.
7. Si al final no hace falta SP: `npx tsx src/cli/index.ts analyze-sp <id> --not-needed` (lo saca de Falta definición SQL).
8. Si el contrato sigue `UNKNOWN`, no declarar Ready las subtareas BE/FE dependientes.
9. Separar contrato confirmado de disponibilidad por ambiente.
10. Aging: días corridos, timezone de config (`America/Argentina/Buenos_Aires` por defecto).

## Salidas

Contratos, dependencias, intervalos de bloqueo, aging, y la cadena captura → FE → API mostrar/guardar → model → SP.

## Límites de código (obligatorio)

- **Modo:** análisis de contratos SP y bloqueos. **No implementar** SP ni cambios en repos de producto.
- **Permitido en `tl-control`:** CLI `analyze-sp`, lectura de artefactos que el CLI ya indexó, actualizar informe SP del dashboard.
- **Repos de producto:** solo lectura para contrastar pantalla, API, model y `currentStoredProc`; sin editar `.cs`, `.js`, `.sql`.
- **Prohibido:** crear/alterar SP, parches en backend, o “dejar listo” el contrato en código.

## Escritura

Ninguna sobre DB de producto ni Azure. No modificar archivos fuera de lo que persista el CLI en `tl-control`.
