import { spawn } from 'node:child_process';
import { Command, CommanderError } from 'commander';
import { callCommand } from './commands/call.js';
import { mapsCommand } from './commands/maps.js';
import { sessionCommand } from './commands/session.js';
import { CliError, EXIT, type Io } from './io.js';

export const VERSION = '0.1.0';

export function buildProgram(io: Io, done: (code: number) => void): Command {
  const program = new Command('brake')
    .description('Hard dollar caps for every paid API your agents touch')
    .version(VERSION)
    .option('--pretty', 'human-readable output instead of JSON')
    // `brake session [opts] -- <cmd>` passes everything after the command through untouched.
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  sessionCommand(program, io, done);
  mapsCommand(program, io, done);
  callCommand(program, io, done);
  return program;
}

export const defaultIo = (): Io => ({
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  fetch: globalThis.fetch,
  spawn: (cmd, args, opts) => spawn(cmd, args, opts),
});

/** Run the CLI and resolve with its exit code (see EXIT). */
export async function run(argv: string[], io: Io = defaultIo()): Promise<number> {
  let code: number = EXIT.ok;
  const program = buildProgram(io, (c) => {
    code = c;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof CliError) {
      io.stderr(`brake: ${err.message}\n`);
      return err.code;
    }
    io.stderr(`brake: ${(err as Error).message}\n`);
    return EXIT.error;
  }
}
