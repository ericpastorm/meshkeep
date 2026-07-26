import { VERSION } from "@meshkeep/protocol";
import { Command } from "commander";

export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_VERSION = "22.23.1" as const;
export const SUPPORTED_NODE_RANGE = ">=22.23.1 <23" as const;

const STABLE_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MINIMUM_NODE_MINOR = 23;
const MINIMUM_NODE_PATCH = 1;

export interface DoctorReport {
  nodeSupported: boolean;
  lines: readonly string[];
}

export interface CliOptions {
  nodeVersion?: string;
  setExitCode?: (exitCode: number) => void;
  write?: (message: string) => void;
}

export function getDoctorReport(nodeVersion = process.versions.node): DoctorReport {
  const nodeVersionMatch = STABLE_SEMVER_PATTERN.exec(nodeVersion);
  const nodeVersionParts =
    nodeVersionMatch?.[0] === nodeVersion
      ? nodeVersionMatch.slice(1, 4).map((part) => Number(part))
      : [];
  const [nodeMajor = Number.NaN, nodeMinor = Number.NaN, nodePatch = Number.NaN] = nodeVersionParts;
  const nodeSupported =
    nodeVersionParts.length === 3 &&
    nodeVersionParts.every(Number.isSafeInteger) &&
    nodeMajor === MINIMUM_NODE_MAJOR &&
    (nodeMinor > MINIMUM_NODE_MINOR ||
      (nodeMinor === MINIMUM_NODE_MINOR && nodePatch >= MINIMUM_NODE_PATCH));
  const nodeStatus = nodeSupported ? "OK" : `requires Node ${SUPPORTED_NODE_RANGE}`;

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
  const setExitCode =
    options.setExitCode ??
    ((exitCode: number) => {
      process.exitCode = exitCode;
    });
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
      if (!report.nodeSupported) {
        setExitCode(1);
      }
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}
