# Third-party notices

The confined workflow runtime was designed against the public behavior and
security model of OpenCode's `@opencode-ai/codemode` package. OpenCode is
Copyright SST and contributors and is licensed under the MIT License.

No Node/Bun evaluator is used. `opencode-multimodel` contains its own small
parser and tree-walking evaluator for the six documented workflow primitives.
The package's MIT `LICENSE` applies to that implementation.
