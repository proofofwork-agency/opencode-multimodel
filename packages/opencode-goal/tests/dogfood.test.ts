import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveDogfoodBin } from "../src/dogfood.ts";

const resolvedBin = resolveDogfoodBin("/tmp/does-not-exist-as-a-project");

test.skipIf(!resolvedBin)(
  "resolves the Dogfood CLI from the plugin package, not the user project",
  () => {
    expect(resolvedBin).toBeDefined();
    expect(resolvedBin?.endsWith("bin/dogfood.mjs")).toBe(true);
    expect(existsSync(resolvedBin!)).toBe(true);
  },
);
