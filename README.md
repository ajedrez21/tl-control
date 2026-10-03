# tl-control

Sistema **local** para que el Tech Lead analice backlog, controle el sprint y vea el estado real del equipo en un dashboard HTML. Azure DevOps es la fuente oficial de Work Items; SQLite es cache e historial.

Dataset demo: **ficticio e identificado**. No contiene un tenant real.

## Requisitos

- Node.js 22.13+
- Git (para anclar SHA de repos locales, opcional)

## Instalación

```bash
npm install
npx tsx src/cli/index.ts setup
npx tsx src/cli/index.ts doctor
```

Credenciales Azure: variable `AZURE_DEVOPS_EXT_PAT` o `AZURE_DEVOPS_PAT`. Nunca en el repo, ni en `config/tl-control.json`, ni en el dashboard.

## Primer uso (demo, sin Azure)

```bash
npx tsx src/cli/index.ts demo
npx tsx src/cli/index.ts dashboard --no-open
```

Abrí http://127.0.0.1:4780/

## Primer sync real

1. Completá `config/tl-control.json` (organización, proyecto, area/iteración, miembros, `stateMapping`).
2. Definí el PAT en el entorno.
3. `npx tsx src/cli/index.ts doctor`
4. `npx tsx src/cli/index.ts sync --iteration "<Iteration Path>"`
5. `npx tsx src/cli/index.ts analyze-story 3215`
6. `npx tsx src/cli/index.ts analyze-sp 3215`
7. `npx tsx src/cli/index.ts prepare-story 3215 --preview`
8. `npx tsx src/cli/index.ts dashboard`

Hasta no tener un 200 autenticado contra tu org, la integración Azure queda **pendiente de autorización**. El adaptador y los tests con HTTP mock sí están.

## Comandos

| Lógico | CLI |
|---|---|
| `/sync-sprint` | `sync --iteration` |
| `/analyze-story` | `analyze-story <id>` |
| `/analyze-sp` | `analyze-sp <id>` |
| `/prepare-story` | `prepare-story <id>` |
| `/daily-control` | `daily-control` |
| `/release-status` | `release-status` |
| `/security-status` | `security-status` |
| `/dashboard` | `dashboard` |
| `/close-sprint` | `close-sprint` |

También: `backup`, `restore`, `import-result`, `publish`.

## Backup

```bash
npx tsx src/cli/index.ts backup
npx tsx src/cli/index.ts restore data/backups/<archivo>.sqlite
```

Un restore debe poder regenerar las mismas métricas del snapshot.

## Arquitectura

Ver [docs/adr/0001-arquitectura-local.md](docs/adr/0001-arquitectura-local.md). Contratos `team-ai/v1` en `contracts/`. Fingerprints en [docs/fingerprint.md](docs/fingerprint.md).

## Seguridad del dashboard

- Bind `127.0.0.1`
- HTML de Azure sanitizado
- Adjuntos sin path traversal
- Escrituras POST requieren header `X-TL-Control: local` y origen loopback
- Sin tokens en JavaScript

## Tests

```bash
npm test
npm run build
```
