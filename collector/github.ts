// Thin GitHub client: GraphQL for batched counts and metadata, REST for search.
// Handles primary and secondary rate limits by waiting instead of failing.

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export let pointsUsed = 0;

async function request(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "ai-trending-collector",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`GitHub ${res.status} after retries: ${await res.text()}`);
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const wait = retryAfter || (remaining === "0" && reset ? reset - Date.now() + 1000 : 2 ** attempt * 2000);
    console.warn(`GitHub ${res.status}, waiting ${Math.round(wait / 1000)}s`);
    await sleep(Math.max(wait, 1000));
    return request(url, init, attempt + 1);
  }
  return res;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await request("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query: query.replace(/}\s*$/, " rateLimit { cost remaining resetAt } }"), variables }),
  });
  const body = (await res.json()) as any;
  // Errors for individual missing/renamed repos are expected; only fail when nothing came back.
  if (!body.data) throw new Error(`GraphQL error: ${JSON.stringify(body.errors ?? body)}`);
  const rl = body.data.rateLimit;
  if (rl) {
    pointsUsed += rl.cost;
    if (rl.remaining < 50) {
      const wait = new Date(rl.resetAt).getTime() - Date.now() + 2000;
      console.warn(`GraphQL budget low (${rl.remaining}), waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  return body.data as T;
}

/** REST search. The search API allows 30 requests/minute, so calls are spaced 2.1s apart. */
let lastSearch = 0;
export async function searchRepos(q: string, page = 1): Promise<{ total_count: number; items: any[] }> {
  const wait = lastSearch + 2100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearch = Date.now();
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=stars&order=desc`;
  const res = await request(url);
  if (res.status === 422) return { total_count: 0, items: [] };
  if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
  return (await res.json()) as any;
}

export const REPO_FIELDS = `databaseId id nameWithOwner description primaryLanguage { name }
  repositoryTopics(first: 20) { nodes { topic { name } } } homepageUrl licenseInfo { spdxId }
  createdAt stargazerCount forkCount isFork isArchived isPrivate`;

export type RepoMeta = {
  id: number;
  node_id: string;
  full_name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  homepage: string | null;
  license: string | null;
  created_at: string;
  stars: number;
  forks: number;
  is_fork: boolean;
  archived: boolean;
};

export function fromGraphQL(r: any): RepoMeta {
  return {
    id: r.databaseId,
    node_id: r.id,
    full_name: r.nameWithOwner,
    description: r.description,
    language: r.primaryLanguage?.name ?? null,
    topics: r.repositoryTopics.nodes.map((n: any) => n.topic.name),
    homepage: r.homepageUrl || null,
    license: r.licenseInfo?.spdxId ?? null,
    created_at: r.createdAt,
    stars: r.stargazerCount,
    forks: r.forkCount,
    is_fork: r.isFork,
    archived: r.isArchived,
  };
}

export function fromSearch(r: any): RepoMeta {
  return {
    id: r.id,
    node_id: r.node_id,
    full_name: r.full_name,
    description: r.description,
    language: r.language,
    topics: r.topics ?? [],
    homepage: r.homepage || null,
    license: r.license?.spdx_id ?? null,
    created_at: r.created_at,
    stars: r.stargazers_count,
    forks: r.forks_count,
    is_fork: r.fork,
    archived: r.archived,
  };
}

/** Metadata for repos by full name, 50 per GraphQL query. Missing repos are skipped. */
export async function reposByName(names: string[]): Promise<RepoMeta[]> {
  const out: RepoMeta[] = [];
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    const query = `query { ${chunk
      .map((n, j) => {
        const [owner, name] = n.split("/");
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${REPO_FIELDS} }`;
      })
      .join("\n")} }`;
    const data = await gql(query);
    for (let j = 0; j < chunk.length; j++) if (data[`r${j}`]) out.push(fromGraphQL(data[`r${j}`]));
  }
  return out;
}
