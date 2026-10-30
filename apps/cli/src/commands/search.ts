import type { Command } from 'commander';
import { CliError, EXIT, type Io } from '../io.js';
import { type ProxyRequest, proxyCall, report } from '../proxy.js';

function count(value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new CliError(`--results must be 1 to ${max}`, EXIT.usage);
  }
  return n;
}

interface SearchOpts {
  results?: string;
  depth?: string;
  type?: string;
  engine: string;
}

/** One web search on each provider, with its cheapest settings unless asked otherwise. */
const PROVIDERS: Record<string, (q: string, o: SearchOpts) => ProxyRequest> = {
  tavily: (q, o) => {
    const n = count(o.results, 20);
    return {
      method: 'POST',
      path: '/tavily/search',
      body: {
        query: q,
        search_depth: o.depth ?? 'basic',
        ...(n !== undefined ? { max_results: n } : {}),
      },
    };
  },
  exa: (q, o) => {
    const n = count(o.results, 100);
    return {
      method: 'POST',
      path: '/exa/search',
      body: { query: q, type: o.type ?? 'auto', ...(n !== undefined ? { numResults: n } : {}) },
    };
  },
  brave: (q, o) => {
    const n = count(o.results, 20);
    return {
      method: 'GET',
      path: '/brave/res/v1/web/search',
      query: { q, ...(n !== undefined ? { count: String(n) } : {}) },
    };
  },
  serpapi: (q, o) => {
    const n = count(o.results, 100);
    return {
      method: 'GET',
      path: '/serpapi/search.json',
      query: { engine: o.engine, q, ...(n !== undefined ? { num: String(n) } : {}) },
    };
  },
};

export function searchCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('search')
    .description('Capped web search on tavily | exa | brave | serpapi; prints the cost')
    .argument('<provider>', Object.keys(PROVIDERS).join(' | '))
    .argument('<query...>')
    .option('--results <n>', 'number of results')
    .option('--depth <depth>', 'Tavily search_depth (basic, fast, ultra-fast, advanced)')
    .option('--type <type>', 'Exa search type (auto, lite, deep, ...)')
    .option('--engine <engine>', 'SerpApi engine', 'google')
    .option('--pretty', 'human-readable output instead of JSON')
    .action(async (provider: string, query: string[], o: SearchOpts, cmd: Command) => {
      const build = PROVIDERS[provider];
      if (!build) throw new CliError(`unknown provider ${provider}`, EXIT.usage);
      const pretty = Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty);
      done(report(io, await proxyCall(io, build(query.join(' '), o)), pretty));
    });
}
