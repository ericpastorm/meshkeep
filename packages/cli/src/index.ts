#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { VERSION } from "@meshkeep/protocol";
import { Command } from "commander";

export const MINIMUM_NODE_MAJOR = 22;

export interface DoctorReport {
  nodeSupported: boolean;
  lines: readonly string[];
}

export interface CliOptions {
  nodeVersion?: string;
  write?: (message: string) => void;
}

export function getDoctorReport(nodeVersion = process.versions.node): DoctorReport {
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  const nodeSupported = Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR;
  const nodeStatus = nodeSupported ? "OK" : `requires Node ${MINIMUM_NODE_MAJOR} or newer`;

  return {
    nodeSupported,
    lines: [
      `Node ${nodeVersion}: ${nodeStatus}`,
      "Kubo: not configured; Meshkeep does not run external checks yet.",
    ],
  };
}

export function createProgram(options: CliOptions = {}): Command {
  const write = options.write ?? console.log;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const program = new Command();

  program.name("meshkeep").description("Meshkeep command-line interface").version(VERSION);

  program
    .command("version")
    .description("Print the Meshkeep version")
    .action(() => write(VERSION));

  program
    .command("doctor")
    .description("Check local Meshkeep prerequisites without starting external processes")
    .action(() => {
      const report = getDoctorReport(nodeVersion);
      for (const line of report.lines) {
        write(line);
      }
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await runCli();
}
