import { describe, expect, test } from "bun:test";
import {
  appendTrace,
  detectPureCycle,
  detectToolLoop,
  toolFingerprints,
  MAX_TOOL_TRACE,
} from "../src/trajectory.ts";

describe("detectPureCycle", () => {
  test("detects a repeated single tool call", () => {
    const trace = ["grep: foo", "grep: foo", "grep: foo"];
    const pattern = detectPureCycle(trace);
    expect(pattern).toEqual({
      kind: "repeat",
      fingerprint: "grep: foo",
      count: 3,
    });
  });

  test("detects a period-2 ping-pong", () => {
    const trace = [
      "grep: A",
      "read: b.ts",
      "grep: A",
      "read: b.ts",
      "grep: A",
      "read: b.ts",
    ];
    const pattern = detectPureCycle(trace);
    expect(pattern?.kind).toBe("cycle");
    if (pattern?.kind === "cycle") {
      expect(pattern.fingerprints).toEqual(["grep: A", "read: b.ts"]);
      expect(pattern.count).toBe(6);
    }
  });

  test("detects a period-3 cycle", () => {
    const trace = [
      "shell: npm build",
      "shell: npm test",
      "edit: fix.ts",
      "shell: npm build",
      "shell: npm test",
      "edit: fix.ts",
    ];
    const pattern = detectPureCycle(trace);
    expect(pattern?.kind).toBe("cycle");
    if (pattern?.kind === "cycle") {
      expect(pattern.fingerprints).toEqual([
        "shell: npm build",
        "shell: npm test",
        "edit: fix.ts",
      ]);
    }
  });

  test("no cycle for varied tool usage", () => {
    const trace = [
      "grep: auth",
      "read: login.ts",
      "edit: login.ts",
      "shell: npm test",
      "grep: session",
      "read: session.ts",
    ];
    expect(detectPureCycle(trace)).toBeUndefined();
  });

  test("no cycle below the minimum entries", () => {
    expect(detectPureCycle(["grep: A", "grep: A"])).toBeUndefined();
  });
});

describe("detectToolLoop progress exemption", () => {
  const pingPong = [
    "grep: A",
    "grep: B",
    "grep: A",
    "grep: B",
    "grep: A",
    "grep: B",
  ];

  test("loops when output matches the last checkpoint (frozen)", () => {
    const detection = detectToolLoop({
      toolTrace: pingPong,
      checkpoints: ["same output"],
      currentTranscript: "same output",
    });
    expect(detection?.description).toContain("Repeated tool cycle");
    expect(detection?.description).toContain("grep: A -> grep: B");
  });

  test("exempts when current output differs from the last checkpoint", () => {
    const detection = detectToolLoop({
      toolTrace: pingPong,
      checkpoints: ["iteration 2: tests 2/12 passing"],
      currentTranscript: "iteration 3: tests 3/12 passing",
    });
    expect(detection).toBeUndefined();
  });

  test("exempts without checkpoint evidence yet", () => {
    const detection = detectToolLoop({
      toolTrace: pingPong,
      checkpoints: [],
      currentTranscript: "some output",
    });
    expect(detection).toBeUndefined();
  });

  test("exempts legitimate iteration with evolving checkpoints", () => {
    const detection = detectToolLoop({
      toolTrace: [
        "shell: npm build",
        "shell: npm test",
        "edit: fix.ts",
        "shell: npm build",
        "shell: npm test",
        "edit: fix.ts",
      ],
      checkpoints: [
        "build failed with type error in parser",
        "tests 11/12 passing, login regression",
        "tests 12/12 passing",
      ],
      currentTranscript: "tests 12/12 passing",
    });
    expect(detection).toBeUndefined();
  });
});

describe("toolFingerprints", () => {
  test("extracts name and arg snippet from tool parts", () => {
    const fingerprints = toolFingerprints({
      parts: [
        { type: "text", text: "thinking" },
        { type: "tool", tool: "bash", args: { command: "ls -la" } },
        { type: "tool-call", toolName: "read", input: { path: "/tmp/a.ts" } },
      ],
    });
    expect(fingerprints).toEqual([
      'bash: {"command":"ls -la"}',
      'read: {"path":"/tmp/a.ts"}',
    ]);
  });

  test("ignores non-tool turns", () => {
    expect(toolFingerprints({ parts: [{ type: "text", text: "hi" }] }))
      .toEqual([]);
  });
});

describe("appendTrace", () => {
  test("bounds the trace to the ring size", () => {
    let trace: string[] = [];
    for (let index = 0; index < MAX_TOOL_TRACE + 10; index += 1) {
      trace = appendTrace(trace, [`tool: ${index}`]);
    }
    expect(trace.length).toBe(MAX_TOOL_TRACE);
    expect(trace.at(-1)).toBe(`tool: ${MAX_TOOL_TRACE + 9}`);
  });
});
