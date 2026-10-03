---
name: tl-security-status
description: Importa y muestra reportes de seguridad existentes sin modificar el auditor. Usar con /security-status.
---

# /security-status

## Procedimiento

1. Mostrar: `npx tsx src/cli/index.ts security-status`
2. Importar: `npx tsx src/cli/index.ts security-status --import <file.json> --gate`
3. No ejecutar el auditor ni remediar.
4. Distinguir gate vigente (`current_gate`) de última evidencia histórica.
5. `NOT_AVAILABLE` / `STALE` / `FAIL` nunca se muestran como PASS.

## Salidas

Reportes y findings. Referencias relativas, no comandos del JSON.
