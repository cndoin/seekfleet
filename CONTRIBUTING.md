# Contributing to SeekFleet

Thanks for your interest in contributing! This project welcomes issues,
feature requests, bug reports, documentation improvements, and pull requests.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
By participating you agree to its terms.

## Development Setup

Requirements:

- Node.js >= 20 (see `.nvmrc`)
- npm >= 10 (or pnpm >= 9)
- `@deepseek-ai/dsh` installed somewhere reachable via `DSH_MODULE_ROOT` or in
  your project's `node_modules`

Setup:

```bash
git clone REPOSITORY_URL seekfleet
cd seekfleet
npm install
npm run build
```

## Project Layout

```
src/                 TypeScript source, builds to dist/
  mcp-server.ts      MCP stdio server (entry: serveMcp)
  dsh-client.ts      Single-instance subprocess wrapper
  dsh-cluster.ts     Multi-instance orchestrator
  adaptive-router.ts Scoring-based instance selection
  circuit-breaker.ts Per-instance failure isolation
  result-cache.ts    Task-level result memoization
  cost-tracker.ts    Token / cost accounting
  auto-scaler.ts     Queue-depth driven scaling
  task-dag.ts        DAG executor (dsh_dag_run)
  workspace-sync.ts  File sharing between instances
  replay-recorder.ts Event stream recording
  capability-registry.ts  Instance self-reporting
  metrics.ts         Prometheus / JSON metrics
  harness-sdk.ts     DshPlugin (single import for hermes / openclaw / Codex)
  index.ts           Public API entry
bin/                 CLI source
examples/            Runnable demos for hermes / openclaw / Codex / cluster
tests/               Vitest unit tests
dist/                Built artifacts (gitignored)
```

## Scripts

| Script | What it does |
|--------|---------------|
| `npm run build` | TypeScript -> dist/ |
| `npm test` | Run Vitest test suite |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run inspect` | Print SDK + dsh capabilities |
| `npm run serve-mcp` | Start the MCP server |
| `npm run demo` | Run `examples/cluster-demo.mjs` |

## Coding Standards

- TypeScript strict mode; prefer explicit types over `any`
- ESM only; use `.js` import paths even in `.ts` files
- Use existing dependencies before adding new ones (justify in PR description)
- Never log to `stdout` from `serve-mcp`; use `console.error`
- New MCP tools must declare `title`, `description`, `inputSchema` (Zod), and `annotations`
- New public SDK methods must be exported from `src/index.ts` with proper TSDoc

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`.

Examples:

- `feat(cluster): add adaptive scoring-based router`
- `fix(codex-config): replace broken regex literal with new RegExp`
- `docs(readme): add codex adapter section`
- `chore(deps): bump zod to 3.24`

## Pull Request Process

1. Fork the repository and create your branch from `main`
2. Run `npm run typecheck && npm test && npm run lint` - all must pass
3. If your change adds a public API, add an example under `examples/`
4. If your change is user-visible, update `README.md` and `CHANGELOG.md`
5. Open the PR against `main`. Fill in the PR template completely.
6. A maintainer will review within 7 days. Squash-merge once approved.

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Exact steps to reproduce (ideally a `node` one-liner)
- Expected vs actual behavior
- `node --version`, OS, `npm ls @deepseek-ai/dsh seekfleet`
- Relevant stderr / logs (no API keys!)

## Suggesting Features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
Explain the use case before the implementation.

## Release Process

Maintainers cut a release by:

1. Bumping `version` in `package.json` (SemVer)
2. Moving the `[Unreleased]` block in `CHANGELOG.md` to a dated section
3. Tagging the commit (`git tag v0.x.y`); CI publishes to npm + creates a GitHub release
