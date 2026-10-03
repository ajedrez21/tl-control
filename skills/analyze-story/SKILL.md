---
name: tl-analyze-story
description: Analiza una historia Azure con evidencia CONFIRMED/INFERRED/UNKNOWN y ancla repos a SHA. Usar con /analyze-story o al preparar contexto de un Work Item.
---

# /analyze-story

## Entradas

ID numérico o `org/proyecto/id`.

## Procedimiento

1. `npx tsx src/cli/index.ts analyze-story <id>`
2. Leer descripción, AC, comentarios, adjuntos y análisis previos en la salida.
3. Interpretar evidencia con el LLM **sin inventar requisitos**. Una captura sin texto no completa campos.
4. Clasificar cada conclusión: `CONFIRMED` | `INFERRED` | `UNKNOWN`.
5. Si hay repo `localPath`, el CLI busca candidatos reales. Símbolo no encontrado = hipótesis, no archivo.
6. Repo inaccesible = análisis parcial; no afirmar contexto técnico validado.
7. Mostrar contradicciones y preguntas concretas.

## Salidas

JSON de análisis persistido. Fuente y fecha por hallazgo.

## Escritura

No publica en Azure. No altera SP.
