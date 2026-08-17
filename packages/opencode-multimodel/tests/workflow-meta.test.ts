import { describe, expect, test } from "bun:test";
import {
  coerceWorkflowArgs,
  extractWorkflowMeta,
  isModuleWorkflowSource,
  parseWorkflowArgs,
  validateModuleWorkflowSource,
} from "../src/workflow-meta.ts";

const sample = `
import { workflow } from "opencode-multimodel/workflow"

export default workflow({
  name: "release",
  description: "Draft notes",
  whenToUse: "Cutting a release",
  phases: ["collect", { title: "draft", model: "openai/gpt-5.2" }],
  arguments: {
    version: { type: "string", description: "Version", default: "next" },
    dry: { type: "boolean", default: false },
  },
  async run(args, ctx) {
    return ctx.agent({ prompt: args.version })
  },
})
`;

describe("TypeScript workflow metadata", () => {
  test("detects and extracts a workflow() module", () => {
    expect(isModuleWorkflowSource(sample)).toBe(true);
    expect(extractWorkflowMeta(sample)).toMatchObject({
      name: "release",
      description: "Draft notes",
      whenToUse: "Cutting a release",
      phases: ["collect", { title: "draft", model: "openai/gpt-5.2" }],
      arguments: {
        version: { type: "string", default: "next" },
        dry: { type: "boolean", default: false },
      },
    });
  });

  test("rejects host imports and process access", () => {
    expect(() =>
      validateModuleWorkflowSource(
        `import fs from "node:fs"\nexport default workflow({ name: "x", async run() {} })`,
      )
    ).toThrow("only import");
    expect(() =>
      validateModuleWorkflowSource(
        `import { workflow } from "opencode-multimodel/workflow"\nprocess.exit(1)`,
      )
    ).toThrow("may not use");
  });

  test("parses name=value arguments and coerces declared types", () => {
    expect(parseWorkflowArgs(`version="1.4.0" dry=true`)).toEqual({
      version: "1.4.0",
      dry: "true",
    });
    expect(parseWorkflowArgs("ship the notes")).toEqual({
      input: "ship the notes",
    });
    expect(coerceWorkflowArgs({
      version: { type: "string" },
      dry: { type: "boolean", default: false },
      count: { type: "number", default: "2" },
    }, { version: "1.4.0", dry: "true" })).toEqual({
      version: "1.4.0",
      dry: true,
      count: 2,
    });
  });
});
