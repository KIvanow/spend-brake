# brake

Hard dollar caps for every paid API your agents touch, from the shell. Coding agents already run
shell commands, so a capped command needs no extra protocol.

```sh
npx @spend-brake/cli --help          # or the single executable: dist/brake
```

## Agent sessions

```sh
export BRAKE_URL=https://brake.example.com BRAKE_API_URL=https://brake-api.example.com
export BRAKE_KEY=sb_live_...          # a key with canMintSessions

brake session --budget 5 --day-budget 20 --agent claude -- claude
```

`brake session` mints a session key and runs the command with `BRAKE_KEY`, `BRAKE_SESSION` and
`BRAKE_URL` in its environment, then revokes the key when the command exits and prints a JSON
summary (`{"brakeSession":{"spent":"$0.0120",...}}`) on stderr. The exit code is the command's.

- `--budget` (default $5) caps this session: it is the session key's own cap, so it holds even for
  clients that swap only the base URL and key.
- `--day-budget` (default $20) is a daily cap for the agent (`--agent`, default the parent key's
  agent or `cli`) across all its sessions; it is created the first time the agent spends, and an
  admin can change it later.
- Session spend also counts against the parent key's caps, and killing the parent stops its
  sessions.
- The session key expires after `--ttl` (default 12 h) even if `brake` is killed.

Minting needs `BRAKE_KEY` with `canMintSessions`, or `BRAKE_ADMIN_TOKEN` plus `--parent-key <id>`.

## Capped calls

```sh
brake maps search "pizza in Sofia"            # Text Search, IDs only (free tier)
brake maps nearby --lat 42.69 --lng 23.32     # Nearby Search, Pro fields
brake maps details ChIJ...                    # Place Details, Essentials fields
brake maps geocode "1 Main St, Springfield"
brake maps reverse 42.69 23.32
brake maps route "Sofia" "42.14,24.75" --mode drive
brake search tavily "valkey lua scripting"   # basic depth (1 credit)
brake search exa "agent budgets" --type lite --results 5
brake search brave "spend caps"
brake search serpapi "coffee" --engine bing
brake call google-places POST /v1/places:searchText -d '{"textQuery":"x"}' -H 'X-Goog-FieldMask: places.id'
```

`brake search` defaults to each provider's cheapest search. Inside `brake session`, every
provider spends from the one session budget. Each `maps` command uses the cheapest field set by default; `--fields` opts into higher (pricier) tiers. Output
is one JSON object per call (`ok`, `status`, `costMicros`, `cost`, `remainingMicros`,
`requestId`, `data`); `--pretty` prints a summary line and indented data instead.

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 1    | Other failure (provider error, proxy unreachable, session not started) |
| 2    | Bad arguments                                                          |
| 3    | **Stop:** budget exceeded, spending killed, or the route has no price  |
| 4    | **Stop:** loop detected, the key is paused                             |
| 5    | Missing, unknown, revoked or expired virtual key                       |

On 3 and 4, stderr carries one line that tells the agent to stop and ask the user, for example
`brake: STOP. Spend cap reached for sess:sess_ab12 (cap $5.00). Do not retry; ask the user to raise the cap.`

## Building

`pnpm build` writes `dist/brake.cjs` (one file, dependencies inlined: what npx runs).
`pnpm build:sea` turns it into a single executable `dist/brake` that needs no Node install (Node's
`--build-sea` where available, postject otherwise).
