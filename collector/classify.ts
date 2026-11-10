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
  ["coding", /claude[- ]code|codex[- ]cli|coding[- ]agents?|ai[- ]coding|code[- ]assistant|copilot|vibe[- ]?coding|ai[- ]ide|gemini[- ]cli|opencode|aider|cursor\b/],
  ["agents", /\bagents?\b|agentic|multi[- ]agent|autonomous|langgraph|crewai|autogen|computer[- ]use|browser[- ]use|a2a\b/],
  ["rag", /\brag\b|retrieval|vector[- ]?(db|database|search|store)|embeddings?|knowledge[- ]graph|graphrag|semantic[- ]search|long[- ]term[- ]memory|agent[- ]memory/],
  ["models", /\bllama\b|\bvllm\b|inference|fine[- ]?tun|\blora\b|quantiz|gguf|\bonnx\b|transformers?\b|diffusion|text[- ]to[- ](speech|image|video)|\btts\b|speech[- ]to[- ]text|whisper|world[- ]model|reinforcement[- ]learning|\bvlm\b|multimodal|pretrain|distill|\bmoe\b/],
  ["apps", /\bllms?\b|\bgpt\b|chatgpt|openai|anthropic|\bclaude\b|gemini|deepseek|qwen|mistral|ollama|\bgenai\b|generative[- ]ai|\bai\b|artificial[- ]intelligence|chatbot|prompt|large[- ]language[- ]model|machine[- ]learning|deep[- ]learning|neural/],
];

export function classify({ name, description, topics }: Input): Category | null {
  // Topics are the strongest signal; name and description fill in for repos without topics.
  const text = [topics.join(" "), name.replace(/[_/.]/g, " "), description ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/-/g, " ");
  const textDashed = [topics.join(" "), name, description ?? ""].join(" ").toLowerCase();
  for (const [cat, re] of rules) {
    if (re.test(text) || re.test(textDashed)) return cat;
  }
  return null;
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
