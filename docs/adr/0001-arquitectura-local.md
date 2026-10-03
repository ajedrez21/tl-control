# ADR 0001 — Arquitectura local de TL Control

**Fecha:** 2026-10-03  
**Estado:** aceptado

## Contexto

El repositorio estaba vacío salvo la especificación. Se necesita un sistema personal, local y bajo demanda para que el Tech Lead analice backlog, controle el sprint y vea el estado real del equipo, sin SaaS ni autenticación multiusuario.

## Decisión

- **Runtime:** Node.js 22+ (fijado en `package.json` engines) y TypeScript 5.9.
- **Persistencia:** `node:sqlite` (`DatabaseSync`). Evita binarios nativos en Windows. Es experimental en Node 22; el ADR se revisará si la API cambia. SQLite es cache e historial, no sustituye Azure.
- **Servidor:** HTTP nativo (`node:http`) enlazado a `127.0.0.1` por defecto.
- **Dashboard:** HTML/CSS/JS propio, sin CDN. Los reportes congelados incrustan CSS.
- **Validación de contratos:** Ajv 8 + JSON Schema `team-ai/v1`.
- **Canonicalización:** algoritmo compatible con RFC 8785/JCS para objetos JSON emitidos por el sistema (ver `docs/fingerprint.md`).
- **Azure:** adaptador REST oficial (`api-version=7.1`) con PAT/env. El MCP de Microsoft (`@azure-devops/mcp`) se usa desde el host LLM (skills), no desde el navegador. Escrituras deshabilitadas por defecto.
- **IA:** el LLM del host (Cursor/Claude) interpreta evidencia; el CLI calcula métricas, persiste y valida.

## Límites

- No hay scheduler, MCP propio, ni motor de LLM embebido.
- No se crean/alteran/ejecutan Stored Procedures.
- No se publican Work Items a Azure salvo operación explícita con `writes.enabled=true`.
- Fuentes ausentes se marcan `NOT_AVAILABLE`, nunca como éxito vacío.
- Datos privados (`data/`, reportes reales, config local) quedan fuera de Git.

## Capacidades MCP comprobadas (local server, docs/TOOLSET.md, 2026-10-03)

Disponibles y útiles para skills: work items (`get`, `get_batch`, `list_comments`, `list_revisions`, `list_for_iteration`, comments, attachments), WIQL, PRs, files, builds/pipelines.

No asumir deployments de release como cubiertos por MCP: el adaptador REST de Release/Environments es independiente y puede devolver `NOT_AVAILABLE`.
