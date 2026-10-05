---
name: tl-sync-sprint
description: Sincroniza un sprint de Azure DevOps hacia TL Control. Usar cuando pidan /sync-sprint o actualizar el backlog.
disable-model-invocation: false
---

Seguí `skills/sync-sprint/SKILL.md`. Comando: `npx tsx src/cli/index.ts sync --iteration "<path>"`.

**Límites:** respetá «Límites de código» del skill canónico. Solo cache `tl-control`; no repos de producto.
