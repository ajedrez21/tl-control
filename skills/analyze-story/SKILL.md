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
9. **Armado mínimo.** Con PBI + capturas + subtareas, decir si alcanza para armar. Si no, informar **qué falta**, no una lista larga:
    - Contrato SP (nombre/params) ausente en subtarea DB → **bloqueante**.
    - Más info de referencia solo si sin eso no se puede armar el flujo.
10. **Consultas de corroboración** (no bloquean armar ni ejecutar tareas; se responden después):
    - Nombre del ítem de menú (puede ser el título del mockup, p. ej. Deleted Programs; hay que confirmarlo).
    - Código de permiso/seguridad del ítem nuevo.
    - Detalle fino de captura, AC formal, textos de UI.
    No las trates como gaps bloqueantes ni dejes la historia BLOCKED por ellas.
11. Cardinalidad: si la HU dice **uno**, el contrato es **un** ítem. No promover a lista.
12. Plan técnico corto si hay SP en subtareas: el front llama al **backend NCSL** (no al SP ni al MW). Consulta → API de listado + DTO según columnas del mockup y nombres del modelo existente. Grabación → API con la misma cardinalidad que la HU. `userName`/`userEmail` del HTTP del back. MW/CS son post-grabado BE.
13. Al **generar la tarea FE** (`/prepare-story`), incluir las imágenes de la historia como referencia. En BE no.

## Salidas

JSON de análisis persistido. Fuente y fecha por hallazgo. Si hay SP en subtareas, contratos API/DTO mínimos. Preguntas solo por lo que falta.

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
