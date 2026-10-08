import assert from "node:assert/strict";
import test from "node:test";

import { EMBED_PATH, gamePage } from "../src/embed.js";

const page = "<!doctypehtml><html lang=en><head><title>Halo</title></head><body class=x><main></main></body></html>";
const url = new URL("https://halois.fun/");

test("the shared page carries the X Player Card for /embed", () => {
  const { html, headers } = gamePage(page, { url, twitterSite: "@onchainqt" });
  assert.match(html, /<meta name="twitter:card" content="player">/);
  assert.match(html, /<meta name="twitter:site" content="@onchainqt">/);
  assert.match(html, /<meta name="twitter:player" content="https:\/\/halois\.fun\/embed">/);
  assert.match(html, /<meta name="twitter:player:width" content="640">/);
  assert.match(html, /<meta name="twitter:player:height" content="360">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/halois\.fun\/assets\/ui\/shell\/x-card\.jpg">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/halois\.fun\/">/);
  assert.match(html, /<body class=x>/);
  assert.ok(html.indexOf("twitter:card") < html.indexOf("</head>"));
  /* the page itself stays as it was: framing and isolation are /embed's */
  assert.equal(headers["Document-Isolation-Policy"], undefined);
  assert.equal(headers["Content-Security-Policy"], undefined);
});

test("no attribution without a site handle", () => {
  assert.doesNotMatch(gamePage(page, { url }).html, /twitter:site/);
});

test("the player frame isolates itself and only X may frame it", () => {
  const { html, headers } = gamePage(page, {
    url: new URL(EMBED_PATH, url), embed: true, extraFrameAncestors: " http://localhost:8790 ",
  });
  assert.match(html, /<body data-embed="x" class=x>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /twitter:card/, "the player must not name itself as a player");
  assert.equal(headers["Document-Isolation-Policy"], "isolate-and-require-corp");
  assert.equal(headers["Content-Security-Policy"],
    "frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com http://localhost:8790");
});

test("a page without a head or body is refused", () => {
  assert.throws(() => gamePage("<p>no</p>", { url }), /no <\/head> or <body>/);
});
