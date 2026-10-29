import type { Command } from 'commander';
import { apiCall, money, print } from '../admin.js';
import { CliError, EXIT, type Io, config, usdToMicros } from '../io.js';

const pretty = (cmd: Command) => Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty);
const leaf = (parent: Command, name: string) =>
  parent.command(name).option('--pretty', 'human-readable output instead of JSON');

interface Key {
  id: string;
  name: string;
  prefix: string;
  status: string;
  expiresAt: string | null;
  config: Record<string, unknown>;
}

interface Cap {
  scope: string;
  kind: 'd' | 'm';
  hard: number | null;
  soft: number | null;
  version: number;
}

interface Status {
  scope: string;
  window: string;
  spent: number;
  held: number;
  hard: number | null;
  remaining: number | null;
}

export function adminCommands(program: Command, io: Io, done: (code: number) => void): void {
  // --- keys --------------------------------------------------------------------------------
  const keys = program.command('keys').description('Virtual keys');
  leaf(keys, 'list').action(async (_o: unknown, cmd: Command) => {
    const r = await apiCall<{ items: Key[] }>(io, 'GET', '/v1/keys');
    print(
      io,
      r,
      pretty(cmd),
      r.items.map((k) => ({
        ...k,
        env: k.config.env,
        agent: k.config.agentId,
        session: k.config.sessionId,
      })),
      ['id', 'name', 'prefix', 'status', 'env', 'agent', 'session', 'expiresAt'],
    );
    done(EXIT.ok);
  });
  leaf(keys, 'create')
    .requiredOption('--name <name>')
    .requiredOption('--credential <provider=credId...>', 'provider credential bindings')
    .option('--env <env>')
    .option('--agent <id>')
    .option('--skus <sku...>', 'allowed SKUs (default all)')
    .option('--session-cap <usd>', 'budget for each X-Brake-Session the key opens')
    .option('--can-mint-sessions', 'allow `brake session` with this key')
    .option('--expires <iso>', 'expiry time')
    .action(
      async (
        o: {
          name: string;
          credential: string[];
          env?: string;
          agent?: string;
          skus?: string[];
          sessionCap?: string;
          canMintSessions?: boolean;
          expires?: string;
        },
        cmd: Command,
      ) => {
        const credentials: Record<string, string> = {};
        for (const c of o.credential) {
          const [provider, id] = c.split('=');
          if (!provider || !id)
            throw new CliError(`bad --credential ${c} (provider=credId)`, EXIT.usage);
          credentials[provider] = id;
        }
        const r = await apiCall<Key & { token: string }>(io, 'POST', '/v1/keys', {
          name: o.name,
          credentials,
          ...(o.env ? { env: o.env } : {}),
          ...(o.agent ? { agentId: o.agent } : {}),
          ...(o.skus ? { skus: o.skus } : {}),
          ...(o.sessionCap ? { sessionCapMicros: usdToMicros(o.sessionCap).toString() } : {}),
          ...(o.canMintSessions ? { canMintSessions: true } : {}),
          ...(o.expires ? { expiresAt: o.expires } : {}),
        });
        print(io, r, pretty(cmd));
        done(EXIT.ok);
      },
    );
  leaf(keys, 'show')
    .argument('<id>')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      print(io, await apiCall(io, 'GET', `/v1/keys/${encodeURIComponent(id)}`), pretty(cmd));
      done(EXIT.ok);
    });
  leaf(keys, 'revoke')
    .argument('<id>')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      print(io, await apiCall(io, 'DELETE', `/v1/keys/${encodeURIComponent(id)}`), pretty(cmd));
      done(EXIT.ok);
    });

  // --- caps --------------------------------------------------------------------------------
  const caps = program
    .command('caps')
    .description(
      'Dollar caps per scope (org, key:<id>, sku:<p>:<sku>, env:<n>, sess:<id>, agent:<id>)',
    );
  leaf(caps, 'list').action(async (_o: unknown, cmd: Command) => {
    const r = await apiCall<{ items: Cap[] }>(io, 'GET', '/v1/caps');
    print(
      io,
      r,
      pretty(cmd),
      r.items.map((c) => ({
        ...c,
        window: c.kind === 'd' ? 'day' : 'month',
        hard: money(c.hard),
        soft: money(c.soft),
      })),
      ['scope', 'window', 'hard', 'soft', 'version'],
    );
    done(EXIT.ok);
  });
  leaf(caps, 'set')
    .argument('<scope>')
    .option('--day <usd>', 'hard cap per day')
    .option('--month <usd>', 'hard cap per month')
    .option('--soft-day <usd>', 'soft (alert-only) limit per day')
    .option('--soft-month <usd>', 'soft (alert-only) limit per month')
    .action(
      async (
        scope: string,
        o: { day?: string; month?: string; softDay?: string; softMonth?: string },
        cmd: Command,
      ) => {
        const window = (hard?: string, soft?: string) =>
          hard || soft
            ? {
                hard: hard ? usdToMicros(hard).toString() : null,
                ...(soft ? { soft: usdToMicros(soft).toString() } : {}),
              }
            : undefined;
        const day = window(o.day, o.softDay);
        const month = window(o.month, o.softMonth);
        if (!day && !month) throw new CliError('Give --day and/or --month.', EXIT.usage);
        const r = await apiCall(io, 'PUT', `/v1/caps/${encodeURIComponent(scope)}`, {
          ...(day ? { day } : {}),
          ...(month ? { month } : {}),
        });
        print(io, r, pretty(cmd));
        done(EXIT.ok);
      },
    );
  leaf(caps, 'rm')
    .argument('<scope>')
    .option('--kind <d|m>', 'only the day or month cap')
    .action(async (scope: string, o: { kind?: string }, cmd: Command) => {
      const q = o.kind ? `?kind=${encodeURIComponent(o.kind)}` : '';
      print(
        io,
        await apiCall(io, 'DELETE', `/v1/caps/${encodeURIComponent(scope)}${q}`),
        pretty(cmd),
      );
      done(EXIT.ok);
    });

  // --- kill switch ---------------------------------------------------------------------------
  for (const verb of ['kill', 'unkill'] as const) {
    leaf(program, verb)
      .description(
        verb === 'kill'
          ? 'Stop all spend for org, key:<id>, prov:<name> or sess:<id> (immediate)'
          : 'Lift a kill',
      )
      .argument('<target>')
      .option('--reason <text>')
      .action(async (target: string, o: { reason?: string }, cmd: Command) => {
        const r = await apiCall(io, 'POST', `/v1/${verb}`, {
          target,
          ...(o.reason ? { reason: o.reason } : {}),
        });
        print(io, r, pretty(cmd));
        done(EXIT.ok);
      });
  }

  // --- status --------------------------------------------------------------------------------
  leaf(program, 'status')
    .description('Remaining budget: your session and key (with BRAKE_KEY), or every scope (admin)')
    .option('--scope <scope...>', 'admin: scopes to show (default org and active keys)')
    .action(async (o: { scope?: string[] }, cmd: Command) => {
      const cfg = config(io);
      let r: { scopes: Status[]; killed: unknown };
      if (cfg.key && !o.scope) {
        r = await apiCall(io, 'GET', '/v1/me', undefined, { 'x-brake-key': cfg.key });
      } else {
        const q = (o.scope ?? []).map((s) => `scope=${encodeURIComponent(s)}`).join('&');
        r = await apiCall(io, 'GET', `/v1/status${q ? `?${q}` : ''}`);
      }
      print(
        io,
        r,
        pretty(cmd),
        r.scopes.map((s) => ({
          ...s,
          spent: money(s.spent, 4),
          hard: money(s.hard),
          remaining: money(s.remaining, 4),
        })),
        ['scope', 'window', 'spent', 'hard', 'remaining'],
      );
      done(EXIT.ok);
    });

  // --- spend ---------------------------------------------------------------------------------
  leaf(program, 'spend')
    .description('Spend from the ledger')
    .option('--group-by <cols>', 'key,sku,day,provider,session,env,agent', 'day')
    .option('--days <n>', 'last N days', '30')
    .option('--from <iso>')
    .option('--to <iso>')
    .action(
      async (o: { groupBy: string; days: string; from?: string; to?: string }, cmd: Command) => {
        const from = o.from ?? new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
        const q = new URLSearchParams({ groupBy: o.groupBy, from, ...(o.to ? { to: o.to } : {}) });
        const r = await apiCall<{ items: Record<string, unknown>[] }>(
          io,
          'GET',
          `/v1/spend?${q.toString()}`,
        );
        const cols = o.groupBy.split(',').map((c) => c.trim());
        print(
          io,
          r,
          pretty(cmd),
          r.items.map((x) => ({ ...x, cost: money(x.costMicros, 4) })),
          [...cols, 'requests', 'cost'],
        );
        done(EXIT.ok);
      },
    );

  // --- migration estimate ------------------------------------------------------------------------
  leaf(program, 'estimate')
    .description('What the last N days would cost on Geoapify, Stadia Maps or Open Places API')
    .option('--days <n>', 'days of usage', '30')
    .action(async (o: { days: string }, cmd: Command) => {
      const r = await apiCall<{
        googleCostMicros: number;
        alternatives: {
          name: string;
          plan: string | null;
          monthlyCostMicros: number | null;
          uncoveredGoogleCostMicros: number;
          totalMicros: number | null;
        }[];
      }>(io, 'POST', '/v1/estimates/migration', { days: Number(o.days) });
      print(
        io,
        r,
        pretty(cmd),
        [
          {
            provider: 'Google (today)',
            plan: '',
            cost: money(r.googleCostMicros),
            'left on Google': '',
            total: money(r.googleCostMicros),
          },
          ...r.alternatives.map((a) => ({
            provider: a.name,
            plan: a.plan ?? 'custom',
            cost: money(a.monthlyCostMicros),
            'left on Google': money(a.uncoveredGoogleCostMicros),
            total: a.totalMicros === null ? 'contact sales' : money(a.totalMicros),
          })),
        ],
        ['provider', 'plan', 'cost', 'left on Google', 'total'],
      );
      done(EXIT.ok);
    });
}
