import type { Command } from 'commander';
import {
  CliError,
  EXIT,
  type Io,
  config,
  configPath,
  durationSec,
  microsToUsd,
  readSavedConfig,
  usdToMicros,
} from '../io.js';

interface Minted {
  sessionId: string;
  keyId: string;
  token: string;
  agentId: string;
  budgetMicros: number;
  dayBudgetMicros: number;
  expiresAt: string;
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

/**
 * `brake session -- <cmd>`: mint a session key with its own budget, run the command with
 * BRAKE_KEY / BRAKE_SESSION / BRAKE_URL in its environment, and revoke the key when it exits.
 */
export function sessionCommand(
  program: Command,
  io: Io,
  done: (code: number) => void,
  signals: {
    on(sig: keyof typeof SIGNALS, cb: () => void): void;
    off(sig: keyof typeof SIGNALS, cb: () => void): void;
  } = process,
): void {
  program
    .command('session')
    .description(
      'Run a command with a session-scoped key and budget: brake session [opts] -- <cmd...>',
    )
    .option('--budget <usd>', 'spend limit for this session', '5')
    .option(
      '--day-budget <usd>',
      'daily limit for the agent across its sessions (set on first use)',
      '20',
    )
    .option('--agent <name>', 'agent id (defaults to the parent key agent, or "cli")')
    .option('--ttl <duration>', 'session key lifetime, e.g. 30m, 12h', '12h')
    .option('--parent-key <id>', 'parent key id (with BRAKE_ADMIN_TOKEN instead of BRAKE_KEY)')
    .argument('<cmd...>')
    .passThroughOptions()
    .action(
      async (
        cmd: string[],
        o: { budget: string; dayBudget: string; agent?: string; ttl: string; parentKey?: string },
      ) => {
        const cfg = config(io);
        const auth: Record<string, string> = cfg.key
          ? { 'x-brake-key': cfg.key }
          : cfg.adminToken
            ? { authorization: `Bearer ${cfg.adminToken}` }
            : {};
        if (!auth['x-brake-key'] && !auth.authorization) {
          throw new CliError(
            'Set BRAKE_KEY (a key with canMintSessions) or BRAKE_ADMIN_TOKEN.',
            EXIT.auth,
          );
        }
        if (auth.authorization && !o.parentKey) {
          throw new CliError('With BRAKE_ADMIN_TOKEN, give --parent-key <id>.', EXIT.usage);
        }
        const res = await io.fetch(`${cfg.apiUrl}/v1/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({
            budgetMicros: usdToMicros(o.budget).toString(),
            dayBudgetMicros: usdToMicros(o.dayBudget).toString(),
            ttlSec: durationSec(o.ttl),
            ...(o.agent ? { agentId: o.agent } : {}),
            ...(o.parentKey ? { parentKeyId: o.parentKey } : {}),
          }),
        });
        const minted = (await res.json()) as Minted & { message?: string };
        if (res.status !== 201) {
          throw new CliError(
            `could not start a session: ${minted.message ?? `HTTP ${res.status}`}`,
            res.status === 401 ? EXIT.auth : EXIT.error,
          );
        }

        if (readSavedConfig(io).adminToken) {
          io.stderr(
            `brake: warning: ${configPath(io)} holds an admin token the command can read. Run agents as another user (or with XDG_CONFIG_HOME elsewhere) so they cannot lift their own caps.\n`,
          );
        }

        const [bin, ...args] = cmd;
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
        Object.assign(env, {
          BRAKE_KEY: minted.token,
          BRAKE_SESSION: minted.sessionId,
          BRAKE_URL: cfg.proxyUrl,
          BRAKE_API_URL: cfg.apiUrl,
        });
        delete env.BRAKE_ADMIN_TOKEN;

        const child = io.spawn(bin!, args, { stdio: 'inherit', env });
        const forward = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]).map(
          (s) => [s, () => void child.kill(s)] as const,
        );
        for (const [s, f] of forward) signals.on(s, f);

        const code = await new Promise<number>((resolve) => {
          child.on('error', (err) => {
            io.stderr(`brake: could not run ${bin}: ${err.message}\n`);
            resolve(127);
          });
          child.on('exit', (c, sig) =>
            resolve(c ?? (sig ? 128 + (SIGNALS[sig as keyof typeof SIGNALS] ?? 1) : 1)),
          );
        });
        for (const [s, f] of forward) signals.off(s, f);

        // Revoke with the session key itself; report what the session spent.
        let summary: Record<string, unknown> = {
          session: minted.sessionId,
          keyId: minted.keyId,
          exitCode: code,
        };
        try {
          const end = await io.fetch(`${cfg.apiUrl}/v1/sessions/${minted.keyId}`, {
            method: 'DELETE',
            headers: { 'x-brake-key': minted.token },
          });
          const e = (await end.json()) as { spentMicros?: number; heldMicros?: number };
          if (end.ok) {
            summary = {
              ...summary,
              spentMicros: e.spentMicros,
              spent: microsToUsd(e.spentMicros ?? 0),
              budget: microsToUsd(minted.budgetMicros, 2),
            };
          } else {
            summary.revokeError = `HTTP ${end.status}`;
          }
        } catch (err) {
          summary.revokeError = (err as Error).message;
        }
        io.stderr(`${JSON.stringify({ brakeSession: summary })}\n`);
        done(code);
      },
    );
}
