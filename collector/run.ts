// Collector entry point. Usage: node collector/run.ts <command> [args]
//   seed [topic...]      one-off: index every AI repo with >= MIN_STARS via topic search
//   discover             new/recent AI repos (keyword + topic search) and GitHub Trending
//   sweep [minStars]     established AI repos of any age by keyword + topic (default 100 stars; weekly)
//   reclassify           re-run the classifier on every tracked repo with fresh metadata; hide non-AI ones
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
import { classify, DISCOVERY_KEYWORDS, DISCOVERY_TOPICS, SWEEP_KEYWORDS } from "./classify.ts";
import { fromSearch, gql, pointsUsed, reposByName, searchRepos, type RepoMeta } from "./github.ts";
import { spamReason } from "./spam.ts";

const WORKER_URL = (process.env.WORKER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-token";
const MIN_STARS = Number(process.env.MIN_STARS ?? 20);

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => day(new Date(Date.now() - n * 864e5));
// Day a count observed now belongs to. A count read shortly after midnight UTC (the daily sweep runs at 00:40,
// later when GitHub delays it) is the previous day's closing count: labelling it with the new day moved every
// once-a-day repo's gains to the following day.
const obsDay = () => day(new Date(Date.now() - 3 * 3600e3));
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const QUEUE_FILE = process.env.QUEUE_FILE;
const WRITE_PATHS = new Set(["/admin/repos", "/admin/snapshots", "/admin/rank", "/admin/hide", "/admin/categories"]);

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
async function ingest(candidates: RepoMeta[], label: string, minAppsStars = 0) {
  const seen = new Map<number, RepoMeta>();
  let spam = 0;
  for (const r of candidates) {
    if (!r.id || r.is_fork || r.archived || r.stars < MIN_STARS) continue;
    if (spamReason(r)) spam++;
    else seen.set(r.id, r);
  }
  const ai = [...seen.values()]
    .map((r) => ({ ...r, category: classify({ name: r.full_name, description: r.description, topics: r.topics }) }))
    // "apps" is the catch-all category, the least precise: the sweep only keeps its big repos.
    .filter((r) => r.category && (r.category !== "apps" || r.stars >= minAppsStars || r.created_at >= daysAgo(90)));
  let added = 0;
  for (const part of chunk(ai, 500)) {
    const known = new Set(await admin<number[]>("/admin/known", { ids: part.map((r) => r.id) }));
    const fresh = part.filter((r) => !known.has(r.id) && !sentIds.has(r.id));
    for (const r of fresh) sentIds.add(r.id);
    if (fresh.length) await admin("/admin/repos", { repos: fresh, day: obsDay() });
    added += fresh.length;
  }
  console.log(`[${label}] ${candidates.length} candidates, ${ai.length} AI, ${added} new, ${spam} spam skipped`);
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
  // Every page, not just the first: "ai" alone matches ~600 repos created in 14 days.
  for (const k of DISCOVERY_KEYWORDS) items.push(...(await searchAll(`${k} in:name,description,topics created:>=${since} fork:false`)));
  for (const t of DISCOVERY_TOPICS) items.push(...(await searchAll(`topic:${t} created:>=${since} fork:false`)));
  // Any new repo that took off, AI keywords or not: the classifier decides.
  for (let p = 1; p <= 3; p++) items.push(...(await searchRepos(`created:>=${daysAgo(3)} stars:>=${MIN_STARS * 2} fork:false`, p)).items.map(fromSearch));
  await ingest(items, "discover search");

  const trending = await reposByName(await githubTrending());
  await ingest(trending, `github trending (${trending.length})`);
  // A tracked repo that starts trending may sit outside the hot set (only snapshotted once a day): record its
  // counts now, or it would only reach today's ranking tomorrow. Non-AI trending repos are not tracked: skipped.
  const known = new Set(await admin<number[]>("/admin/known", { ids: trending.map((r) => r.id) }));
  const counts = trending.filter((r) => known.has(r.id) || sentIds.has(r.id)).map((r) => ({ id: r.id, stars: r.stars, forks: r.forks }));
  if (counts.length) await admin("/admin/snapshots", { items: counts, day: obsDay() });
}

/** In a sweep sample, half the older "apps" below this were off-niche (tensorflow/docs, subscription trackers...).
 * Repos created in the last 90 days are kept regardless: a young repo with a few hundred stars is still climbing. */
const SWEEP_MIN_APPS_STARS = 1000;

/** Repos of any age above `minStars`, pushed within a year: catches popular repos discovery never saw. */
async function sweep(minStars: number) {
  const base = `fork:false archived:false pushed:>=${daysAgo(365)}`;
  for (const k of SWEEP_KEYWORDS) {
    const q = k.includes(" ") ? `"${k}"` : k;
    await ingest(await searchAll(`${q} in:name,description ${base}`, minStars), `sweep "${k}"`, SWEEP_MIN_APPS_STARS);
  }
  for (const t of DISCOVERY_TOPICS) await ingest(await searchAll(`topic:${t} ${base}`, minStars), `sweep topic:${t}`, SWEEP_MIN_APPS_STARS);
}

/** Applies the current classifier to every tracked repo, using fresh name/description/topics. */
async function reclassify() {
  let after = 0;
  const changes: { id: number; category: string }[] = [];
  const notAi: number[] = [];
  const moves = new Map<string, number>();
  for (;;) {
    const rows = await admin<{ id: number; node_id: string; category: string }[]>(`/admin/tracked?scope=all&after=${after}&limit=5000`);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const batches = chunk(rows, 100);
    for (let i = 0; i < batches.length; i += 3) {
      const group = batches.slice(i, i + 3);
      const results = await Promise.all(
        group.map((b) =>
          gql<{ nodes: any[] }>(
            `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Repository { nameWithOwner description
              repositoryTopics(first: 20) { nodes { topic { name } } } } } }`,
            { ids: b.map((r) => r.node_id) },
          ),
        ),
      );
      const pairs = group.flatMap((b, j) => b.map((row, k) => [row, results[j].nodes[k]] as const));
      for (const [row, n] of pairs) {
        if (!n?.nameWithOwner) continue; // deleted/private: the next snapshot hides it
        const topics = n.repositoryTopics.nodes.map((t: any) => t.topic.name);
        const category = classify({ name: n.nameWithOwner, description: n.description, topics });
        if (!category) notAi.push(row.id);
        else if (category !== row.category) {
          changes.push({ id: row.id, category });
          const key = `${row.category}->${category}`;
          moves.set(key, (moves.get(key) ?? 0) + 1);
        }
      }
    }
  }
  for (const part of chunk(changes, 1000)) await admin("/admin/categories", { items: part });
  for (const part of chunk(notAi, 1000)) await admin("/admin/hide", { ids: part });
  console.log(`[reclassify] ${changes.length} recategorized, ${notAi.length} no longer AI (hidden)`);
  console.log([...moves].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", "));
}

// ---------- snapshots ----------

async function snapshot(scope: "all" | "hot") {
  let after = 0;
  let tracked = 0;
  let changed = 0;
  let hidden = 0;
  for (;;) {
    const rows = await admin<{ id: number; node_id: string; stars: number; forks: number }[]>(
      `/admin/tracked?scope=${scope}&after=${after}&limit=5000`,
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    tracked += rows.length;
    const updates: { id: number; stars: number; forks: number }[] = [];
    const batches = chunk(rows, 100);
    const gone: number[] = [];
    // 3 GraphQL requests in flight keeps us well under GitHub's secondary rate limits.
    for (let i = 0; i < batches.length; i += 3) {
      const group = batches.slice(i, i + 3);
      const results = await Promise.all(
        group.map((b) =>
          gql<{ nodes: any[] }>(
            `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Repository { databaseId nameWithOwner description stargazerCount forkCount } } }`,
            { ids: b.map((r) => r.node_id) },
          ),
        ),
      );
      // nodes() answers positionally, with null for a repo that was deleted or made private.
      const pairs = group.flatMap((b, j) => b.map((row, k) => [row, results[j].nodes[k]] as const));
      for (const [row, n] of pairs) {
        if (!n?.databaseId) {
          gone.push(row.id);
          continue;
        }
        const reason = spamReason({ full_name: n.nameWithOwner, description: n.description });
        if (reason) {
          console.log(`[spam] ${n.nameWithOwner}: ${reason}`);
          gone.push(row.id);
          continue;
        }
        if (row.stars !== n.stargazerCount || row.forks !== n.forkCount)
          updates.push({ id: row.id, stars: n.stargazerCount, forks: n.forkCount });
      }
    }
    // Hidden repos leave /admin/tracked, so each one costs a single D1 write.
    for (const part of chunk(gone, 1000)) await admin("/admin/hide", { ids: part });
    hidden += gone.length;
    for (const part of chunk(updates, 1000)) await admin("/admin/snapshots", { items: part, day: obsDay() });
    changed += updates.length;
  }
  console.log(`[snapshot ${scope}] ${tracked} tracked, ${changed} changed, ${hidden} hidden (spam, deleted or private)`);
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
  case "sweep":
    await sweep(Number(args[0] ?? 100));
    break;
  case "reclassify":
    await reclassify();
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
    console.log(await admin("/admin/rank", { day: obsDay(), periods: args.length ? args : undefined }));
    break;
  case "hot":
    await discover();
    await snapshot("hot");
    // Weekly and monthly windows move slowly: refresh them every 6 hours to save D1 writes.
    console.log(await admin("/admin/rank", { day: obsDay(), periods: new Date().getUTCHours() % 6 < 2 ? undefined : ["daily"] }));
    break;
  case "daily":
    await snapshot("all");
    // Before 03:00 UTC this closes yesterday: its daily ranking becomes final and the windows end on it.
    // When GitHub starts the job later than that, yesterday's daily ranking is still recomputed.
    if (obsDay() !== daysAgo(1)) console.log(await admin("/admin/rank", { day: daysAgo(1), periods: ["daily"] }));
    console.log(await admin("/admin/rank", { day: obsDay() }));
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s, ${pointsUsed} GraphQL points`);
