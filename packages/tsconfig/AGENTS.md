# AGENTS.md

## Package scope

`@deviltea/tsconfig` publishes TypeScript 6 JSON presets. The JSON files are the product: no build step should transform them. Public consumers extend `strict`, `neutral`, `browser`, `node-bundler`, `node`, or `tooling`; `tsconfig._bundler.json` is an internal shared layer and is deliberately not exported.

```
tsconfig.*.json              # Distributed presets and internal shared layer
scripts/test-contracts.mjs   # Packed-consumer TypeScript integration contracts
```

## Commands

```bash
pnpm --filter @deviltea/tsconfig run test:contracts
pnpm --filter @deviltea/tsconfig run lint
pnpm --filter @deviltea/tsconfig run validate
```

This JSON-only package does not participate in Vitest or root coverage reporting. `test:contracts` is the product validation: it packs the package, installs it in isolated consumers, and proves TypeScript accepts and rejects real programs.

## Preset and test rules

- Preserve exact subpath exports and keep `./_bundler` private. A new preset is a public API change and requires export, documentation, and consumer-contract review.
- Preserve inheritance boundaries: neutral/browser/node-bundler/tooling extend the bundler layer; native `node` extends `strict` and uses `NodeNext` resolution.
- Ambient libraries/types are policy, not incidental defaults. In particular, neutral and browser deliberately have `types: []`; browser has `DOM` but not an accidental Node environment; node variants explicitly opt into Node types.
- Keep exact public-export, inheritance, and ambient-type boundaries under compiler contract validation. Tests must include both programs expected to pass and programs expected to fail, so plausible configuration drift is rejected; do not use coverage as a substitute for these assertions.
- Never weaken compiler contracts merely to make a preset appear broadly compatible.

## Gotchas

- This is a package in the root pnpm workspace; versions are maintained in the root catalog and this package has no local lockfile.
- The supported TypeScript peer range is `>=6.0.0 <7.0.0`; update the explicit TypeScript version in the contract command only as part of an intentional compatibility review.
