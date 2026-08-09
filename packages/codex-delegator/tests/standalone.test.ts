import { expect, test } from "bun:test";
import path from "node:path";

test("runtime source and manifest contain no Poly or Headless dependency", async () => {
  const files = [
    "package.json",
    ...Array.from(
      new Bun.Glob("src/**/*.ts").scanSync({
        cwd: path.dirname(import.meta.dir),
      }),
    ),
  ];
  const root = path.dirname(import.meta.dir);
  const references = await Promise.all(
    files.map(async (file) => ({
      file,
      text: await Bun.file(`${root}/${file}`).text(),
    })),
  );
  expect(
    references.filter((item) => /headless|@poly|POLY_|poly\//i.test(item.text)),
  ).toEqual([]);
});
