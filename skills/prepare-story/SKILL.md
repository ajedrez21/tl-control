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
5. Conservar en las tareas el `sourceContext` (texto + referencias a imágenes). Si el LLM enriquece el borrador, **no borrar** esa info extra: el dev debe verla en la subtarea sin abrir el padre.
6. Si hay imágenes, dejarlas listadas (fileName / storedPath / id) para el dashboard y la descripción Azure.
7. Exporta `data/exports/ctx-*.json` validado contra `contracts/team-ai/v1`.
8. Preview Azure: `publish <id>` muestra fields/relations. `System.Description` lleva objetivo, esperado, contrato, pasos, archivos, definición de hecho y el texto de historia/subtareas. `publish <id> --confirm` crea en Azure solo las aprobadas sin `azure_id` si `writes.enabled=true`. Si está apagado, exporta y no escribe.
9. Releer revisión antes de escribir; conflicto ⇒ no sobreescribir. El tag `tlc-…` del idempotencyKey evita duplicar.

## Salidas

Borradores, paquete, hash, path de export.

## Límites de código (obligatorio)

- **Modo:** borradores, `work-context`, publicación de **subtareas Azure**. **No implementar** la feature en repos de producto.
- **Permitido en `tl-control`:** CLI, borradores en SQLite, `data/exports/`, enriquecimiento textual de borradores con evidencia.
- **Repos de producto:** solo lectura para citar archivos verificados en subtareas; sin parches ni commits.
- **Prohibido:** tocar `NWeb.*`, backends, SP u otros repos salvo export/copy que viva en el paquete TL Control.

## Escritura

Azure sólo con `writes.enabled` + confirmación explícita (`publish --confirm`). Solo subtareas/borradores del flujo prepare-story. Reintento no duplica la tarea ya creada. No editar código de producto.
