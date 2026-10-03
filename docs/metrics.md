# Métricas

| Métrica | Fórmula | Unidad | Denominador | Fuente |
|---|---|---|---|---|
| Scope inicial | \|baseline ids\| | historias | — | `sprint_baselines` |
| Altas | eventos `added` | historias | — | `scope_events` |
| Bajas | eventos `removed` | historias | — | `scope_events` |
| Scope actual | inicial ∪ altas − bajas | historias | — | baseline + eventos |
| Crecimiento neto | (actual − inicial) / inicial; baseline 0 ⇒ N/A | ratio | scope inicial | idem |
| Carry-over | eventos `carry_over` | historias | — | `scope_events` |
| Por estado | COUNT historias por `state_normalized` | historias | sprint | `work_items` |
| Ready sin asignar | COUNT tasks READY sin assigned | tareas | sprint | `work_items` |
| Producción | COUNT historias con deploy success PROD | historias | sprint | `deployments` |
| Aging SP | días corridos bloqueado→asOf | días corridos | — | `dependencies.blocked_at` + timezone |

No mezclar puntos y conteos. Baseline no se recalcula con el scope actual.
