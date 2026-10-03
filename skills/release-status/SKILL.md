---
name: tl-release-status
description: Muestra paquetes de release, componentes, deploys y Work Items incluidos. Usar con /release-status.
---

# /release-status

## Procedimiento

1. `npx tsx src/cli/index.ts release-status [id]`
2. Merge, Done o build exitoso **no** equivalen a producción.
3. Deploy parcial (sólo BE) ⇒ la historia con FE pendiente no está completa en PROD.
4. `MANUAL_CONFIRMED` se etiqueta como evidencia del TL, no como pipeline automático.
5. Rollback y desconocido deben permanecer visibles.

## Salidas

JSON de releases. Fuente por evento.
