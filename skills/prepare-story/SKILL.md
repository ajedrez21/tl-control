---
name: tl-prepare-story
description: Genera borradores BE/FE y work-context.json team-ai/v1. Usar con /prepare-story o al armar el paquete para el developer.
---

# /prepare-story

## Entradas

- ID historia
- `--assign <memberId>` opcional (asignación **manual**; nunca automática)

## Procedimiento

1. `npx tsx src/cli/index.ts prepare-story <id> [--assign id] [--preview]`
2. El CLI incluye en cada borrador `sourceContext`: texto (descripción, AC, comentarios) e imágenes/adjuntos de la historia **y** de las subtareas existentes.
3. Revisar readiness. Si SP UNKNOWN, las subtareas BE/FE quedan bloqueadas.
4. Completar con el LLM sólo a partir de evidencia. No exigir archivos nuevos no verificados.
5. El paquete y el borrador pueden guardar `sourceContext` completo (dashboard). La **descripción Azure** de cada subtarea es otra cosa: la va a leer una IA para implementar **esa** capa. Escribila solo con lo que esa capa necesita.
6. Exporta `data/exports/ctx-*.json` validado contra `contracts/team-ai/v1`.
7. Preview Azure: `publish <id>` muestra fields/relations. `publish <id> --confirm` escribe en Azure las aprobadas (`writes.enabled`). **No pisar** lo ya cargado en historias/tareas existentes: no cambiar título, iteración ni estado. `System.Description` **solo agrega** el bloque extra de TL Control al final; si ya había un bloque TL, se actualiza ese bloque y se deja el resto. Tareas nuevas: la descripción es solo el extra. Si está apagado, exporta y no escribe.
8. Releer revisión antes de escribir; conflicto ⇒ no sobreescribir. El tag `tlc-…` del idempotencyKey evita duplicar.

## Descripción por capa (para la IA que implementa)

`azureDescriptionFromPayload` arma **solo el bloque extra**. Publish lo concatena al final; no pisa lo cargado. No reinyecta HTML ni borradores `Borrador TL Control`.

La tarea la ejecuta **otra IA**. Tiene que poder copiar un patrón existente, no inventar estilo.

### Contrato (obligatorio si hay API)

Poner `contratoApi[]` en el payload (se renderiza con DTO tipado). No un renglón vago tipo «GET con query».

En NCSLite / NWebCore:

- **Consulta con filtros** = `POST` + body DTO. Ejemplo BE: `Controllers/GrillaProgramController.cs` `POST api/grilla/programacionDiaria` + `DTO/GrillaProgramRequestDTO.cs`.
- **Alta/update** = `POST` + body DTO. Ejemplo BE: `ProgramChangeController` `POST api/programChange/send` + `DTO/ProgramChangeDTO.cs`.
- Combos sin body pueden seguir en GET. **No** GET querystring para un listado filtrado.
- Wrapper: `Models/Response.cs` → `{ model, message.success }`.
- SP en el **Model** (`DatabaseBase`: `currentStoredProc`, `addSqlParameter`, `readDB` / `impactDB`). Alias del SELECT (`NCS`, `Emisión`) = nombre de columna del `DataRow`.
- Usuario: `HttpContext.Items` LastName / FirstName / UserEmail como `DeleteProgramChange`. No van en el DTO.

Cada ítem de `contratoApi`: `method`, `route`, `ejemplo` (solo archivos de **esa** capa), `sp`, `requestDto`, `responseDto`, `map`. DTO = lo que usa la UI + clave. `frontCall` **solo en FE**.

Ese bloque es lo primero que tiene que verse en Azure. `azureDescriptionFromPayload` lo pone arriba. HTML compatible con Azure: `p`, `strong`, `br`, `h3`, `ol`, `ul`, `li`. **No** `<pre>` ni depender de comentarios `<!-- -->`: Azure los recorta y el contrato desaparece.

### BE

Cero front: ni `.js`, ni `api.post`, ni `data.model`, ni `frontCall`, ni capturas.

Dar la **especificación** (rutas, DTO tipados, SP, mapeo, `Response<T>`, usuario por HttpContext). No un recetario de “poné X en el archivo Y”.

El módulo ya existe: mismos **controller, DTO, interface, repository y model con SP** que el resto de esa feature. Citar esos archivos como referencia, no como checklist. Endpoints nuevos en el **mismo** controller. `[HttpPost]` + DTO.

### FE

Pantalla, menú, `api.post`, body tipado, `data.model` / `data.message.success`. Mismo DTO que BE. Archivos FE. **No** interfaz, repository, model ni SP.

### Imágenes

Solo en la tarea **FE**. BE sin capturas. Sin encabezados vacíos en «Más info».

## Salidas

Borradores, paquete, hash, path de export.

## Límites de código (obligatorio)

- **Modo:** borradores, `work-context`, publicación de **subtareas Azure**. **No implementar** la feature en repos de producto.
- **Permitido en `tl-control`:** CLI, borradores en SQLite, `data/exports/`, enriquecimiento textual de borradores con evidencia.
- **Repos de producto:** solo lectura para citar archivos verificados en subtareas; sin parches ni commits.
- **Prohibido:** tocar `NWeb.*`, backends, SP u otros repos salvo export/copy que viva en el paquete TL Control.

## Escritura

Azure sólo con `writes.enabled` + confirmación explícita (`publish --confirm`). Solo subtareas/borradores del flujo prepare-story. Reintento no duplica la tarea ya creada. No editar código de producto.
