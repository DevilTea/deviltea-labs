# EF Implementation Decisions

Status: Accepted

## Purpose

This document records implementation decisions for the first EF CLI and its
companion Agent Skills. It is planning input rather than an authorization to
begin implementation.

No runtime source is to be added until the remaining implementation plans have
been written and reviewed. Those plans must cover architecture, delivery
milestones, validation and test fixtures, package and release verification, and
the detailed Skill workflows listed at the end of this document.

The accepted EF Core specifications remain normative. If a decision here
conflicts with an accepted Core requirement, the conflict must be resolved in
the specification before the affected runtime behavior is implemented.

## Product and Package Boundary

- The npm package name is `@deviltea/ef`.
- The installed executable name is `ef`.
- The package is ESM-only and is built with `tsdown` for the Node.js platform,
  targeting ES2022.
- The package exposes the executable through
  `bin: { "ef": "./dist/cli.mjs" }` and retains a Node.js shebang.
- Supported Node.js versions match the workspace baseline:
  `^22.14.0 || ^24.0.0`.
- macOS, Linux, and Windows are supported through the Node.js npm executable.
  EF v1 does not publish standalone native executables.
- The experimental `tsdown` single-executable mode is not used.
- EF v1 promises the CLI and its documented machine-readable contracts. It
  does not initially expose a supported JavaScript library API.
- One package contains the CLI and internal modules. Internal architecture
  boundaries do not imply independently published packages.
- Core read-only commands perform no telemetry, update checks, or other network
  access.

## Internal Architecture

The initial package uses these logical boundaries:

```text
src/
├── cli/             argument parsing, output transport, and exit codes
├── application/     validation, query, and mutation use cases
├── domain/          Artifacts, relations, lifecycle, and diagnostics
├── parsing/         frontmatter, YAML, Markdown, and source positions
├── repository/      discovery, filesystem access, and Resources
├── git/             Git execution and commit-tree materialization
└── platform/        write primitives, signals, and terminal capabilities
```

- Domain and application code return typed results and do not call
  `process.exit()`.
- Human and JSON rendering are separate adapters over the same application
  results.
- Diagnostic ownership, deduplication, precedence, and deterministic ordering
  are centralized rather than reproduced in individual validators.
- Derived caches are deferred until the uncached implementation is correct and
  its behavior is covered by contract tests.

## Runtime Dependencies

Use these libraries:

- `pathe` for internal lexical path composition and normalized `/` separators;
- `yaml` for YAML 1.2 documents, CST/AST access, duplicate-key detection,
  ordering, and source positions;
- `mdast-util-from-markdown`, `micromark-extension-gfm`, and `mdast-util-gfm`
  for GitHub Flavored Markdown AST construction and source positions;
- `commander` for command and option parsing; and
- `@clack/prompts` for interactive human-mode prompts.

Do not use a generic runtime-schema library as the primary validator. EF needs
complete diagnostic aggregation, stable diagnostic ownership, exact field
locations, and suppression of dependent findings. Implement small typed
decoders and validators over the retained YAML and Markdown syntax trees.

Frontmatter boundary detection is an EF-owned parser step. Do not use a
frontmatter convenience library that discards syntax-tree positions or silently
normalizes invalid input.

## Text, Unicode, and Paths

`pathe` is a lexical utility, not a containment or filesystem-security
boundary. Path handling follows this sequence:

1. validate the original serialized value and reject forbidden backslashes,
   drive letters, UNC forms, empty segments, `.`, `..`, colons, and
   tilde-prefixed segments as applicable;
2. normalize the accepted serialized value to Unicode NFC;
3. compose internal paths with `pathe`;
4. use `lstat` on every applicable existing component and reject symlinks; and
5. emit project-relative paths with `/` separators only.

Normalization must not erase evidence needed to diagnose an invalid serialized
path.

- Diagnostic columns count one-based Unicode scalar values, not JavaScript
  UTF-16 code units.
- Canonical bytewise ordering compares UTF-8 bytes and does not use
  locale-sensitive collation.
- Text readers preserve original bytes long enough to diagnose BOM, invalid
  UTF-8, CRLF, missing final newline, and Unicode normalization violations.
- `ef resource read` writes the selected Resource as raw bytes without text
  decoding or an added newline.

## Git Execution

EF uses the Git executable installed in the user's environment. It does not
embed a Git implementation and does not use `simple-git` in Core v1.

The Core requirements primarily need Git plumbing commands, binary or
NUL-delimited output, exact exit status, and explicit commit-tree
materialization. A general porcelain-oriented wrapper would still require raw
commands and custom parsing while adding another error and task-queue layer.

Implement a narrow typed adapter with operations such as:

```ts
interface GitRepository {
	findWorktreeRoot(path: string): Promise<string>
	getObjectFormat(): Promise<'sha1' | 'sha256'>
	resolveCommit(oid: string): Promise<ResolvedCommit>
	readTree(oid: string): Promise<GitTree>
	listFirstParentHistory(oid: string): Promise<string[]>
	diffTrees(before: string, after: string): Promise<GitTreeDiff>
}
```

One internal executor uses `node:child_process.spawn` with an argument array and
`shell: false`. It returns stdout and stderr as separate buffers together with
the exit code and terminating signal. It owns cancellation, child cleanup,
output limits, executable-unavailable errors, and safe command logging.

Git invocation policy includes:

- never pass user-controlled arbitrary Git options;
- set `GIT_TERMINAL_PROMPT=0`;
- disable paging;
- request stable English diagnostics where diagnostic text must be inspected;
- prevent replace objects from changing commit materialization;
- prefer `-z` output and parse bytes instead of quoted or localized paths;
- separate option arguments from path arguments with `--` where applicable;
- support both SHA-1 and SHA-256 repository object formats; and
- detect required Git capabilities at runtime instead of trusting a version
  string alone.

Core v1 validation does not update the authoritative branch. If publication is
implemented later, compare-and-swap behavior must use an explicit Git primitive
such as `update-ref` with both expected old and proposed new OIDs.

## Filesystem Publication Decision

The accepted CLI contract currently requires atomic, create-if-absent
publication of a complete `.engineering` directory. Portable Node.js does not
expose one directory primitive with identical no-replace semantics on macOS,
Linux, and Windows.

Before `ef init` is implemented, amend or clarify the Core contract to use this
portable ownership protocol:

1. atomically claim `.engineering` with non-recursive `mkdir`;
2. create a runtime initialization marker under the claimed directory;
3. write and validate the complete bootstrap content;
4. remove the marker only after successful completion; and
5. on failure, remove only paths proven to belong to that invocation.

The command never overwrites or merges with a pre-existing `.engineering`
path. A crash may leave a recognizable incomplete initialization, so concurrent
observers are not guaranteed to see only the absent or complete state. A later
command must report that state and must not silently repair or delete it.

This is an intentional portability trade-off. If strict all-or-nothing
directory visibility remains normative, implementation must instead plan and
ship platform-specific native no-replace rename support before mutation work
begins.

For single-file Artifact creation, the implementation plan must select and
verify a cross-platform create-if-absent publication mechanism separately. A
normal replacing rename is not acceptable.

## CLI Behavior

- The Core v1 command surface remains exactly the accepted CLI contract.
- Human output is English-only in v1; localization is deferred.
- JSON output is independent of TTY state and contains no ANSI sequences,
  prompts, progress text, or incidental logs.
- Once a machine envelope kind can be selected, operational failures are
  represented in that envelope as required by the Core contract.
- Unknown syntax that prevents selecting an envelope writes no stdout and
  reports the invocation error on stderr.
- Signal and cancellation behavior must be planned explicitly before CLI
  implementation.
- The four Core exit codes are mapped only at the CLI boundary.

## Testing and Verification

Follow the workspace conventions:

- colocate Vitest unit tests as `*.unit.test.ts` beside runtime source;
- use the workspace TypeScript, ESLint, tsdown, and Vitest configurations;
- add EF runtime sources to the root V8 coverage include list;
- preserve the global 90% coverage thresholds without treating coverage as a
  substitute for behavioral assertions;
- run package typecheck and the narrowest relevant unit tests while iterating;
  and
- run `publint` plus a packed-package consumer test before release.

Contract and platform testing must include:

- installing the output of `pnpm pack` and invoking the installed `ef` binary;
- exact stdout, stderr, JSON shape, trailing newline, and exit-code assertions;
- byte-for-byte `resource read` assertions;
- SHA-1 and SHA-256 Git fixtures;
- shallow history, detached HEAD, linked worktrees, and undeclared nested
  worktrees;
- symlink rejection, case collisions, and NFC/NFD filenames;
- concurrent Artifact creation and initialization interruption cases; and
- CI execution on Ubuntu, macOS, and Windows with supported Node.js versions.

Broad snapshots of third-party parser or Git output are not sufficient. Tests
assert EF contracts and include cases that distinguish plausible but incorrect
implementations.

## Agent Skills

Agent Skills are a workflow layer over the deterministic CLI. They do not
reimplement EF parsing, validation, graph traversal, or mutation logic, and
they do not duplicate the complete Core specifications in prompt context.

The initial Skill set contains:

### `author-engineering-files`

This Skill covers project initialization, context discovery, draft Artifact
authoring, CHG planning, snapshot validation, and correction of deterministic
diagnostics.

It must:

- query before loading or changing broad context;
- distinguish drafts from canonical truth;
- require human decisions for accepted terminology and engineering decisions;
- show the intended mutation before applying it; and
- finish authored working-tree changes with explicit snapshot validation.

### `review-engineering-change`

This Skill covers transition review, impact and history queries,
supersession inspection, and explanation of deterministic diagnostics.

It must:

- remain read-only;
- require explicit baseline and proposed commit OIDs;
- never checkout, publish, or update a branch;
- distinguish snapshot success from transition validation; and
- never substitute LLM judgment for a required Core validator result.

Skill source lives under:

```text
packages/ef/skills/
├── author-engineering-files/
└── review-engineering-change/
```

Skills use the portable `SKILL.md` structure and may include platform-specific
optional metadata. Their detailed command references use progressive
disclosure rather than expanding the primary `SKILL.md` body.

Skills ship in the npm tarball and the GitHub repository under the same release
tag as the CLI. Installing the npm CLI does not implicitly install or mutate an
agent's Skill directory. Core v1 does not add an `ef skill install` command;
users install the Skill directories through an existing compatible Skill
installer.

Tests or static checks must verify that commands and flags referenced by Skills
exist in the matching CLI version.

## Implementation Planning Gate

Implementation begins only after the following planning documents have been
written and reviewed:

1. architecture and module dependency plan;
2. parser, source-location, and diagnostic pipeline plan;
3. filesystem discovery and safe-publication plan, including resolution of the
   `init` contract conflict;
4. Git materialization and transition-validation plan;
5. CLI transport, interaction, cancellation, and error-mapping plan;
6. query and Resource-read plan;
7. fixture, unit, contract, package, and cross-platform CI test plan;
8. release, npm contents, provenance, and compatibility plan; and
9. concrete Skill workflows, trigger examples, references, and forward-test
   scenarios.

Planning may use prototypes or isolated feasibility spikes when a platform
claim cannot be established by documentation alone. Such work must remain
outside published runtime source and must not be presented as product
implementation.
