import type { PluginModule } from "@opencode-ai/plugin";
import { createCodexDelegatePlugin } from "./plugin.ts";

export default {
  id: "opencode-codex-delegate",
  server: createCodexDelegatePlugin(),
} satisfies PluginModule;
