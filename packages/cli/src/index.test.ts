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
    const report = getDoctorReport("22.23.1");

    expect(report.nodeSupported).toBe(true);
    expect(report.lines).toEqual([
      "Node 22.23.1: OK",
      "Kubo: not configured; Meshkeep does not run external checks yet.",
    ]);
  });

  it.each([
    "22.23.1",
    "22.23.1+build.5",
    "22.23.2",
    "22.24.0",
  ])("accepts supported stable Node semver %s", (nodeVersion) => {
    expect(getDoctorReport(nodeVersion).nodeSupported).toBe(true);
  });

  it.each([
    "22.23.0",
    "22.22.99",
    "21.99.0",
    "23.0.0",
    "24.0.0",
  ])("rejects unsupported Node version %s", (nodeVersion) => {
    expect(getDoctorReport(nodeVersion).nodeSupported).toBe(false);
  });

  it.each([
    "22.23.1-rc.1",
    "22.24.0-pre.1",
  ])("rejects prerelease Node version %s", (nodeVersion) => {
    expect(getDoctorReport(nodeVersion).nodeSupported).toBe(false);
  });

  it.each([
    "22x",
    "22",
    "22.1",
    "v22.1.0",
    "022.1.0",
    "22.01.0",
    "22.1.0\n",
  ])("rejects malformed Node version %s", (nodeVersion) => {
    expect(getDoctorReport(nodeVersion).nodeSupported).toBe(false);
  });

  it("marks an unsupported doctor command unsuccessful through the injected setter", async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];

    await createProgram({
      nodeVersion: "22.23.0",
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      write: (message) => output.push(message),
    }).parseAsync(["node", "meshkeep", "doctor"]);

    expect(output).toEqual([
      "Node 22.23.0: requires Node >=22.23.1 <23",
      "Kubo: not configured; Meshkeep does not run external checks yet.",
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it("does not set an exit code for a supported doctor command", async () => {
    const exitCodes: number[] = [];

    await createProgram({
      nodeVersion: "22.23.1",
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      write: () => undefined,
    }).parseAsync(["node", "meshkeep", "doctor"]);

    expect(exitCodes).toEqual([]);
  });
});
