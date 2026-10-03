---
name: tl-sync-sprint
description: Sincroniza un sprint de Azure DevOps hacia el cache SQLite de TL Control. Usar cuando el usuario pida /sync-sprint, sync del sprint, actualizar work items o ingestión Azure.
---

# /sync-sprint

## Entradas

- Iteración Azure (`System.IterationPath`) o flag `--iteration`.
- Credenciales: `AZURE_DEVOPS_EXT_PAT` o `AZURE_DEVOPS_PAT`. Nunca pedir que las pegue en el chat para guardarlas en Git.

## Procedimiento

1. Leer `config/tl-control.json`. Si falta, `npx tsx src/cli/index.ts setup`.
2. `npx tsx src/cli/index.ts doctor` y distinguir unconfigured vs authenticated.
3. Si no hay PAT: no inventar datos. Ofrecer `npx tsx src/cli/index.ts demo` o `sync --demo`.
4. Ejecutar `npx tsx src/cli/index.ts sync --iteration "<path>"`.
5. Informar `syncRunId`, conteo y `coverage` por fuente (`OK|PARTIAL|NOT_AVAILABLE|UNAUTHORIZED|ERROR`).
6. Si Azure falla, conservar cache previo y mostrar desactualización.

## MCP opcional (host)

Herramientas reales del server local Microsoft (`docs` TOOLSET 2026-10-03): `wit_work_item` (get, get_batch, list_comments, list_revisions, list_for_iteration), `wit_query` wiql, attachments, PRs, pipelines. No asumir nombres de ejemplos conversacionales. Si una fuente no está, marcar `NOT_AVAILABLE`.

La web **no** llama MCP. El botón Actualizar muestra este comando.

## Salidas

JSON de cobertura + SQLite en `data/`. Sin secretos.

## Escritura

Sólo lectura Azure. No crear/editar Work Items.
