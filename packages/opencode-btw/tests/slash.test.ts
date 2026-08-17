import { expect, test } from "bun:test";
import { btwSlashQuestion } from "../src/slash.ts";

test("extracts /btw and /side questions from a TUI submit line", () => {
  expect(btwSlashQuestion("hello")).toBeUndefined();
  expect(btwSlashQuestion("/goal pause")).toBeUndefined();
  expect(btwSlashQuestion("/btw")).toBe("");
  expect(btwSlashQuestion("/side")).toBe("");
  expect(btwSlashQuestion("/btw why this helper?")).toBe("why this helper?");
  expect(btwSlashQuestion("/SIDE  what changed")).toBe("what changed");
});
