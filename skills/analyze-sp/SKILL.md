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

## Escritura

Ninguna sobre DB ni Azure.
