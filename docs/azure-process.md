# Mapeo de proceso Azure → estados normalizados

Los nombres de tipo y estado **no se hardcodean al tenant**. Se leen de `config/tl-control.json` → `azure.stateMapping` y `azure.workItemTypes`.

## Estados normalizados

| Código | Significado operativo |
|---|---|
| `NEW` | Recién creado, no preparado |
| `READY` | Listo para desarrollo, contexto suficiente |
| `DOING` | En desarrollo |
| `REVIEW` | PR / code review |
| `BLOCKED` | Bloqueado (SP, dependencia, espera) |
| `DEV_DONE` | Desarrollo terminado; no implica QA ni PROD |
| `QA` | Desplegado o en prueba de QA |
| `UAT` | En UAT |
| `PENDING_RELEASE` | Listo o empaquetado, sin producción confirmada |
| `PRODUCTION` | Producción confirmada con evidencia de deploy |
| `REMOVED` | Fuera de scope |
| `OTHER` | Estado original sin mapeo |

El valor original Azure se conserva en `state_original`. Un Work Item `Done` de Azure **no** se mapea a `PRODUCTION` salvo política explícita **y** evidencia de deployment. Por defecto `Done` → `DEV_DONE`.

## Plantillas de ejemplo

Ver `config/tl-control.example.json` para Agile, con comentarios equivalentes para Scrum (`Committed`, `Approved`) y Basic (`To Do`, `Doing`, `Done`).
