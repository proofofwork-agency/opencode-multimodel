import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

test("source modules stay small", () => {
  const files = readdirSync(SRC).filter((name) =>
    name.endsWith(".ts") || name.endsWith(".tsx")
  );
  const oversized = files.flatMap((name) => {
    const path = join(SRC, name);
    if (!statSync(path).isFile()) return [];
    const lines = readFileSync(path, "utf8").split("\n").length;
    return lines > 1_200 ? [`${name}:${lines}`] : [];
  });
  expect(oversized).toEqual([]);
});
