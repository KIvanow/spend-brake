import type { Command } from 'commander';
import { CliError, EXIT, type Io, config } from '../../io.js';
import { ADMIN_INSTRUCTIONS, ADMIN_TOOLS, OWNER_TOOLS } from './admin.js';
import { serveMcp } from './protocol.js';
import { SPEND_GROUPS, SPEND_INSTRUCTIONS, SPEND_TOOLS } from './spend.js';

export function mcpCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('mcp')
    .description('MCP server on stdio: capped calls with a virtual key, or org admin with --admin')
    .option('--tools <list>', `spend groups to offer: ${SPEND_GROUPS.join(', ')}`)
    .option('--admin', 'offer the admin API instead of capped calls (needs BRAKE_ADMIN_TOKEN)')
    .option('--owner', 'with --admin, also offer tokens, people, SSO, licenses and orgs')
    .action(async (o: { tools?: string; admin?: boolean; owner?: boolean }, cmd: Command) => {
      if (o.owner && !o.admin) throw new CliError('--owner is used with --admin', EXIT.usage);
      if (o.admin && cmd.getOptionValueSource('tools') === 'cli') {
        throw new CliError(
          '--tools applies to the spend server; leave it off with --admin',
          EXIT.usage,
        );
      }
      if (o.admin) {
        await serveMcp(io, o.owner ? [...ADMIN_TOOLS, ...OWNER_TOOLS] : ADMIN_TOOLS, {
          title: 'Spend Brake admin',
          instructions: ADMIN_INSTRUCTIONS,
        });
        done(EXIT.ok);
        return;
      }
      const want = (o.tools ?? SPEND_GROUPS.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const known: readonly string[] = SPEND_GROUPS;
      const bad = want.filter((w) => !known.includes(w));
      if (bad.length || want.length === 0) {
        throw new CliError(`--tools takes ${SPEND_GROUPS.join(', ')}`, EXIT.usage);
      }
      // The workload must not hold the admin token. Warn, and do not grow admin tools here.
      if (config(io).adminToken) {
        // Say where the token is: the environment, or the config `brake init` saved.
        const where = io.env.BRAKE_ADMIN_TOKEN
          ? 'BRAKE_ADMIN_TOKEN is set on the spend server'
          : 'an admin token is saved in the brake config this server reads (from `brake init`)';
        io.stderr(
          `brake mcp: warning: ${where}. Admin tools are not offered here. Run \`brake mcp --admin\` as a separate MCP entry, and keep the admin token where the workload cannot read it.\n`,
        );
      }
      await serveMcp(
        io,
        SPEND_TOOLS.filter((t) => t.group === null || want.includes(t.group)),
        { title: 'Spend Brake', instructions: SPEND_INSTRUCTIONS },
      );
      done(EXIT.ok);
    });
}
