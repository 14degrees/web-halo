import { fomoDetectionEnabled } from "./fomo";

/* What the page needs to know about this deployment before anyone signs
   in (GET /v1/site, src/index.ts): where its links out go and which
   optional features are on. All of it is public configuration. */

/* a fomo.family referral code: letters and digits, as fomo's /r/ links use */
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_]{1,32}$/u;
export const DEFAULT_FOMO_REFERRAL_CODE = "ARCH";

export interface SiteLinks {
  /* the landing's fomo.family link, with the referral code */
  fomo: string;
  /* the game's X profile, or null while none is chosen */
  x: string | null;
}

export interface SiteInfo {
  links: SiteLinks;
  /* whether the Worker checks wallets against fomo (src/fomo.ts) */
  fomoDetection: boolean;
}

export function fomoReferralUrl(code: string | undefined): string {
  const chosen = typeof code === "string" && REFERRAL_CODE_PATTERN.test(code.trim()) ? code.trim() : DEFAULT_FOMO_REFERRAL_CODE;
  return `https://fomo.family/r/${chosen}`;
}

/* An X profile URL, or null for anything that is not one (unset, a
   placeholder, another site). */
export function xProfileUrl(setting: string | undefined): string | null {
  if (typeof setting !== "string" || setting.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(setting.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) {
    return null;
  }
  if (!/^\/[A-Za-z0-9_]{1,15}\/?$/u.test(url.pathname)) return null;
  return `https://x.com/${url.pathname.replaceAll("/", "")}`;
}

/* the settings as strings: the generated Env types them as the literals
   in wrangler.jsonc, which a deployment's own values are not */
export interface SiteSettings {
  FOMO_REFERRAL_CODE?: string;
  X_PROFILE_URL?: string;
  FOMO_RPC_URL?: string;
}

export function siteInfo(env: SiteSettings): SiteInfo {
  return {
    links: { fomo: fomoReferralUrl(env.FOMO_REFERRAL_CODE), x: xProfileUrl(env.X_PROFILE_URL) },
    fomoDetection: fomoDetectionEnabled(env),
  };
}
