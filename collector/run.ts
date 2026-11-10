// Collector entry point. Usage: node collector/run.ts <command> [args]
//   seed [topic...]      one-off: index every AI repo with >= MIN_STARS via topic search
//   discover             new/recent AI repos (keyword + topic search) and GitHub Trending
//   snapshot [all|hot]   fetch star/fork counts and store the ones that changed
//   rank [periods...]    recompute rankings for today (default: all periods)
//   hot                  discover + snapshot hot + rank daily          (every 2 hours)
//   daily                snapshot all + rank all periods               (once a day)
//   flush <file> [n]     send writes queued with QUEUE_FILE, in order (only the first n lines if given);
//                        sent lines are removed from the file, which is deleted once empty
// With QUEUE_FILE=path, writes are appended to that file instead of being sent (reads still hit the worker):
// collect now, flush later, e.g. while D1's daily write quota is exhausted. Each write carries its own day.
// GitHub no longer exposes stargazer lists (2026), so star history only accumulates from our own snapshots.
// Env: GITHUB_TOKEN, WORKER_URL, ADMIN_TOKEN, QUEUE_FILE (optional)

import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { classify, DISCOVERY_KEYWORDS, DISCOVERY_TOPICS } from "./classify.ts";
import { fromSearch, gql, pointsUsed, reposByName, searchRepos, type RepoMeta } from "./github.ts";

const WORKER_URL = (process.env.WORKER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-token";
const MIN_STARS = Number(process.env.MIN_STARS ?? 20);

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => day(new Date(Date.now() - n * 864e5));
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const QUEUE_FILE = process.env.QUEUE_FILE;
const WRITE_PATHS = new Set(["/admin/repos", "/admin/snapshots", "/admin/rank", "/admin/hide"]);

async function admin<T = any>(path: string, body?: unknown): Promise<T> {
  if (QUEUE_FILE && WRITE_PATHS.has(path)) {
    appendFileSync(QUEUE_FILE, JSON.stringify({ path, body }) + "\n");
    return { queued: true } as T;
  }
  const res = await fetch(WORKER_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------- discovery ----------

// Repos already sent (or queued) by this process: the worker cannot see queued ones yet.
const sentIds = new Set<number>();

/** Keep AI, non-fork, non-archived repos above the star floor, and send the new ones to the worker. */
async function ingest(candidates: RepoMeta[], label: string) {
  const seen = new Map<number, RepoMeta>();
  for (const r of candidates) if (r.id && !r.is_fork && !r.archived && r.stars >= MIN_STARS) seen.set(r.id, r);
  const ai = [...seen.values()]
    .map((r) => ({ ...r, category: classify({ name: r.full_name, description: r.description, topics: r.topics }) }))
    .filter((r) => r.category);
  let added = 0;
  for (const part of chunk(ai, 500)) {
    const known = new Set(await admin<number[]>("/admin/known", { ids: part.map((r) => r.id) }));
    const fresh = part.filter((r) => !known.has(r.id) && !sentIds.has(r.id));
    for (const r of fresh) sentIds.add(r.id);
    if (fresh.length) await admin("/admin/repos", { repos: fresh, day: day() });
    added += fresh.length;
  }
  console.log(`[${label}] ${candidates.length} candidates, ${ai.length} AI, ${added} new`);
  return added;
}

/** Runs a search, splitting the star range (then the creation date) until each slice has ≤ 1000 results. */
async function searchAll(base: string, lo = MIN_STARS, hi = 1_000_000, created?: [string, string]): Promise<RepoMeta[]> {
  const q = `${base} stars:${lo}..${hi}${created ? ` created:${created[0]}..${created[1]}` : ""}`;
  const first = await searchRepos(q);
  if (first.total_count > 1000) {
    if (hi - lo > 0) {
      const mid = lo + Math.max(1, Math.floor((hi - lo) / (hi > 5000 ? 10 : 2)));
      return [...(await searchAll(base, lo, mid - 1, created)), ...(await searchAll(base, mid, hi, created))];
    }
    const [a, b] = created ?? ["2008-01-01", day()];
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (tb - ta > 864e5) {
      const mid = day(new Date((ta + tb) / 2));
      return [...(await searchAll(base, lo, hi, [a, mid])), ...(await searchAll(base, lo, hi, [day(new Date(new Date(mid).getTime() + 864e5)), b]))];
    }
  }
  const items = first.items.map(fromSearch);
  const pages = Math.min(10, Math.ceil(first.total_count / 100));
  for (let p = 2; p <= pages; p++) items.push(...(await searchRepos(q, p)).items.map(fromSearch));
  return items;
}

async function seed(topics: string[]) {
  const pushedSince = daysAgo(365);
  for (const t of topics) {
    const items = await searchAll(`topic:${t} fork:false archived:false pushed:>=${pushedSince}`);
    await ingest(items, `seed topic:${t}`);
  }
}

async function githubTrending(): Promise<string[]> {
  const names = new Set<string>();
  for (const since of ["daily", "weekly", "monthly"]) {
    const res = await fetch(`https://github.com/trending?since=${since}`, { headers: { "user-agent": "Mozilla/5.0" } });
    const htmlText = await res.text();
    for (const m of htmlText.matchAll(/<h2 class="h3 lh-condensed">\s*<a[^>]*href="\/([\w.-]+\/[\w.-]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

async function discover() {
  const since = daysAgo(14);
  const items: RepoMeta[] = [];
  for (const k of DISCOVERY_KEYWORDS) {
    const r = await searchRepos(`${k} in:name,description,topics created:>=${since} stars:>=${MIN_STARS} fork:false`);
    items.push(...r.items.map(fromSearch));
  }
  for (const t of DISCOVERY_TOPICS) {
    const r = await searchRepos(`topic:${t} created:>=${since} stars:>=${MIN_STARS} fork:false`);
    items.push(...r.items.map(fromSearch));
  }
  // Any new repo that took off, AI keywords or not: the classifier decides.
  for (let p = 1; p <= 3; p++) items.push(...(await searchRepos(`created:>=${daysAgo(3)} stars:>=${MIN_STARS * 2} fork:false`, p)).items.map(fromSearch));
  await ingest(items, "discover search");

  const trending = await githubTrending();
  await ingest(await reposByName(trending), `github trending (${trending.length})`);
}

// ---------- snapshots ----------

async function snapshot(scope: "all" | "hot") {
  let after = 0;
  let tracked = 0;
  let changed = 0;
  for (;;) {
    const rows = await admin<{ id: number; node_id: string; stars: number; forks: number }[]>(
      `/admin/tracked?scope=${scope}&after=${after}&limit=5000`,
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    tracked += rows.length;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const updates: { id: number; stars: number; forks: number }[] = [];
    const batches = chunk(rows, 100);
    // 3 GraphQL requests in flight keeps us well under GitHub's secondary rate limits.
    for (let i = 0; i < batches.length; i += 3) {
      const results = await Promise.all(
        batches.slice(i, i + 3).map((b) =>
          gql<{ nodes: any[] }>(
            `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Repository { databaseId stargazerCount forkCount } } }`,
            { ids: b.map((r) => r.node_id) },
          ),
        ),
      );
      for (const n of results.flatMap((r) => r.nodes)) {
        if (!n?.databaseId) continue; // deleted or now private
        const prev = byId.get(n.databaseId);
        if (prev && (prev.stars !== n.stargazerCount || prev.forks !== n.forkCount))
          updates.push({ id: n.databaseId, stars: n.stargazerCount, forks: n.forkCount });
      }
    }
    for (const part of chunk(updates, 1000)) await admin("/admin/snapshots", { items: part, day: day() });
    changed += updates.length;
  }
  console.log(`[snapshot ${scope}] ${tracked} tracked, ${changed} changed`);
}

// ---------- main ----------

const [cmd = "hot", ...args] = process.argv.slice(2);
const t0 = Date.now();
switch (cmd) {
  case "seed":
    await seed(args.length ? args : DISCOVERY_TOPICS);
    break;
  case "discover":
    await discover();
    break;
  case "snapshot":
    await snapshot((args[0] as "all" | "hot") ?? "hot");
    break;
  case "flush": {
    const file = args[0] ?? QUEUE_FILE;
    if (!file) throw new Error("usage: flush <file>");
    const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const lines = args[1] ? all.slice(0, Number(args[1])) : all;
    const keepRest = (sent: number) => {
      const rest = all.slice(sent);
      if (rest.length) writeFileSync(file, rest.join("\n") + "\n");
      else unlinkSync(file);
    };
    for (const [i, line] of lines.entries()) {
      const { path, body } = JSON.parse(line);
      const res = await fetch(WORKER_URL + path, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // Stop at the first failure so the file can be flushed again from the same point.
      if (!res.ok) {
        keepRest(i);
        throw new Error(`flush stopped at line ${i + 1}/${lines.length}: ${path} → ${res.status}`);
      }
    }
    keepRest(lines.length);
    console.log(`[flush] ${lines.length} writes sent, ${all.length - lines.length} left`);
    break;
  }
  case "rank":
    console.log(await admin("/admin/rank", { day: day(), periods: args.length ? args : undefined }));
    break;
  case "hot":
    await discover();
    await snapshot("hot");
    // Weekly and monthly windows move slowly: refresh them every 6 hours to save D1 writes.
    console.log(await admin("/admin/rank", { day: day(), periods: new Date().getUTCHours() % 6 < 2 ? undefined : ["daily"] }));
    break;
  case "daily":
    await snapshot("all");
    // Finalize yesterday's daily ranking, then compute today's windows.
    console.log(await admin("/admin/rank", { day: daysAgo(1), periods: ["daily"] }));
    console.log(await admin("/admin/rank", { day: day() }));
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s, ${pointsUsed} GraphQL points`);
