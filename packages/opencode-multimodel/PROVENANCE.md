# Confined interpreter provenance

The implementation in `src/script.ts` is an original, purpose-limited
tree-walking interpreter created for this plugin. Its allowed-capability model,
bounded host calls, and data-only interpreter boundary are derived from the
MIT-licensed OpenCode CodeMode design in
`packages/codemode/src/interpreter/runtime.ts` as inspected from the OpenCode
1.18.15 source tree. No source file from CodeMode is copied verbatim.

The interpreter accepts one JavaScript/TypeScript-style expression (optionally
wrapped in an `export default` arrow function) and exposes only `args`,
`agent`, `parallel`, `pipeline`, `phase`, and `log`.
