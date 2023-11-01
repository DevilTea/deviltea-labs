# `@deviltea/tsconfig`

> Forked from [`@vue/tsconfig`](https://github.com/vuejs/tsconfig)

TSConfigs for projects to extend.

Requires TypeScript >= 5.0.4

Install:

```sh
npm add -D @deviltea/tsconfig
```

Add one of the available configurations to your `tsconfig.json`:

The base configuration (runtime-agnostic):

```json
"extends": "@deviltea/tsconfig/tsconfig.json"
```

Configuration for Browser environment:

```json
"extends": "@deviltea/tsconfig/tsconfig.dom.json"
```

Configuration for Node environment:

```json
"extends": "@deviltea/tsconfig/tsconfig.node.json"
```
