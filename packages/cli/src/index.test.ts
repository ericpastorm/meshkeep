import { describe, expect, it } from "vitest";

import { createProgram, getDoctorReport } from "./index.js";

describe("meshkeep CLI", () => {
  it("prints its version", async () => {
    const output: string[] = [];

    await createProgram({ write: (message) => output.push(message) }).parseAsync([
      "node",
      "meshkeep",
      "version",
    ]);

    expect(output).toEqual(["0.0.0"]);
  });

  it("reports Node and the unconfigured Kubo placeholder without external checks", () => {
    const report = getDoctorReport("22.20.0");

    expect(report.nodeSupported).toBe(true);
    expect(report.lines).toEqual([
      "Node 22.20.0: OK",
      "Kubo: not configured; Meshkeep does not run external checks yet.",
    ]);
  });
});
