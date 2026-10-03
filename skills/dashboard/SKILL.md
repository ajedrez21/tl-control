---
name: tl-dashboard
description: Abre el dashboard HTML local de TL Control. Usar con /dashboard o cuando pidan la web de control del sprint.
---

# /dashboard

## Procedimiento

1. Si no hay datos: `npx tsx src/cli/index.ts demo`
2. `npx tsx src/cli/index.ts dashboard [--demo] [--no-open]`
3. Opcional: `--story 4101` `--release` `--sprint`
4. Bind loopback `127.0.0.1:4780`.
5. El botón Actualizar **no** sincroniza solo: muestra `tl-control sync --iteration ...`
6. No afirmar live sync si se mira un snapshot o reporte congelado.

## Salidas

URL local. No tokens en el navegador.
