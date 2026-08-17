import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: [
    "src/server.ts",
    "src/tui.tsx",
    "src/index.ts",
    "src/workflow-api.ts",
  ],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
});

if (!result.success) {
  result.logs.forEach((log) => console.error(log));
  process.exit(1);
}
