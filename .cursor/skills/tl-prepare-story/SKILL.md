---
name: tl-prepare-story
description: Prepara subtareas y work-context.json team-ai/v1. Usar con /prepare-story.
---

Seguí `skills/prepare-story/SKILL.md`. Comando: `npx tsx src/cli/index.ts prepare-story <id>`.

**Límites:** respetá «Límites de código» del skill canónico. Borradores/Azure sí; implementación en repos de producto no.

**Descripción Azure:** no pisar lo ya cargado. Historias/tareas existentes: solo agregar el bloque extra al final.

Contrato API es lo primero en Azure (DTO/SP/rutas). HTML sin `<pre>` (Azure lo recorta). BE: spec en el módulo existente, cero front. FE: UI + `api.post` + mismo DTO. Imágenes solo en FE. Actualizar tareas existentes; no crear duplicados.
