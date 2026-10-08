/* X (Twitter) Player Card. X reads the card tags on the shared page (/),
   shows twitter:image with a play button, and on click loads twitter:player
   (/embed) in an iframe inside the post. */

export const EMBED_PATH = "/embed";
const X_FRAME_ANCESTORS = Object.freeze([
  "https://x.com", "https://*.x.com", "https://twitter.com", "https://*.twitter.com",
]);
const TITLE = "Halo: Combat Evolved";
const DESCRIPTION = "Play Halo online in your browser. Click to drop into a live match.";
/* Halo art, so it is staged from port/web/assets (gitignored) like the rest of the UI. */
const CARD_IMAGE = "/assets/ui/shell/x-card.jpg";
const CARD_IMAGE_ALT = "Halo: Combat Evolved multiplayer in the browser";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function metaTags(origin, twitterSite) {
  const tags = [
    ["twitter:card", "player"],
    ["twitter:title", TITLE],
    ["twitter:description", DESCRIPTION],
    ["twitter:image", origin + CARD_IMAGE],
    ["twitter:image:alt", CARD_IMAGE_ALT],
    ["twitter:player", origin + EMBED_PATH],
    ["twitter:player:width", "640"],
    ["twitter:player:height", "360"],
    ["og:type", "website"],
    ["og:site_name", "Halo"],
    ["og:title", TITLE],
    ["og:description", DESCRIPTION],
    ["og:url", origin + "/"],
    ["og:image", origin + CARD_IMAGE],
    ["og:image:width", "1200"],
    ["og:image:height", "675"],
    ["og:image:alt", CARD_IMAGE_ALT],
  ];
  if (twitterSite) tags.splice(1, 0, ["twitter:site", twitterSite]);
  return tags.map(([name, content]) =>
    `<meta ${name.startsWith("og:") ? "property" : "name"}="${name}" content="${escapeHtml(content)}">`,
  ).join("\n  ");
}

/* The game page (index.html) for the shared URL, or for the X player frame.
   Returns the HTML and the headers to add to the site's security headers. */
export function gamePage(source, { url, twitterSite = "", extraFrameAncestors = "", embed = false }) {
  if (!source.includes("</head>") || !/<body\b/.test(source)) {
    throw new Error("index.html has no </head> or <body>");
  }
  const tags = embed
    ? '<meta name="robots" content="noindex">'
    : metaTags(url.origin, twitterSite);
  const html = source
    .replace("</head>", `  ${tags}\n</head>`)
    .replace(/<body\b/, embed ? '<body data-embed="x"' : "<body");
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
  };
  if (embed) {
    /* COOP/COEP isolate only a top-level page, and x.com isn't isolated, so the
       frame would have no SharedArrayBuffer and no threads. Document-Isolation-
       Policy isolates this document on its own, whatever embeds it (Chromium
       137+ on desktop). Elsewhere the page offers the full game in a new tab. */
    headers["Document-Isolation-Policy"] = "isolate-and-require-corp";
    headers["Content-Security-Policy"] = "frame-ancestors " +
      ["'self'", ...X_FRAME_ANCESTORS, ...extraFrameAncestors.split(/\s+/).filter(Boolean)].join(" ");
  }
  return { html, headers };
}
