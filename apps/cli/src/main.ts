/**
 * `mb` CLI (SPEC §10). Each command lives in its own module and registers here.
 */
import { calibrateCommand } from "./calibrate.ts";
import { runCommand } from "./run.ts";
import { simCommand } from "./sim.ts";

import type { CliCommand } from "./cli.ts";

const COMMANDS: ReadonlyArray<CliCommand> = [simCommand, calibrateCommand, runCommand];

const help = (): string =>
  [
    "Usage: mb <command> [flags]",
    "",
    ...COMMANDS.map(
      (entry) => `  ${entry.name.padEnd(10)} ${entry.summary}\n             ${entry.usage}`,
    ),
  ].join("\n");

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [name, ...rest] = argv;

  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    console.log(help());

    return name === undefined ? 1 : 0;
  }

  const selected = COMMANDS.find((entry) => entry.name === name);

  if (selected === undefined) {
    console.error(`Unknown command "${name}".\n\n${help()}`);

    return 1;
  }

  try {
    return await selected.run(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 1;
  }
};

process.exitCode = await main(process.argv.slice(2));
