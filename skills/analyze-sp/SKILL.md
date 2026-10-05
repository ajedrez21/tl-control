---
name: tl-analyze-sp
description: Analiza contratos y bloqueos de Stored Procedures de una historia. Usar con /analyze-sp o dependencias DB.
---

# /analyze-sp

## Entradas

ID de historia.

## Procedimiento

1. `npx tsx src/cli/index.ts analyze-sp <id>`
2. No inferir firma sólo por el nombre del SP.
3. Si el contrato es `UNKNOWN`, no declarar Ready las subtareas BE/FE dependientes ni inventar inputs/outputs.
4. Separar contrato confirmado de disponibilidad por ambiente.
5. Aging: días corridos, timezone de config (`America/Argentina/Buenos_Aires` por defecto).

## Salidas

Contratos, dependencias, intervalos de bloqueo, aging.

## Límites de código (obligatorio)

- **Modo:** análisis de contratos SP y bloqueos. **No implementar** SP ni cambios en repos de producto.
- **Permitido en `tl-control`:** CLI `analyze-sp`, lectura de artefactos que el CLI ya indexó.
- **Repos de producto:** solo lectura si hace falta contrastar nombres; sin editar `.cs`, `.sql`, etc.
- **Prohibido:** crear/alterar SP, parches en backend, o “dejar listo” el contrato en código.

## Escritura

Ninguna sobre DB de producto ni Azure. No modificar archivos fuera de lo que persista el CLI en `tl-control`.
