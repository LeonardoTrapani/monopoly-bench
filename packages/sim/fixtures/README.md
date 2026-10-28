# Game fixtures

Sample games for the web viewer and tests, written by the CLI:

| Files                                             | Game                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `sample-4p.config.json`, `sample-4p.events.jsonl` | 4 bots (heuristic, random, heuristic, random), played to the end |
| `sample-2p.config.json`, `sample-2p.events.jsonl` | 2 bots (heuristic, random), short game (turn cap of 12 rounds)   |

`*.config.json` is an encoded `GameConfig`; `*.events.jsonl` has one encoded
`GameEvent` per line (`GameEventJson` in `@mb/engine`). Rebuild any state with
`replay(config, events)` (or fold `evolve` up to an event to scrub the timeline).

Regenerate from the repo root after a change to the engine or the bots
(`packages/sim/src/fixtures.test.ts` fails when they drift):

```sh
bun run sim -- --players 4 --seed sample-4p --bots heuristic,random,heuristic,random --game-id sample-4p --out packages/sim/fixtures
bun run sim -- --players 2 --seed sample-2p --bots heuristic,random --max-rounds 12 --game-id sample-2p --out packages/sim/fixtures
```
