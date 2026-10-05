---
name: tl-analyze-story
description: Analiza una historia Azure con evidencia CONFIRMED/INFERRED/UNKNOWN y ancla repos a SHA. Usar con /analyze-story o al preparar contexto de un Work Item.
---

# /analyze-story

## Entradas

ID numérico o `org/proyecto/id`.

## Procedimiento

1. `npx tsx src/cli/index.ts analyze-story <id>`
2. La salida trae `scope.mode` y `items` (WI pedido + hijos directos):
   - `story-and-children`: historia/bug/PBI **y** todas las subtareas.
   - `story-only`: historia sin hijos; analizar sólo ese WI.
   - `task-only`: es una Task; analizar **sólo esa tarea**, sin subir al padre ni hermanos.
3. Revisar **todo** lo del alcance: descripción, AC, comentarios, adjuntos e imágenes de cada ítem en `items`/`sourceContext`. No alcanza con el título.
4. Si un adjunto es imagen (`attachments[].image` o `contentType` image/*), **leer el archivo** en `storedPath` para interpretar la captura. Una imagen sin texto no completa campos.
5. Interpretar evidencia con el LLM **sin inventar requisitos**.
6. Clasificar cada conclusión: `CONFIRMED` | `INFERRED` | `UNKNOWN`.
7. Si hay repo `localPath`, el CLI busca candidatos reales. Símbolo no encontrado = hipótesis, no archivo.
8. Repo inaccesible = análisis parcial; no afirmar contexto técnico validado.
9. Mostrar contradicciones y preguntas concretas, incluyendo las que vengan de subtareas.

## Salidas

JSON de análisis persistido. Fuente y fecha por hallazgo.

## Límites de código (obligatorio)

- **Modo:** análisis y documentación. **No implementar** la historia en repos de producto (frontend, backend, SQL, infra, etc.).
- **Permitido en `tl-control`:** ejecutar CLI, leer/escribir solo lo que el comando persista (`data/`, SQLite, exports de análisis).
- **Repos de producto** (`repositories[]` en config): **solo lectura** para evidencia (archivos, grep). Sin parches, sin commits, sin scripts one-off en esos repos.
- **Prohibido:** editar código “porque el análisis ya definió el cambio”, instalar deps, builds o deploys en producto.
- Si piden **implementar**, decir que sale del alcance de `/analyze-story` (flujo de desarrollo aparte).

## Escritura

- **Azure (opcional):** si el usuario pide **documentar el análisis en la tarea**, actualizar solo `System.Description`, criterios de aceptación o comentario del WI analizado (y subtareas en alcance si aplica). No crear WI, no cambiar estado/asignación/iteración.
- **No** alterar SP ni contratos en BD de producto.
- **No** publicar subtareas (`prepare-story` / `publish`).
