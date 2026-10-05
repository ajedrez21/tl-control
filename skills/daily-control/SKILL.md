---
name: tl-daily-control
description: Calcula alertas y métricas determinísticas del sprint. Usar con /daily-control o al pedir el estado del día.
---

# /daily-control

## Procedimiento

1. `npx tsx src/cli/index.ts daily-control`
2. No recalcular el baseline con el scope actual.
3. No mezclar historias, tareas, horas y puntos en un mismo porcentaje.
4. No construir rankings de productividad.

## Salidas

JSON de métricas (fórmula, unidad, fuente) y alertas enlazables.

El LLM no inventa cálculos: usa la salida del CLI.

## Límites de código (obligatorio)

- Solo CLI y salida JSON. **No** editar repos de producto ni Azure.
- **No** modificar código fuera de `tl-control` (esta skill no escribe archivos).
