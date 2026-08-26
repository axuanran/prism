# ADR 0013: TypeScript 7 compiles Prism while TS6 serves legacy tooling APIs

**Status:** Accepted and implemented

## Context

TypeScript 7.0.2 is the stable native Go compiler. It does not expose the programmatic Compiler API shipped by earlier releases. Prism itself only invokes the compiler through `tsc`, but two tools still require the old API:

- `typescript-eslint` imports `typescript` directly and currently rejects TS7;
- the architecture test parses imports with `createSourceFile` and `forEachChild` (`test/architecture.test.ts`).

Combining the compiler migration with business/runtime changes would make a failure ambiguous. This migration therefore changes only compiler/tooling dependencies, scripts, CI parallelism, and the architecture test's API source.

## Decision

The workspace uses the official side-by-side alias layout:

```json
{
  "@typescript/native": "npm:typescript@7.0.2",
  "typescript": "npm:@typescript/typescript6@6.0.2"
}
```

`@typescript/native` supplies the `tsc` executable, so `pnpm build` and `pnpm typecheck` run TypeScript 7.0.2. The `typescript` module resolves to the TS6 compatibility API for `typescript-eslint` and the AST-based architecture test. Runtime packages do not depend on either compiler.

Local builds retain TS7's automatic parallelism. CI fixes `--checkers 2 --builders 2` through `build:ci` and `typecheck:ci`, making worker allocation reproducible without forcing slower local defaults (`package.json`, `.github/workflows/ci.yml`). Single-threaded, fixed-worker, and default-worker builds all produce the same diagnostics.

No strictness option was reduced. The migration added no `@ts-ignore`, `@ts-nocheck`, `any`, skipped tests, or business/runtime change. `@types/node` moved from 22 to the pinned Node 24 line, 24.13.3.

## Evidence

Measured on this repository, from clean TS build state:

| Gate | TypeScript 5.9.3 | TypeScript 7.0.2 | Result |
|---|---:|---:|---:|
| `tsc --build` | 3.795 s | 1.039 s | 3.65× faster |
| test-file `tsc` | 2.191 s | 0.790 s | 2.77× faster |
| Vitest with real PostgreSQL | 5.985 s | 6.257 s | runtime-test noise; not a compiler benchmark |
| Studio build | 4.475 s | 4.062 s | 1.10× faster |

The semantic gate stayed constant: 17 test files and 197 tests, including real PostgreSQL 17 persistence, cross-engine recovery, Decimal JSONB properties, revision triggers, migration journal, RunPin replay checks, and Studio build.

## Consequences

- Prism gets the native compiler speedup without waiting for every Compiler API consumer to support TS7.
- Two TypeScript versions coexist only in development tooling. This is intentional compatibility, not a runtime dependency or architecture debt.
- `pnpm exec tsc --version` must report 7.0.2; `require("typescript").version` reports the TS6 compatibility API.
- Directly executing `node_modules/.bin/tsc` is not portable on Windows because TS7 is a native binary; scripts invoke it through pnpm.
- When `typescript-eslint` supports the TS7 API, the TS6 alias can be removed after the architecture test migrates to the future native API or another parser.

## Cost to reverse

Returning to the JavaScript compiler requires changing the two aliases, CI flags, scripts, and this decision. Removing the TS6 compatibility API today would break lint and AST-based architecture enforcement, not Prism runtime code.
