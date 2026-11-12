// Rule-based AI classifier. Returns null when the repo is not in the AI/agents niche.
// Order matters: the first category whose rule matches wins.

export type Category = "mcp" | "skills" | "coding" | "agents" | "rag" | "models" | "apps";

export const CATEGORIES: Record<Category, { label: string; blurb: string }> = {
  agents: { label: "Agents", blurb: "Autonomous agents, frameworks and orchestration" },
  mcp: { label: "MCP", blurb: "Model Context Protocol servers, clients and tooling" },
  skills: { label: "Skills", blurb: "Skills, rules, prompts and plugins for AI agents" },
  coding: { label: "Coding agents", blurb: "AI coding assistants, CLIs and IDE agents" },
  rag: { label: "RAG & memory", blurb: "Retrieval, vector search, knowledge and memory" },
  models: { label: "Models & inference", blurb: "Models, training, fine-tuning and inference engines" },
  apps: { label: "AI apps", blurb: "Products and tools built on LLMs" },
};

type Input = { name: string; description: string | null; topics: string[] };

const rules: [Category, RegExp][] = [
  ["mcp", /\bmcp\b|model[- ]context[- ]protocol|mcp[- ]?server/],
  ["skills", /\bskills?\b.*\b(claude|agent|codex|cursor)|\b(claude|agent|codex)[- ]skills?\b|agent-skills|cursor[- ]?rules|\bclaude\.md\b|\bagents\.md\b|prompt[- ]?(library|collection)|system[- ]prompts?|subagents?|slash[- ]commands?|claude[- ]code[- ]plugins?/],
  ["coding", /claude[- ]code|codex[- ]cli|coding[- ]agents?|ai[- ]coding|code[- ]assistant|copilot|vibe[- ]?coding|ai[- ]ide|\bcodex\b|gemini[- ]cli|opencode|aider|cursor\b/],
  ["agents", /\bagents?\b|agentic|multi[- ]agent|autonomous|langgraph|crewai|autogen|computer[- ]use|browser[- ]use|a2a\b/],
  ["rag", /\brag\b|retrieval|vector[- ]?(db|database|search|store)|embeddings?|knowledge[- ]graph|graphrag|semantic[- ]search|long[- ]term[- ]memory|agent[- ]memory/],
  ["models", /\bllama\b|\bvllm\b|inference|fine[- ]?tun|\blora\b|quantiz|gguf|\bonnx\b|transformers?\b|diffusion|text[- ]to[- ](speech|image|video)|\btts\b|speech[- ]to[- ]text|speech recognition|\basr\b|whisper|world[- ]model|foundation[- ]models?|image[- ]generation|video[- ]generation|vision[- ]language|reinforcement[- ]learning|\bvlm\b|multimodal|pretrain|distill|\bmoe\b/],
  ["apps", /\bllms?\b|\bgpt\b|chatgpt|openai|anthropic|\bclaude\b|gemini|deepseek|qwen|mistral|ollama|\bgenai\b|generative[- ]ai|\bai\b|artificial[- ]intelligence|chatbot|prompt|large[- ]language[- ]model|machine[- ]learning|deep[- ]learning|neural/],
];

/** Lowercased, with a dashed variant ("claude-code") and a spaced one ("claude code") so rules can use either. */
const norm = (parts: string[]) => {
  const dashed = parts.join(" ").toLowerCase();
  return [dashed, dashed.replace(/[-_.]/g, " ")];
};
const matches = (re: RegExp, texts: string[]) => texts.some((t) => re.test(t));

export function classify({ name, description, topics }: Input): Category | null {
  // The repo name (owner excluded: "MUSE-AI-Lab/x" says nothing about x) and the description say what a repo is;
  // topics are tag lists ("mcp" sits on n8n, dify and most agent frameworks), so they only break ties.
  // "apps" is the catch-all: it applies only when no specific category matched anywhere.
  const own = norm([name.split("/").pop() ?? name, description ?? ""]);
  const tags = norm(topics);
  for (const texts of [own, tags]) for (const [cat, re] of rules) if (cat !== "apps" && matches(re, texts)) return cat;
  const apps = rules.find(([cat]) => cat === "apps")![1];
  return matches(apps, own) || matches(apps, tags) ? "apps" : null;
}

// Topics and keyword queries used to discover candidate repositories via GitHub search.
export const DISCOVERY_TOPICS = [
  "llm", "ai-agents", "ai-agent", "agents", "agentic-ai", "mcp", "mcp-server", "model-context-protocol",
  "agent-skills", "claude-skills", "claude-code", "codex", "cursor", "rag", "langchain", "langgraph",
  "llama", "ollama", "vllm", "openai", "anthropic", "chatgpt", "gpt", "generative-ai", "genai",
  "large-language-models", "llmops", "ai", "artificial-intelligence", "machine-learning", "deep-learning",
  "vector-database", "embeddings", "fine-tuning", "inference", "diffusion", "multimodal", "computer-use",
  "browser-automation", "deepseek", "qwen", "gemini", "prompt-engineering", "ai-coding", "vibe-coding",
];

export const DISCOVERY_KEYWORDS = [
  "agent", "agents", "mcp", "llm", "claude", "codex", "skills", "rag", "gpt", "ai",
];

// Keywords for the weekly sweep of established repos (any creation date). Many popular AI repos carry no topics
// (anthropics/claude-code, openai/codex, karpathy/nanochat), so topic search alone misses them.
export const SWEEP_KEYWORDS = [
  ...DISCOVERY_KEYWORDS, "language model", "inference", "diffusion", "speech", "chatbot", "copilot", "embedding",
  "transformer", "neural", "machine learning", "deep learning", "openai", "anthropic", "gemini", "deepseek", "qwen",
  "ollama", "whisper", "model context protocol", "vlm", "foundation model", "image generation", "video generation",
  "vision language",
];
