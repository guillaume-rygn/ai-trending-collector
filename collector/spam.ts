// Spam and fake-star detection. Two signals, both cheap:
// 1. Name/description: pirated-software and game-cheat bait ("Capcut Pro For Windows", "Revit 2026 pre-configured
//    environment", "Aion 2 trainer"). These repos usually ship malware in a release zip.
// 2. Bought stars: a personal account with (almost) no followers whose repo collects hundreds of stars.
//    Real projects that popular gain followers for their author; star-farm campaigns use throwaway accounts.
// Flagged repos are hidden, not deleted: `POST /admin/hide {"full_name", "hidden": 0}` + ALLOW restores one.

const BAIT = new RegExp(
  [
    String.raw`\bcrack(ed|s)?\b`,
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

/** Stars above which a near-zero-follower personal account is treated as a star farm. */
const FARM_STARS = 100;
const FARM_MAX_FOLLOWERS = 2;

/** Repos verified by hand as legitimate despite matching a rule. */
const ALLOW = new Set<string>([]);

export type SpamInput = {
  full_name: string;
  description?: string | null;
  stars: number;
  owner_type?: string; // "User" | "Organization"
  owner_followers?: number | null;
};

export function spamReason(r: SpamInput): string | null {
  if (ALLOW.has(r.full_name.toLowerCase())) return null;
  const text = `${r.full_name.replace(/[/_-]/g, " ")} ${r.description ?? ""}`;
  const bait = text.match(BAIT);
  if (bait) return `bait "${bait[0]}"`;
  if (r.owner_type === "User" && r.owner_followers != null && r.owner_followers <= FARM_MAX_FOLLOWERS && r.stars >= FARM_STARS)
    return `star farm (${r.stars} stars, owner has ${r.owner_followers} followers)`;
  return null;
}
