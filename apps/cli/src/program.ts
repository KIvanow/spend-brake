import { Command } from 'commander';

export const VERSION = '0.0.0';

export function buildProgram(): Command {
  return new Command('brake')
    .description('Hard dollar caps for every paid API your agents touch')
    .version(VERSION);
}
