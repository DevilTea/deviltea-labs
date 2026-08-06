/**
 * Application layer barrel: validation, query, and mutation use cases.
 *
 * This module re-exports the public surface of each application-layer
 * submodule. It never defines logic of its own -- see the individual
 * modules for behavior and the accompanying specification files under
 * `docs/ef-core` for the normative rules each one implements.
 *
 * Internal helper modules consumed only by other application modules
 * (`./snapshot-raw-fields`, `./query-types`, `./query-projection`,
 * `./query-graph`, `./query-search`, `./query-history`, `./case-folding`,
 * `./case-folding-data`) are intentionally not re-exported here; `./query`
 * already curates the subset of their types a caller needs.
 */

export * from './artifact-create'
export * from './bootstrap-validation'
export * from './init'
export * from './query'
export * from './snapshot'
export * from './snapshot-validation'
export * from './transition-validation'
