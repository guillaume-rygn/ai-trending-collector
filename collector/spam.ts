// Spam detection on name/description: pirated-software and game-cheat bait ("Capcut Pro For Windows", "Revit 2026
// pre-configured environment", "Aion 2 trainer"). These repos usually ship malware in a release zip.
// An owner-followers rule (few followers + many stars = star farm) was tried and dropped: hundreds of legitimate
// repos (read-frog, slack-mcp-server, mcp-proxy...) belong to authors with 0-2 followers.
// Flagged repos are hidden, not deleted: `POST /admin/hide {"full_name", "hidden": 0}` + ALLOW restores one.

const BAIT = new RegExp(
  [
    String.raw`\bcrack(ed)? (version|software|download)\b`,
    String.raw`\bkeygen\b`,
    String.raw`\bactivat(or|ion key)\b`,
    String.raw`\b(license|serial|product) keys?\b`,
    String.raw`\bfree download\b`,
    String.raw`\bfull version\b`,
    String.raw`\bpre-?activated\b`,
    String.raw`\bpre-?configured environment\b`,
    String.raw`\bportable edition\b`,
    String.raw`\btrainer (tool|setup)\b|-trainer-tool\b`,
    String.raw`\bmod menu\b`,
    String.raw`\b(aimbot|wallhack|spoofer)\b`,
    String.raw`\b(roblox|fivem) executor\b`,
    String.raw`\b(pro|premium|ultimate)[\s-]+for[\s-]+(windows|pc|mac)\b`,
  ].join("|"),
  "i",
);

/** Repos verified by hand as legitimate despite matching a rule. */
const ALLOW = new Set<string>([]);

export type SpamInput = {
  full_name: string;
  description?: string | null;
};

export function spamReason(r: SpamInput): string | null {
  if (ALLOW.has(r.full_name.toLowerCase())) return null;
  const text = `${r.full_name.replace(/[/_-]/g, " ")} ${r.description ?? ""}`;
  const bait = text.match(BAIT);
  if (bait) return `bait "${bait[0]}"`;
  return null;
}
