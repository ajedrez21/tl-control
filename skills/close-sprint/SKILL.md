---
name: tl-close-sprint
description: Captura el cierre de sprint y genera un HTML congelado offline. Usar con /close-sprint.
---

# /close-sprint

## Procedimiento

1. `npx tsx src/cli/index.ts close-sprint "<iteration path>"`
2. No sobrescribir un snapshot cerrado: se crea uno nuevo con timestamp.
3. El HTML incrusta CSS y no depende de Azure ni CDN.

## Salidas

`reports/sprint-<id>-<timestamp>.html` + fila `snapshots.closed=1`.

## Límites de código (obligatorio)

- Solo CLI y reportes en `tl-control`. **No** repos de producto ni cambios en Azure.
