# AI Trending collector

Discovers open-source AI repositories (agents, MCP, skills, coding agents, RAG, models, AI apps) and snapshots
their GitHub stars and forks for [AI Trending](https://ai-trending.autolabel.workers.dev). Rankings use
`stars gained + 2 × forks gained`.

- **Discovery**: GitHub search on AI topics and keywords, plus github.com/trending. `collector/classify.ts`
  decides whether a repo is AI and which category it belongs to.
- **Snapshots**: GraphQL, 100 repos per request. Only changed counts are sent.
- No history backfill: GitHub no longer exposes stargazer lists or a usable public events feed (GH Archive and
  OSS Insight capture <1% of events since 2026). History starts when a repo is first tracked.

No dependencies; Node 24 runs the TypeScript directly.

```bash
export GITHUB_TOKEN=$(gh auth token) WORKER_URL=https://… ADMIN_TOKEN=…
node collector/run.ts seed mcp-server     # one-off indexing by topic
node collector/run.ts hot                 # discover + hot snapshots + daily ranking (every 2h)
node collector/run.ts daily               # full snapshot + all rankings (once a day)

# Collect now, send later (e.g. while the database's daily write quota is exhausted):
QUEUE_FILE=queue.jsonl node collector/run.ts snapshot all
node collector/run.ts flush queue.jsonl
```

## GitHub Actions

`.github/workflows/collect.yml` runs `hot` every 2 hours and `daily` at 00:40 UTC.
Secret `ADMIN_TOKEN`, variable `WORKER_URL`. The built-in token allows 1,000 GraphQL points/hour (a full
snapshot of ~30k repos costs ~300); set `GH_COLLECTOR_TOKEN` (fine-grained PAT, public read only) for 5,000.
