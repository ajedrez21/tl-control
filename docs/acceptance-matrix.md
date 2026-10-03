# Matriz TL-AC01 → TL-AC20

Fecha: 2026-10-03. Ejecución: `npx tsx --test tests/acceptance.test.ts` (24 pass).

| ID | Resultado | Evidencia | Pendiente |
|---|---|---|---|
| TL-AC01 | PASS | doctor + seed demo sin PAT | Autorización real Azure |
| TL-AC02 | PASS | persistWorkItems repetido, 1 WI y 1 relación | — |
| TL-AC03 | PASS | mock 403 comments → UNAUTHORIZED, WIs conservados | Paginación real de un tenant |
| TL-AC04 | PASS | 4102 evidencia INFERRED + pregunta | — |
| TL-AC05 | PASS | readiness BLOCKED; contrato UNKNOWN sin firma | — |
| TL-AC06 | PASS | análisis stale al cambiar SHA | Repo local real del equipo |
| TL-AC07 | PASS | drafts UNASSIGNED, títulos no genéricos | — |
| TL-AC08 | PASS | preview fields/relations; rev distinta = conflicto | Escritura Azure no ejecutada (writes.enabled=false) |
| TL-AC09 | PASS | baseline fijo; +1 alta −1 baja + carry-over | — |
| TL-AC10 | PASS | unidad historias y fuente en scope | Verificación visual dashboard |
| TL-AC11 | PASS | Done+merge+build ≠ PROD; 4114 sí; partial/rollback visibles | Pipelines reales |
| TL-AC12 | PASS | release_work_items con pantallas | — |
| TL-AC13 | PASS | schema, duplicado no importa, versión desconocida rechazada | — |
| TL-AC14 | PASS | gate vigente FAIL vs reporte STALE histórico | — |
| TL-AC15 | PASS | HTML congelado no cambia tras UPDATE | — |
| TL-AC16 | PASS | sanitize-html + assertInsideDir | — |
| TL-AC17 | PASS visual | Home, historia 4102 (tabs/evidencia), SP y Releases en http://127.0.0.1:4780 | — |
| TL-AC18 | PASS | example.json sin credenciales | No commitear `config/tl-control.json` ni `data/` |
| TL-AC19 | PASS | backup/restore reproduce métricas | — |
| TL-AC20 | PASS | sync-403 PR/deploy UNAUTHORIZED ≠ OK | MCP/deploy real si el tenant lo permite |

Integración Azure end-to-end: **no validada** (sin PAT/org reales en esta corrida). Adaptador REST + tests mock sí.
