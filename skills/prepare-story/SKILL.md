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
2. Revisar readiness. Si SP UNKNOWN, las subtareas BE/FE quedan bloqueadas.
3. Completar con el LLM sólo a partir de evidencia. No exigir archivos nuevos no verificados.
4. Exporta `data/exports/ctx-*.json` validado contra `contracts/team-ai/v1`.
5. Preview Azure: `publish <id>` muestra fields/relations. `publish <id> --confirm` no escribe si `writes.enabled=false`.
6. Releer revisión antes de escribir; conflicto ⇒ no sobreescribir. IdempotencyKey evita duplicar.

## Salidas

Borradores, paquete, hash, path de export.

## Escritura

Azure sólo con writes.enabled + --confirm explícito.
