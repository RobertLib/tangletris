#!/usr/bin/env node
/* ==========================================================================
   Builds the content pages around the game — how to play, the pieces, the
   worlds and the Daily Tangle, in English and Czech — and sitemap.xml.

     node dev/build-pages.mjs        (from the repo root, Node 22+: it imports the game's own modules)

   The output is checked in, so the site stays plain static files with no
   build step for visitors. Run this again after changing the copy below or
   anything it reads from the game: the piece catalogue (js/pieces.js), the
   world names and palettes (js/scenes/meta.js, js/scenes/index.js for the
   Journey order) and the soundtracks (js/audio/tracks.js). World
   screenshots in img/worlds/ are optional; without one a world card falls
   back to a gradient in its palette. Copy lives here as data, English and Czech side by
   side, and every page goes through one layout.

   Links between pages are relative so the site works both from the repo
   root on a local server and under /tangletris/ on GitHub Pages; only the
   canonical, hreflang and Open Graph URLs are absolute.
   ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://robertlib.github.io/tangletris/";
const LASTMOD = "2026-11-13";
const OG_IMAGE = BASE + "og-image.jpg";
const GITHUB = "https://github.com/RobertLib/tangletris";
const AUTHOR = "Robert Libsansky";

const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* ------------------------------------------------------------ game data */

// Imports one of the game's dependency-free modules. js/ has no package.json
// saying "type": "module": Node 22+ notices the ESM syntax on its own, older
// versions get the same file as a data: URL.
async function loadModule(path) {
  try {
    return await import(pathToFileURL(join(ROOT, path)).href);
  } catch (e) {
    return import("data:text/javascript;charset=utf-8," + encodeURIComponent(read(path)));
  }
}
const { PIECES, CLASSIC_COUNT = 7 } = await loadModule("js/pieces.js");

// World names and palettes (no three.js in there, unlike the scene files).
let SCENE_META = {};
try {
  SCENE_META = (await loadModule("js/scenes/meta.js")).META || {};
} catch (e) {
  console.warn("build-pages: js/scenes/meta.js could not be loaded — reading the scene files instead");
}

// The level ramp of the odd shapes and the gravity curve, straight from the
// rules, so the guide pages cannot drift from the game. game.js imports its
// neighbours by relative path, which the data: URL fallback cannot resolve —
// it needs a Node that loads ES modules from .js files (22 or later).
let RULES;
try {
  RULES = await import(pathToFileURL(join(ROOT, "js/game.js")).href);
} catch (e) {
  console.error("build-pages: js/game.js could not be imported — run this with Node 22 or later.");
  throw e;
}
const tangleRatio = RULES.levelTangle;
const fallMs = RULES.fallInterval;
const FULL_TANGLE_LEVEL = (() => {
  let l = 1;
  while (tangleRatio(l) < 1) l++;
  return l;
})();
const FLOOR_LEVEL = (() => {
  let l = 1;
  while (fallMs(l) > 70) l++;
  return l;
})();

const CLASSIC_W = PIECES.slice(0, CLASSIC_COUNT).reduce((s, p) => s + p.weight, 0);
const TANGLE_W = PIECES.slice(CLASSIC_COUNT).reduce((s, p) => s + p.weight, 0);
const ODD_COUNT = PIECES.length - CLASSIC_COUNT;

// Average share of odd pieces in the bag at a given level.
const oddShare = (level) => (TANGLE_W * tangleRatio(level)) / (CLASSIC_W + TANGLE_W * tangleRatio(level));

// "1 in N pieces" for piece i at a level.
function oneIn(i, level) {
  const r = tangleRatio(level);
  const w = i < CLASSIC_COUNT ? PIECES[i].weight : PIECES[i].weight * r;
  return Math.round((CLASSIC_W + TANGLE_W * r) / w);
}

function shapeOf(p) {
  const h = p.cells.length;
  const w = p.cells[0].length;
  let n = 0;
  for (const row of p.cells) for (const c of row) n += c ? 1 : 0;
  return { w, h, n };
}

function rarityOf(i) {
  if (i < CLASSIC_COUNT) return "classic";
  const w = PIECES[i].weight;
  return w >= 3 ? "common" : w === 2 ? "uncommon" : "rare";
}

// Worlds: Journey order from scenes/index.js, names and palettes from
// scenes/meta.js (or, failing that, the scene files), soundtracks from
// tracks.js. The values below only stand in if nothing can be read, and the
// build says so.
const FALLBACK_WORLDS = {
  neon: { name: "Neon Drive", accent: "#22d3ee", accent2: "#f472b6", board: "#0c0620" },
  ocean: { name: "Deep Blue", accent: "#3ee8f2", accent2: "#ff8ad8", board: "#03122a" },
  sakura: { name: "Sakura", accent: "#ff8fbf", accent2: "#ffbe5c", board: "#150a1f" },
  frost: { name: "Frost", accent: "#4ff0b4", accent2: "#a78bfa", board: "#051220" },
  cosmos: { name: "Starfall", accent: "#a78bfa", accent2: "#fbbf5c", board: "#070618" },
  inferno: { name: "Inferno", accent: "#ff6a1a", accent2: "#ffc53d", board: "#120605" },
};
const FALLBACK_TRACKS = {
  neon: { title: "Midnight Overdrive", bpm: 104, key: "A", mode: "aeolian" },
  ocean: { title: "Abyssal Drift", bpm: 84, key: "D", mode: "dorian" },
  sakura: { title: "Petals on Still Water", bpm: 92, key: "D", mode: "in" },
  frost: { title: "Northern Lights", bpm: 80, key: "C#", mode: "aeolian" },
  cosmos: { title: "Orbit of Glass", bpm: 98, key: "E", mode: "lydian" },
  inferno: { title: "Forge of the Mountain", bpm: 128, key: "E", mode: "phrygianDominant" },
};

function readWorlds() {
  const warn = (m) => console.warn("build-pages: " + m + " — using the built-in value");
  let journey = Object.keys(FALLBACK_WORLDS);
  try {
    const m = /JOURNEY\s*=\s*\[([^\]]+)\]/.exec(read("js/scenes/index.js"));
    if (m) journey = [...m[1].matchAll(/["'](\w+)["']/g)].map((x) => x[1]);
    else warn("JOURNEY not found in js/scenes/index.js");
  } catch (e) {
    warn("js/scenes/index.js unreadable");
  }
  let tracks = "";
  try {
    tracks = read("js/audio/tracks.js");
  } catch (e) {
    warn("js/audio/tracks.js unreadable");
  }
  return journey.map((id, idx) => {
    const fb = FALLBACK_WORLDS[id] || {};
    let src = "";
    try {
      src = read(`js/scenes/${id}.js`);
    } catch (e) {
      /* falls back below */
    }
    try {
      src += "\n" + (read("js/scenes/meta.js").split(new RegExp(`\\b${id}:\\s*\\{`))[1] || "");
    } catch (e) {
      /* no meta.js */
    }
    // scenes/meta.js first; then the scene file's default export, then the
    // whole file.
    const meta = SCENE_META[id] || {};
    const at = src.indexOf("export default");
    const scopes = [at >= 0 ? src.slice(at, at + 5000) : "", src];
    const pick = (key) => {
      const known = key === "name" ? meta.name : meta.palette && meta.palette[key];
      if (typeof known === "string") return known;
      for (const s of scopes) {
        const m = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(s);
        if (m) return m[1];
      }
      if (fb[key]) warn(`${key} of world "${id}" not found`);
      return fb[key];
    };
    const world = {
      id,
      level: idx + 1,
      name: pick("name"),
      accent: pick("accent"),
      accent2: pick("accent2"),
      board: pick("board"),
    };
    const tfb = FALLBACK_TRACKS[id] || {};
    const ti = tracks.search(new RegExp(`\\n\\s+${id}:\\s*\\{`));
    const tsrc = ti >= 0 ? tracks.slice(ti, ti + 800) : "";
    const tget = (re, key) => {
      const m = re.exec(tsrc);
      if (m) return m[1];
      warn(`soundtrack ${key} of "${id}" not found`);
      return tfb[key];
    };
    world.track = {
      title: tget(/title:\s*"([^"]+)"/, "title"),
      bpm: +tget(/bpm:\s*(\d+)/, "bpm"),
      key: tget(/key:\s*"([^"]+)"/, "key"),
      mode: tget(/mode:\s*"([^"]+)"/, "mode"),
    };
    return world;
  });
}
const WORLDS = readWorlds();
const worldAtLevel = (level) => WORLDS[(level - 1) % WORLDS.length];

/* -------------------------------------------------------------- helpers */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// HTML copy to plain text, for JSON-LD.
function plain(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Relative link between two directory paths of the site ("" is the root).
function rel(from, to) {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const r = "../".repeat(a.length - i) + b.slice(i).map((s) => s + "/").join("");
  return r || "./";
}

function slug(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// English: one / other. Czech: one / 2–4 / 5 and up.
function plural(lang, n, forms) {
  if (lang === "cs") return n === 1 ? forms[0] : n >= 2 && n <= 4 ? forms[1] : forms[2];
  return n === 1 ? forms[0] : forms[1];
}

const NBSP = "\u00a0";

// "a, b and c" / "a, b a c".
function joinList(lang, items) {
  if (items.length < 2) return items.join("");
  return items.slice(0, -1).join(", ") + (lang === "cs" ? " a " : " and ") + items[items.length - 1];
}
const pct = (lang, x) => Math.round(x * 100) + (lang === "cs" ? NBSP + "%" : "%");
const kbd = (keys) => keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ");

/* ----------------------------------------------------------- site map */

// Every page is a directory with an index.html. The game itself is "" (EN)
// and "cs/" (CS) — those two are written by hand, not here.
const GAME = { en: "", cs: "cs/" };
const PAGES = {
  howto: { en: "how-to-play/", cs: "cs/jak-hrat/" },
  pieces: { en: "pieces/", cs: "cs/tvary/" },
  worlds: { en: "worlds/", cs: "cs/svety/" },
  daily: { en: "daily/", cs: "cs/denni/" },
};
const NAV_ORDER = ["howto", "pieces", "worlds", "daily"];

const UI = {
  skip: { en: "Skip to content", cs: "Přeskočit na obsah" },
  logoHint: { en: " – play the game", cs: " – hrát hru" },
  mainNav: { en: "Main", cs: "Hlavní" },
  footerNav: { en: "Site", cs: "Stránky" },
  crumbs: { en: "Breadcrumb", cs: "Drobečková navigace" },
  otherLang: { en: "Česky", cs: "English" },
  otherLangLabel: { en: "Tato stránka česky", cs: "This page in English" },
  nav: {
    game: { en: "Play", cs: "Hrát" },
    howto: { en: "How to play", cs: "Jak hrát" },
    pieces: { en: "Pieces", cs: "Tvary" },
    worlds: { en: "Worlds", cs: "Světy" },
    daily: { en: "Daily", cs: "Denní Tangle" },
  },
  play: { en: "Play Tangletris", cs: "Hrát Tangletris" },
  author: { en: "Made by " + AUTHOR, cs: "Autor: " + AUTHOR },
  licence: {
    en: `Free and open source under the <a href="${GITHUB}/blob/main/LICENSE">MIT licence</a>`,
    cs: `Zdarma a open source pod <a href="${GITHUB}/blob/main/LICENSE">licencí MIT</a>`,
  },
  source: {
    en: `<a href="${GITHUB}">Source code on GitHub</a>`,
    cs: `<a href="${GITHUB}">Zdrojový kód na GitHubu</a>`,
  },
  tm: {
    en: "Tetris® is a trademark of The Tetris Company. Tangletris is an independent game and is not affiliated with it.",
    cs: "Tetris® je ochranná známka společnosti The Tetris Company. Tangletris je nezávislá hra a s ní není nijak spojena.",
  },
};

/* --------------------------------------------------------------- layout */

function context(lang, key) {
  const path = PAGES[key][lang];
  const ctx = {
    lang,
    key,
    path,
    t: (o) => (o && typeof o === "object" && "en" in o ? o[lang] : o),
    root: rel(path, ""),
    game: rel(path, GAME[lang]),
    play: (mode) => rel(path, GAME[lang]) + (mode ? "?mode=" + mode : ""),
    page: (k, hash) => rel(path, PAGES[k][lang]) + (hash ? "#" + hash : ""),
    url: (k) => BASE + (k === "game" ? GAME[lang] : PAGES[k][lang]),
  };
  // {play}, {play:daily}, {page:pieces} inside copy become relative links.
  ctx.fill = (s) =>
    ctx.t(s).replace(/\{(play|page)(?::([a-z]+))?\}/g, (m, kind, arg) =>
      kind === "play" ? ctx.play(arg) : ctx.page(arg)
    );
  return ctx;
}

function jsonLd(obj) {
  // "<" escaped so no string can close the script element.
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

function breadcrumbLd(c, name) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Tangletris", item: c.url("game") },
      { "@type": "ListItem", position: 2, name, item: c.url(c.key) },
    ],
  };
}

function layout(c, page) {
  const { lang, key } = c;
  const other = lang === "en" ? "cs" : "en";
  const canonical = BASE + PAGES[key][lang];
  const navName = c.t(UI.nav[key]);
  const ld = [breadcrumbLd(c, navName)].concat(page.ld || []);

  const navLinks = (cls) =>
    [`<li><a${cls ? ` class="${cls}"` : ""} href="${c.game}">${c.t(UI.nav.game)}</a></li>`]
      .concat(
        NAV_ORDER.map((k) => {
          const cur = k === key ? ' aria-current="page"' : "";
          return `<li><a href="${c.page(k)}"${cur}>${c.t(UI.nav[k])}</a></li>`;
        })
      )
      .join("\n          ");

  // Czech needs the Latin Extended subset of the body font straight away.
  const preloads = ["press-start-2p-latin.woff2", "space-grotesk-latin.woff2"]
    .concat(lang === "cs" ? ["space-grotesk-latin-ext.woff2"] : [])
    .map((f) => `<link rel="preload" href="${c.root}fonts/${f}" as="font" type="font/woff2" crossorigin>`)
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>${esc(c.t(page.title))}</title>
    <meta name="description" content="${esc(c.t(page.description))}">
    <meta name="author" content="${AUTHOR}">
    <meta name="theme-color" content="#0c0620">
    <meta name="color-scheme" content="dark">
    <link rel="canonical" href="${canonical}">
    <link rel="alternate" hreflang="en" href="${BASE + PAGES[key].en}">
    <link rel="alternate" hreflang="cs" href="${BASE + PAGES[key].cs}">
    <link rel="alternate" hreflang="x-default" href="${BASE + PAGES[key].en}">

    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Tangletris">
    <meta property="og:locale" content="${lang === "cs" ? "cs_CZ" : "en_US"}">
    <meta property="og:locale:alternate" content="${lang === "cs" ? "en_US" : "cs_CZ"}">
    <meta property="og:title" content="${esc(c.t(page.ogTitle || page.title))}">
    <meta property="og:description" content="${esc(c.t(page.description))}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${OG_IMAGE}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${esc(
      c.t({
        en: "Tangletris: a glossy 3D falling-block board in front of a cherry-blossom lake at twilight",
        cs: "Tangletris: lesklá 3D deska s padajícími kostkami před jezerem se sakurami za soumraku",
      })
    )}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(c.t(page.ogTitle || page.title))}">
    <meta name="twitter:description" content="${esc(c.t(page.description))}">
    <meta name="twitter:image" content="${OG_IMAGE}">

    <link rel="icon" href="${c.root}icon.svg" type="image/svg+xml">
    <link rel="icon" href="${c.root}icons/icon-192.png" sizes="192x192" type="image/png">
    <link rel="apple-touch-icon" href="${c.root}icons/apple-touch-icon.png">
    <link rel="manifest" href="${c.root}${lang === "cs" ? "cs/" : ""}manifest.webmanifest">
    ${preloads}
    <link rel="stylesheet" href="${c.root}pages.css">
    ${ld.map(jsonLd).join("\n    ")}
  </head>
  <body>
    <a class="skip" href="#main">${c.t(UI.skip)}</a>

    <header class="site-header">
      <div class="wrap header-inner">
        <a class="logo" href="${c.game}"><span class="logo-a">Tangle</span><span class="logo-b">tris</span><span class="sr-only">${c.t(UI.logoHint)}</span></a>
        <nav class="site-nav" aria-label="${c.t(UI.mainNav)}">
          <ul>
          ${navLinks("nav-play")}
          </ul>
        </nav>
        <a class="lang-switch" href="${rel(PAGES[key][lang], PAGES[key][other])}" hreflang="${other}" lang="${other}" aria-label="${c.t(UI.otherLangLabel)}">${c.t(UI.otherLang)}</a>
      </div>
    </header>

    <main id="main">
      <div class="wrap">
        <div class="hero">
          <nav class="crumbs" aria-label="${c.t(UI.crumbs)}">
            <ol>
              <li><a href="${c.game}">Tangletris</a></li>
              <li><span aria-current="page">${navName}</span></li>
            </ol>
          </nav>
          <h1>${c.t(page.h1)}</h1>
          ${page.hero}
        </div>
${page.body}
        <section class="section cta-final panel" aria-labelledby="cta-final">
          ${page.final}
        </section>
      </div>
    </main>

    <footer class="site-footer">
      <div class="wrap">
        <nav class="footer-nav" aria-label="${c.t(UI.footerNav)}">
          <ul>
          ${navLinks("")}
          </ul>
        </nav>
        <p>${c.t(UI.author)} · ${c.t(UI.licence)} · ${c.t(UI.source)}</p>
        <p class="tm">${c.t(UI.tm)}</p>
      </div>
    </footer>${page.scripts ? "\n" + page.scripts : ""}
  </body>
</html>
`;
}

// The hero's buttons and the closing call to action share this.
function ctaRow(buttons) {
  return `<div class="cta-row">
            ${buttons
              .map(
                (b, i) =>
                  `<a class="btn ${i === 0 ? "btn-primary btn-play" : "btn-ghost"}" href="${b.href}">${b.label}</a>`
              )
              .join("\n            ")}
          </div>`;
}

function finalCta(c, title, text, buttons) {
  return `<h2 id="cta-final">${c.t(title)}</h2>
          <p>${c.fill(text)}</p>
          ${ctaRow(buttons)}`;
}

/* =============================================================== PIECES */

// One or two sentences per piece on where it wants to go, worked out from
// its actual cells. Vocabulary (well, dip, step, bump) is defined on the page.
const ADVICE = {
  Line: {
    en: "The only straight four. Keep a one-wide well open at the side of your stack and save it for a Tangle; lying flat, it caps a level four-wide stretch.",
    cs: "Jediná rovná čtyřka. Nech si u kraje volnou šachtu a Čáru si schovej na Tangle; naležato zakryje rovný úsek široký čtyři pole.",
  },
  Square: {
    en: "Rotating does nothing, so it’s all about where: a level two-wide floor. Dropped on a step it always buries a hole — with no flat pair of columns around, hold it.",
    cs: "Otáčení s ním nic neudělá, jde jen o to kam: na rovnou plochu širokou dvě pole. Na schodu pod sebou vždycky zazdí díru – když nemáš dva rovné sloupce, odlož ho.",
  },
  Tee: {
    en: "The most adaptable classic: point-down it plugs a one-cell dip, flat side down it caps a level three-wide stretch, and on its side it sits on a one-cell step.",
    cs: "Nejpřizpůsobivější z klasiky: špičkou dolů ucpe důlek, plochou stranou dolů zakryje rovný úsek na tři pole a nastojato sedne na schod o jedno pole.",
  },
  Ess: {
    en: "Flat, it wants a step that rises one cell to the right; stood up, a step that rises to the left. On a level floor it always leaves a hole — that’s a job for the hold slot.",
    cs: "Naležato potřebuje schod, který doprava stoupá o jedno pole, nastojato schod stoupající doleva. Na rovině vždycky nechá díru – to je práce pro odložení.",
  },
  Zee: {
    en: "The Ess in a mirror: flat, it wants a step rising one cell to the left; stood up, one rising to the right. Keep one such step on your surface and it never hurts.",
    cs: "Zrcadlová Eska: naležato chce schod stoupající o jedno pole doleva, nastojato doprava. Když na povrchu udržíš aspoň jeden takový schod, nikdy neublíží.",
  },
  Jay: {
    en: "Four ways to land: flat on a level three-wide stretch, upright on a level two-wide floor, upside down with its foot one cell lower than the bar, or long side down into a two-deep slot beside a taller column.",
    cs: "Dopadnout umí čtyřmi způsoby: naležato na rovný úsek tří polí, nastojato na rovnou dvojici sloupců, vzhůru nohama s nožkou o pole níž než příčka, nebo dlouhou stranou do dvě pole hluboké mezery vedle vyššího sloupce.",
  },
  Ell: {
    en: "The Jay’s mirror twin, with the same four landings flipped left to right. Between the two of them, almost any surface has a home for an L-shape.",
    cs: "Zrcadlové dvojče Jéčka – stejné čtyři způsoby dopadu, jen převrácené zleva doprava. Spolu najdou místo skoro na jakémkoli povrchu.",
  },
  Dot: {
    en: "One cell: it fills any single hole you can reach. Thanks to the lock delay you can even slide it sideways under an overhang to plug a gap that looks sealed.",
    cs: "Jedno pole, které zalepí jakoukoli díru, ke které se dostaneš. Díky prodlevě před zamknutím ji zasuneš i bokem pod převis a ucpeš mezeru, která vypadá zazděná.",
  },
  Domino: {
    en: "Two cells that never leave a hole on a level floor. Standing, it finishes a two-deep well; lying down, it closes a two-wide gap. Save it for repairs.",
    cs: "Dvě pole, která na rovině nikdy nenechají díru. Nastojato dorovná dvě pole hlubokou šachtu, naležato zavře mezeru širokou dvě pole. Šetři si ho na opravy.",
  },
  Corner: {
    en: "A three-cell L that sits on a one-cell step from either side and squares off any inside corner — one of the friendliest odd shapes.",
    cs: "Malé eLko ze tří polí, které sedne na schod o jedno pole z obou stran a každý vnitřní roh zase zarovná. Jeden z nejpřátelštějších divných tvarů.",
  },
  Heart: {
    en: "It arrives point down and needs a dip exactly one cell wide and deep; on a flat floor it leaves a hole under each lobe. Flipped lobes down, it straddles a single one-cell bump.",
    cs: "Přiletí špičkou dolů a chce důlek široký i hluboký přesně jedno pole; na rovině nechá díru pod každým obloučkem. Otočené obloučky dolů zase obkročí jeden výstupek.",
  },
  Plus: {
    en: "Rotating changes nothing, so the surface decides: it needs a one-wide dip with shoulders exactly one cell higher. Anywhere else, its arms trap two holes.",
    cs: "Otáčení na něm nic nezmění, rozhoduje povrch: potřebuje důlek široký jedno pole s rameny přesně o pole výš. Jinde pod rameny uvězní dvě díry.",
  },
  Cup: {
    en: "Bottom down, it sits cleanly on a level three-wide floor and leaves a one-cell cup on top — a perfect parking spot for a Dot or the point of a Tee. Upside down, it swallows a single bump.",
    cs: "Dnem dolů sedí čistě na rovném úseku tří polí a nahoře nechá misku na jedno pole – ideální místo pro Tečku nebo špičku Téčka. Vzhůru nohama spolkne jeden výstupek.",
  },
  Zigzag: {
    en: "Lying down, it fits any floor with a one-cell step in it; standing, it needs a two-cell drop between neighbouring columns. Like the Ess and Zee, it can’t land on a perfectly level floor without leaving a hole.",
    cs: "Naležato sedne na každou plochu se schodem o jedno pole, nastojato potřebuje mezi sousedními sloupci rozdíl dvou polí. Stejně jako Eska a Zetko nedopadne na úplnou rovinu bez díry.",
  },
  Giraffe: {
    en: "A Line with a foot. Upright, it stands on a level two-wide floor; lying down, it caps a level four-wide stretch. It’s four cells tall, so in a deep enough well it can clear four rows at once.",
    cs: "Čára s nožkou. Nastojato stojí na rovné dvojici sloupců, naležato zakryje rovný úsek na čtyři pole. Je vysoká čtyři pole, takže v dost hluboké šachtě smaže i čtyři řady naráz.",
  },
  Puzzle: {
    en: "Messier than it looks, but forgiving: one turn plugs a one-cell dip, another a dip with lopsided shoulders, and the other two sit on a one-cell step either way. Try every turn before you reach for hold.",
    cs: "Vypadá zmateně, ale je shovívavý: v jedné poloze ucpe důlek, v druhé důlek s nestejně vysokými rameny a ve zbylých dvou sedne na schod o jedno pole na kteroukoli stranu. Než ho odložíš, zkus všechny polohy.",
  },
  Arrow: {
    en: "Two of its turns have a flat three-wide base that sits cleanly on a level floor and leaves a staircase on top — just what the Ess, Zee and Corner like. The other two fill a staircase that climbs one cell per column.",
    cs: "Ve dvou polohách má rovnou základnu na tři pole, čistě dosedne na rovinu a nahoře nechá schody – přesně to, co mají rády Eska, Zetko a Roh. Ve zbylých dvou vyplní schodiště, které stoupá o pole na sloupec.",
  },
  Lightning: {
    en: "Lying down, it fits a floor that steps up one cell halfway along, or a little staircase; standing, it needs a ledge two cells above the floor beside it. With none of those on your surface, hold it.",
    cs: "Naležato sedne na plochu, která v půlce stoupne o jedno pole, nebo na malé schodiště; nastojato potřebuje římsu o dvě pole výš než podlaha vedle. Když nic z toho na povrchu nemáš, odlož ho.",
  },
  Tree: {
    en: "Trunk first: it slides into a one-wide well two cells deep, its branches resting on the shoulders either side. Sideways, it’s a four-wide bar with a knob underneath that needs a one-cell dip to sit in.",
    cs: "Kmenem napřed: zasune se do šachty široké jedno pole a hluboké dvě, větve se opřou o ramena po stranách. Naležato je to tyč na čtyři pole s výčnělkem dole, který potřebuje důlek.",
  },
  Star: {
    en: "The meanest rare shape: whichever way you turn it, it has a pocket in its own side that nothing can drop into. Accept the hole and choose where it goes — high up, near an edge, away from your Tangle well.",
    cs: "Nejzlomyslnější vzácný tvar: ať ji otočíš jakkoli, má v boku kapsu, do které nic nespadne. Smiř se s dírou a vyber, kde bude – vysoko, u kraje a daleko od šachty na Tangle.",
  },
  "Letter A": {
    en: "Its legs straddle a one-wide spike two cells tall — exactly what a standing Domino leaves on a flat floor. Upside down, it needs a one-cell dip and leaves a two-deep slot on top for a Domino or a Line.",
    cs: "Nohama obkročí úzký výstupek vysoký dvě pole – přesně to, co na rovině nechá Domino nastojato. Vzhůru nohama potřebuje důlek a nahoře nechá dvě pole hlubokou mezeru pro Domino nebo Čáru.",
  },
  Spiral: {
    en: "Turn it so it opens upwards: then it sits flat on a level three-wide floor and leaves a two-deep slot in the middle for a Domino or a Line. Opening sideways, it traps two cells under its top bar.",
    cs: "Otoč ji otvorem nahoru: pak sedí rovně na úseku tří polí a uprostřed nechá dvě pole hlubokou mezeru pro Domino nebo Čáru. Otvorem do boku uvězní pod horní příčkou dvě pole.",
  },
  Rocket: {
    en: "Eight cells, tied with the Letter A as the biggest piece. Nose down, it needs a one-wide dip; sideways, a two-wide dip one cell deep — on a flat floor its fins bury holes. Clearing a line with it unlocks an achievement.",
    cs: "Osm polí – spolu s Písmenem A největší kostka ve hře. Špičkou dolů potřebuje důlek široký jedno pole, naležato důlek široký dvě pole a hluboký jedno; na rovině pod křidélky zazdí díry. Když s ní smažeš řadu, odemkneš úspěch.",
  },
  Dice: {
    en: "Five cells that touch only at their corners, so it always leaves holes. Park it in hold, or drop it high up on a side where the holes won’t block a line you need.",
    cs: "Pět polí, která se dotýkají jen rohy, takže díry nechá vždycky. Odlož ji, nebo ji pusť vysoko u kraje, kde díry nezablokují řadu, kterou potřebuješ.",
  },
};

const RARITY = {
  classic: { en: "Classic", cs: "Klasika" },
  common: { en: "Common", cs: "Běžný" },
  uncommon: { en: "Uncommon", cs: "Méně častý" },
  rare: { en: "Rare", cs: "Vzácný" },
};

const GROUPS = [
  {
    id: "classic",
    title: { en: "The classic seven", cs: "Klasická sedmička" },
    text: {
      en: "The seven tetrominoes, four cells each. Every bag holds all of them, so they stay the backbone of your stack at every level.",
      cs: "Sedm tetromin po čtyřech polích. Jsou v každém balíčku, takže na všech levelech tvoří páteř tvé hromady.",
    },
  },
  {
    id: "common",
    title: { en: "Common odd shapes", cs: "Běžné divné tvary" },
    text: {
      en: "Weight 3: up to three copies of each per bag. Small and friendly — mostly repair tools.",
      cs: "Váha 3: v balíčku až tři kopie od každého. Malé a přátelské – hlavně nářadí na opravy.",
    },
  },
  {
    id: "uncommon",
    title: { en: "Uncommon odd shapes", cs: "Méně časté divné tvary" },
    text: {
      en: "Weight 2: up to two copies of each per bag. Five- and six-cell shapes that each want a particular surface.",
      cs: "Váha 2: v balíčku až dvě kopie od každého. Tvary z pěti a šesti polí, z nichž každý chce určitý povrch.",
    },
  },
  {
    id: "rare",
    title: { en: "Rare odd shapes", cs: "Vzácné divné tvary" },
    text: {
      en: "Weight 1: at most one copy per bag. The big, awkward ones — plan a spot for them or park them in hold.",
      cs: "Váha 1: v balíčku nejvýš jedna kopie. Velké a neohrabané kusy – připrav jim místo, nebo je odlož.",
    },
  },
];

// A piece drawn from its cells: rounded squares in its colour with a light
// top edge and a darker bottom one, like the game's bevelled blocks.
function pieceSvg(p, label) {
  const U = 20;
  const { w, h } = shapeOf(p);
  let cells = "";
  p.cells.forEach((row, y) =>
    row.forEach((on, x) => {
      if (!on) return;
      const px = x * U + 1;
      const py = y * U + 1;
      const s = U - 2;
      cells +=
        `<rect x="${px}" y="${py}" width="${s}" height="${s}" rx="4"/>` +
        `<rect x="${px + 2}" y="${py + 2}" width="${s - 4}" height="4" rx="2" fill="#fff" fill-opacity=".45"/>` +
        `<rect x="${px + 2}" y="${py + s - 5}" width="${s - 4}" height="3" rx="1.5" fill="#000" fill-opacity=".25"/>`;
    })
  );
  return `<svg viewBox="0 0 ${w * U} ${h * U}" width="${w * U}" height="${h * U}" role="img" aria-label="${esc(label)}"><g fill="${p.color}">${cells}</g></svg>`;
}

function piecesPage(lang) {
  const c = context(lang, "pieces");
  const name = (p) => (lang === "cs" ? p.cs : p.name);
  const nameOf = (en) => name(PIECES.find((p) => p.name === en) || { name: en, cs: en });
  const rocketIdx = PIECES.findIndex((p) => p.name === "Rocket");
  const tall = PIECES.filter((p, i) => i > 0 && Math.max(...Object.values(shapeOf(p)).slice(0, 2)) >= 4).map(name);
  const list = (items) => joinList(lang, items);

  const card = (p, i) => {
    const { w, h, n } = shapeOf(p);
    const r = rarityOf(i);
    const id = slug(name(p));
    const cellsWord = plural(lang, n, lang === "cs" ? ["pole", "pole", "polí"] : ["cell", "cells"]);
    const label = c.t({
      en: `${p.name}: ${n} ${cellsWord}, ${w} wide and ${h} tall`,
      cs: `${p.cs}: ${n} ${cellsWord}, šířka ${w}, výška ${h}`,
    });
    const copies =
      i < CLASSIC_COUNT
        ? c.t({
            en: `${p.weight} in every bag`,
            cs: `${p.weight} ${plural(lang, p.weight, ["kopie", "kopie", "kopií"])} v každém balíčku`,
          })
        : p.weight === 1
        ? c.t({ en: "at most 1 per bag", cs: "v balíčku nejvýš 1 kopie" })
        : c.t({
            en: `up to ${p.weight} per bag`,
            cs: `v balíčku až ${p.weight} ${plural(lang, p.weight, ["kopie", "kopie", "kopií"])}`,
          });
    const f1 = oneIn(i, 1);
    const f6 = oneIn(i, FULL_TANGLE_LEVEL);
    const freq = c.t({
      en: `About 1 in ${f1} pieces at level${NBSP}1, 1 in ${f6} from level${NBSP}${FULL_TANGLE_LEVEL}.`,
      cs: `Zhruba 1 z ${f1} kostek na levelu${NBSP}1, 1 z ${f6} od levelu${NBSP}${FULL_TANGLE_LEVEL}.`,
    });
    return `<li class="card piece" id="${id}">
              <div class="piece-art">${pieceSvg(p, label)}</div>
              <div class="piece-head">
                <h3><span class="emoji" aria-hidden="true">${p.emoji}</span> ${esc(name(p))}</h3>
                <ul class="tags">
                  <li class="tag tag-${r}">${c.t(RARITY[r])}</li>
                  <li class="tag">${n} ${cellsWord}</li>
                  <li class="tag">${copies}</li>
                </ul>
              </div>
              <p class="piece-tip">${c.t(ADVICE[p.name] || { en: "", cs: "" })}</p>
              <p class="freq">${freq}</p>
            </li>`;
  };

  const groups = GROUPS.map((g) => {
    const items = PIECES.map((p, i) => [p, i]).filter(([, i]) => rarityOf(i) === g.id);
    if (!items.length) return "";
    return `
        <section class="section" aria-labelledby="g-${g.id}">
          <h2 id="g-${g.id}">${c.t(g.title)}</h2>
          <p class="section-intro">${c.t(g.text)}</p>
          <ul class="grid grid-2">
            ${items.map(([p, i]) => card(p, i)).join("\n            ")}
          </ul>
        </section>`;
  }).join("\n");

  const rampRows = [];
  for (let l = 1; l <= FULL_TANGLE_LEVEL; l++) {
    const label = l === FULL_TANGLE_LEVEL ? `${l}+` : String(l);
    rampRows.push(
      `<tr><th scope="row">${label}</th><td class="num">${pct(lang, tangleRatio(l))}</td><td class="num">${pct(
        lang,
        oddShare(l)
      )}</td></tr>`
    );
  }

  const glossary = [
    {
      en: ["Well", "A one-wide column left open, usually at the edge, waiting for a long piece."],
      cs: ["Šachta", "Volný sloupec široký jedno pole, obvykle u kraje, který čeká na dlouhou kostku."],
    },
    {
      en: ["Dip", "A single column one cell lower than both its neighbours."],
      cs: ["Důlek", "Jeden sloupec o pole nižší než oba sousedé."],
    },
    {
      en: ["Step", "Two neighbouring columns whose heights differ by one cell."],
      cs: ["Schod", "Dva sousední sloupce, jejichž výška se liší o jedno pole."],
    },
    {
      en: ["Bump", "A single column one cell higher than both its neighbours."],
      cs: ["Výstupek", "Jeden sloupec o pole vyšší než oba sousedé."],
    },
  ]
    .map((g) => `<div><dt>${g[lang][0]}</dt><dd>${g[lang][1]}</dd></div>`)
    .join("\n            ");

  const tips = [
    {
      en: "<strong>Don’t flatten everything.</strong> A perfectly level stack suits the classics, but the Plus, Heart, Rocket and Tree all need a one-cell dip. Keep one somewhere away from your well.",
      cs: "<strong>Nesrovnávej všechno do roviny.</strong> Úplně rovná hromada sedí klasice, ale Plus, Srdce, Raketa i Strom potřebují důlek. Nech si jeden někde stranou od šachty.",
    },
    {
      en: "<strong>Keep the hold slot for the rare ones.</strong> Holding a Square is fine; holding a Square when the Star is coming up in the preview is not.",
      cs: "<strong>Odkládací políčko si nech pro vzácné tvary.</strong> Odložit Čtverec je v pořádku; odložit Čtverec, když se v náhledu blíží Hvězda, už ne.",
    },
    {
      en: "<strong>Read the three previews.</strong> A rare shape is announced three pieces ahead — time enough to build the dip or step it needs.",
      cs: "<strong>Čti náhled tří dalších kostek.</strong> Vzácný tvar se ohlásí tři kostky dopředu – dost času postavit mu důlek nebo schod.",
    },
    {
      en: "<strong>Dots and Dominoes are your repair kit.</strong> Don’t spend them on open floor; save them for the single gaps the bigger shapes leave behind.",
      cs: "<strong>Tečka a Domino jsou tvoje nářadí.</strong> Neplýtvej jimi na volnou plochu; šetři je na jednotlivé mezery, které po sobě nechají větší tvary.",
    },
    {
      en: `<strong>The Line isn’t the only Tangle piece.</strong> Anything four cells tall — the ${list(tall)} — can clear four rows at once if the stack has the right notches, and scoring a Tangle with an odd shape is an achievement.`,
      cs: `<strong>Tangle neumí jen Čára.</strong> Každá kostka vysoká čtyři pole – ${list(tall)} – smaže čtyři řady naráz, když má hromada správné zářezy. A Tangle divným tvarem odemkne úspěch.`,
    },
    {
      en: "<strong>When a hole is unavoidable, choose where.</strong> Leave it near the surface and away from your well, where it’s quick to dig out — not at the bottom under ten rows.",
      cs: "<strong>Když se díře nevyhneš, vyber jí místo.</strong> Nech ji u povrchu a daleko od šachty, kde se rychle vyhrabe – ne na dně pod deseti řadami.",
    },
  ]
    .map((t) => `<li>${t[lang]}</li>`)
    .join("\n            ");

  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: c.t({ en: "Tangletris pieces", cs: "Tvary v Tangletris" }),
    numberOfItems: PIECES.length,
    itemListElement: PIECES.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: name(p),
      url: c.url("pieces") + "#" + slug(name(p)),
    })),
  };

  return layout(c, {
    title: {
      en: "All 24 Tangletris Pieces: Hearts, Rockets, Stars & Tips",
      cs: "Všech 24 tvarů Tangletris: srdce, raketa, hvězda i hrací kostka",
    },
    description: {
      en: "A Tetris-style game with weird shapes: 7 classic tetrominoes plus 17 odd pieces — heart, star, rocket, dice, pentomino-style blocks — each with a placement tip.",
      cs: "Hra ve stylu Tetrisu s divnými tvary: 7 klasických kostek a 17 podivností – srdce, hvězda, raketa, hrací kostka i pentomina. U každého tvaru rada, kam s ním.",
    },
    h1: { en: "24 pieces, 17 of them weird", cs: "24 tvarů, 17 z nich divných" },
    hero: `<p class="lead">${c.t({
      en: `Tangletris deals you the seven pieces you know — and then a heart, a rocket or a lopsided star. Here are all ${PIECES.length} shapes, how often each one turns up and where it wants to go.`,
      cs: `Tangletris ti rozdá sedm kostek, které znáš – a pak přiletí srdce, raketa nebo křivá hvězda. Tady je všech ${PIECES.length} tvarů, jak často který přichází a kam s ním.`,
    })}</p>
          ${ctaRow([
            { href: c.game, label: c.t(UI.play) },
            { href: c.play("chaos"), label: c.t({ en: "Chaos mode: all shapes at once", cs: "Režim Chaos: všechny tvary hned" }) },
          ])}`,
    body: `
        <section class="section" aria-labelledby="intro">
          <h2 id="intro">${c.t({ en: "Seven classics and a tangle", cs: "Sedm klasik a spleť divných tvarů" })}</h2>
          <div class="panel">
            <p>${c.t({
              en: `It plays like the falling-block game you know until it doesn’t — think of it as a crazy Tetris. The first seven pieces are the classic tetrominoes, four cells each, and they carry the game. The other ${ODD_COUNT} are the tangle: shapes from the one-cell Dot to the eight-cell Rocket, including real pentominoes (the Plus, Cup, Zigzag, Giraffe and Puzzle) and a few no tetromino set would ever allow, like the Dice, whose cells touch only at the corners.`,
              cs: `Hraje se jako padající kostky, které znáš – dokud se to nezamotá. Prvních sedm kostek jsou klasická tetromina po čtyřech polích a nesou celou hru. Zbylých ${ODD_COUNT} tvoří spleť: tvary od jednopolíčkové Tečky po osmipolíčkovou Raketu, včetně skutečných pentomin (Plus, Pohár, Cikcak, Žirafa a Dílek) a několika kousků, které by žádná klasická sada nepřipustila – třeba Hrací kostky, jejíž pole se dotýkají jen rohy.`,
            })}</p>
            <p>${c.t({
              en: "Most odd shapes bury a hole under themselves however carefully you place them, so a board full of them would choke within minutes. That’s why they arrive gradually, and why the hold slot matters far more here than in a classic game.",
              cs: "Většina divných tvarů pod sebou nechá díru, ať je položíš sebepečlivěji, a deska plná jen jich by se ucpala během pár minut. Proto přibývají postupně a proto tu odkládání (Hold) znamená mnohem víc než v klasické hře.",
            })}</p>
            <p>${c.t({
              en: "The game keeps a collection of every piece you’ve discovered — open <strong>Pieces</strong> in the game to see yours — so the rare ones are worth hunting.",
              cs: "Hra si vede sbírku všech objevených kostek – svou najdeš ve hře pod tlačítkem <strong>Tvary</strong> – takže vzácné kousky stojí za lov.",
            })}</p>
            <h3>${c.t({ en: "Words used in the tips", cs: "Slovníček k radám" })}</h3>
            <dl class="glossary">
            ${glossary}
            </dl>
          </div>
        </section>

        <section class="section" aria-labelledby="ramp">
          <h2 id="ramp">${c.t({ en: "The tangle ramp", cs: "Jak spleť houstne" })}</h2>
          <p class="section-intro">${c.t({
            en: `Every bag holds the classic seven in full — ${PIECES[0].weight} Lines and ${PIECES[1].weight} of each other classic. Each odd shape adds its weight in copies, but in Marathon every copy only makes it into the bag with a chance that grows with your level: ${pct(lang, tangleRatio(1))} at level 1, 12 points more each level, and ${pct(lang, 1)} from level ${FULL_TANGLE_LEVEL}. The difficulty curve is baked into the bag itself.`,
            cs: `Každý balíček obsahuje celou klasickou sedmičku – ${PIECES[0].weight} Čar a po ${PIECES[1].weight} kopiích od ostatních klasických tvarů. Každý divný tvar přidá tolik kopií, kolik je jeho váha, jenže v Maratonu se každá kopie do balíčku dostane jen s pravděpodobností, která roste s levelem: ${pct(lang, tangleRatio(1))} na levelu 1, s každým dalším o 12 procentních bodů víc, až se od levelu ${FULL_TANGLE_LEVEL} dostane do balíčku každá. Křivka obtížnosti je tak zapečená přímo v balíčku.`,
          })}</p>
          <div class="table-wrap" tabindex="0" role="region" aria-label="${c.t({ en: "Odd shapes in the Marathon bag", cs: "Divné tvary v balíčku Maratonu" })}">
            <table>
              <caption>${c.t({ en: "Odd shapes in the Marathon bag", cs: "Divné tvary v balíčku Maratonu" })}</caption>
              <thead>
                <tr><th scope="col">${c.t({ en: "Level", cs: "Level" })}</th><th scope="col" class="num">${c.t({
                  en: "Chance per odd copy",
                  cs: "Šance každé divné kopie",
                })}</th><th scope="col" class="num">${c.t({ en: "Odd pieces on average", cs: "Podíl divných kostek" })}</th></tr>
              </thead>
              <tbody>
                ${rampRows.join("\n                ")}
              </tbody>
            </table>
          </div>
          <p class="muted">${c.fill({
            en: `The <a href="{page:daily}">Daily Tangle</a> fixes the day’s chance somewhere between ${pct(lang, 0.5)} and ${pct(lang, 1)} for the whole run, and <a href="{play:chaos}">Chaos mode</a> puts every odd shape in the bag from the very first piece.`,
            cs: `<a href="{page:daily}">Denní Tangle</a> drží šanci dne po celou hru někde mezi ${pct(lang, 0.5)} a ${pct(lang, 1)} a <a href="{play:chaos}">režim Chaos</a> dá do balíčku všechny divné tvary hned od první kostky.`,
          })}</p>
        </section>
${groups}

        <section class="section" aria-labelledby="odd-tips">
          <h2 id="odd-tips">${c.t({ en: "Playing with odd shapes", cs: "Jak hrát s divnými tvary" })}</h2>
          <div class="panel">
            <ul class="ticks">
            ${tips}
            </ul>
            <p class="muted">${c.fill({
              en: `Controls, scoring and more tips are on the <a href="{page:howto}">how to play</a> page.`,
              cs: `Ovládání, bodování a další tipy najdeš na stránce <a href="{page:howto}">Jak hrát</a>.`,
            })}</p>
          </div>
        </section>
`,
    final: finalCta(
      c,
      { en: `Go find all ${PIECES.length}`, cs: `Najdi všech ${PIECES.length}` },
      {
        en: `The ${nameOf("Rocket")} turns up about once in ${oneIn(rocketIdx, 1)} pieces at level 1. Climb the levels to meet it more often — or start in Chaos, where every odd shape is in the bag from the first drop.`,
        cs: `${nameOf("Rocket")} přiletí na levelu 1 zhruba jednou za ${oneIn(rocketIdx, 1)} kostek. Stoupej levely, ať ji potkáváš častěji – nebo začni v Chaosu, kde jsou všechny divné tvary v balíčku od první kostky.`,
      },
      [
        { href: c.game, label: c.t(UI.play) },
        { href: c.play("chaos"), label: c.t({ en: "Play Chaos", cs: "Hrát Chaos" }) },
      ]
    ),
    ld: [ld],
  });
}

/* =============================================================== WORLDS */

const WORLD_COPY = {
  neon: {
    desc: {
      en: "An endless synthwave highway: a striped sun sinks behind wireframe mountains while the grid floor rushes at you and neon pylons flash past. The floor and the sun pulse on every kick drum, the pylons flare on the snare, and the road speeds up as the music gets more intense.",
      cs: "Nekonečná synthwavová dálnice: pruhované slunce zapadá za drátěné hory, mřížka silnice se řítí proti tobě a kolem sviští neonové sloupy. Silnice i slunce pulzují s každým kopákem, sloupy se rozzáří na virbl a čím je hudba divočejší, tím rychleji jedeš.",
    },
    style: {
      en: "Synthwave: detuned supersaw pads, a pulsing arpeggio, an analog bass and a gated snare.",
      cs: "Synthwave: rozladěné supersaw plochy, pulzující arpeggio, analogový bas a gatovaný virbl.",
    },
    alt: {
      en: "Neon Drive world: a striped synthwave sun behind cyan wireframe mountains, a pink neon grid road and glowing pylons",
      cs: "Svět Neon Drive: pruhované synthwavové slunce za tyrkysovými drátěnými horami, růžová neonová mřížka silnice a zářící sloupy",
    },
  },
  ocean: {
    desc: {
      en: "A calm underwater world: light shafts slant down from a rippling surface, kelp sways over sunlit dunes, glowing jellyfish drift up through bubble streams and whales glide just under the surface. The jellyfish pulse with the beat and glow on the chords — and when your stack gets high, the water darkens and every jelly flushes an alarmed magenta.",
      cs: "Klidný podmořský svět: světelné paprsky se lámou zčeřenou hladinou, chaluhy se vlní nad prosvícenými dunami, svítící medúzy stoupají mezi proudy bublin a těsně pod hladinou plují velryby. Medúzy pulzují do rytmu a září s akordy – a když se hromada blíží ke stropu, voda potemní a všechny medúzy poplašeně zrůžoví.",
    },
    style: {
      en: "Underwater downtempo with a lazy swing: electric piano, a deep sub bass, bubbly plucks and a whale-song lead over brushes and shakers.",
      cs: "Podvodní downtempo s líným swingem: elektrické piano, hluboký sub bas, bublavé drnkání a velrybí melodie nad metličkami a šejkrem.",
    },
    alt: {
      en: "Deep Blue world: sunbeams through blue water, kelp swaying over sand dunes, glowing pink jellyfish and a whale silhouette",
      cs: "Svět Deep Blue: sluneční paprsky v modré vodě, chaluhy nad písečnými dunami, svítící růžové medúzy a silueta velryby",
    },
  },
  sakura: {
    desc: {
      en: "A torii gate stands in a twilight lake under a low moon; ink-wash mountains fade into mist, cherry trees shed petals and paper lanterns drift upwards. Petals sparkle on the snare, lanterns breathe with the kick, and when things get tense the wind picks up and the lake starts to ripple.",
      cs: "V jezeře za soumraku stojí brána torii pod nízkým měsícem, tušové hory se ztrácejí v mlze, sakury shazují okvětní lístky a k nebi stoupají papírové lampiony. Lístky se třpytí na virbl, lampiony dýchají s kopákem, a když jde do tuhého, zvedne se vítr a hladina se začne čeřit.",
    },
    style: {
      en: "Koto and shakuhachi over taiko drums in the Japanese in scale, with temple bells and a gong for a crash cymbal.",
      cs: "Koto a šakuhači nad bubny taiko v japonské stupnici in, s chrámovými zvonky a gongem místo činelu.",
    },
    alt: {
      en: "Sakura world: a red torii gate in a violet twilight lake, cherry blossom branches, a full moon and floating lanterns",
      cs: "Svět Sakura: červená brána torii ve fialovém jezeře za soumraku, rozkvetlé větve sakur, úplněk a plující lampiony",
    },
  },
  frost: {
    desc: {
      en: "An arctic night: aurora curtains fold across the sky above low-poly snowy peaks, and a frozen lake mirrors it all between shores of snow-dusted pines. The aurora flares on chord changes, snow glitters on the hi-hats and shooting stars answer the music’s accents — in danger the lights run hot and the snow whips sideways.",
      cs: "Arktická noc: přes oblohu se vlní závěsy polární záře nad zasněženými štíty a zamrzlé jezero to celé zrcadlí mezi břehy s poprášenými smrky. Záře vzplane při změně akordu, sníh se třpytí s činely a na hudební akcenty odpoví padající hvězda – v nebezpečí se světla rozžhaví a sníh začne hnát vítr.",
    },
    style: {
      en: "Celesta and choir: a formant choir, glassy pads, celesta and harp arpeggios and slow bells over a soft beat.",
      cs: "Celesta a sbor: formantový sbor, skleněné plochy, arpeggia celesty a harfy a pomalé zvony nad jemným rytmem.",
    },
    alt: {
      en: "Frost world: green and violet northern lights over snowy mountains, a frozen lake and dark pine trees under a bright moon",
      cs: "Svět Frost: zelená a fialová polární záře nad zasněženými horami, zamrzlé jezero a tmavé smrky pod jasným měsícem",
    },
  },
  cosmos: {
    desc: {
      en: "Deep space: a ringed gas giant hangs over a violet nebula, its moons wheel past, a slow river of asteroids drifts by and shooting stars streak across the sky. The planet pulses on the kick, light sweeps around the rings with every bar, and when your stack climbs, the asteroid river speeds up and the stars grow restless.",
      cs: "Hluboký vesmír: nad fialovou mlhovinou visí plynný obr s prstenci, kolem krouží jeho měsíce, pomalu proplouvá řeka asteroidů a oblohu křižují padající hvězdy. Planeta pulzuje s kopákem, po prstencích s každým taktem přeběhne světlo, a když hromada roste, řeka asteroidů zrychlí a hvězdy znervózní.",
    },
    style: {
      en: "A Berlin-school space sequencer: a looping synth sequence, wide pads, an analog bass, a choir and a soaring lead.",
      cs: "Kosmický sekvencer v duchu berlínské školy: smyčka syntezátorové sekvence, široké plochy, analogový bas, sbor a vznášející se melodie.",
    },
    alt: {
      en: "Starfall world: a ringed gas giant and a small moon in front of a purple nebula, with a river of asteroids drifting by",
      cs: "Svět Starfall: plynný obr s prstenci a malý měsíc před fialovou mlhovinou, kolem plyne řeka asteroidů",
    },
  },
  inferno: {
    desc: {
      en: "The volcanic forge at the end of the climb: a volcano erupts in time with the music, crust plates drift on a lava lake, a lava fall pours off a basalt cliff and embers rise through churning ash. Big accents set off eruptions, the lava fall surges on the snare, and the higher your stack, the hotter everything glows.",
      cs: "Sopečná výheň na konci výstupu: sopka chrlí v rytmu hudby, po lávovém jezeře plují kry ztuhlé kůry, z čedičového útesu se valí lávopád a valícím se popelem stoupají jiskry. Velké akcenty spustí erupci, lávopád se vzedme s virblem a čím výš je tvoje hromada, tím víc všechno žhne.",
    },
    style: {
      en: "Phrygian industrial metal: a distorted Reese bass, synth stabs, a dark choir, anvil hits and pounding toms.",
      cs: "Frygický industriální metal: zkreslený reese bas, syntezátorové údery, temný sbor, rány do kovadliny a dunivé tomy.",
    },
    alt: {
      en: "Inferno world: an erupting volcano over a cracked lava lake, with a glowing lava fall pouring off basalt cliffs",
      cs: "Svět Inferno: chrlící sopka nad popraskaným lávovým jezerem a žhnoucí lávopád padající z čedičových útesů",
    },
  },
};

const MODE_NAMES = {
  aeolian: { en: "minor", cs: "moll" },
  dorian: { en: "Dorian", cs: "dórský modus" },
  in: { en: "in scale", cs: "japonská stupnice in" },
  lydian: { en: "Lydian", cs: "lydický modus" },
  phrygianDominant: { en: "Phrygian dominant", cs: "frygický dominantní modus" },
};

function worldsPage(lang) {
  const c = context(lang, "worlds");
  const n = WORLDS.length;
  const names = WORLDS.map((w) => w.name);

  const cards = WORLDS.map((w, idx) => {
    const copy = WORLD_COPY[w.id] || {};
    const levels = [w.level, w.level + n, w.level + 2 * n].join(", ") + "…";
    const img = `img/worlds/${w.id}.jpg`;
    const hasImg = existsSync(join(ROOT, img));
    const media = hasImg
      ? `<figure class="world-media"><img src="${c.root}${img}" width="960" height="540" alt="${esc(
          c.t(copy.alt || { en: w.name, cs: w.name })
        )}"${idx === 0 ? "" : ' loading="lazy"'} decoding="async"></figure>`
      : `<div class="world-media" aria-hidden="true"></div>`;
    const mode = MODE_NAMES[w.track.mode] ? c.t(MODE_NAMES[w.track.mode]) : w.track.mode;
    const key = String(w.track.key || "").replace("#", "♯");
    return `<li class="world" id="${w.id}" style="--w-accent: ${w.accent}; --w-accent-2: ${w.accent2}">
            ${media}
            <div class="world-body">
              <h2>${esc(w.name)}</h2>
              <p class="level-badge">${c.t({ en: "Levels", cs: "Level" })} ${levels}</p>
              <p>${c.t(copy.desc || { en: "", cs: "" })}</p>
              <p class="track"><span aria-hidden="true">♪ </span><span class="sr-only">${c.t({
                en: "Soundtrack: ",
                cs: "Soundtrack: ",
              })}</span><b>${esc(w.track.title)}</b><br>${c.t(copy.style || { en: "", cs: "" })} <span class="muted">${c.t({
                en: `Starts at ${w.track.bpm} BPM · ${key} ${mode}.`,
                cs: `Začíná na ${w.track.bpm} BPM · ${w.track.mode === "aeolian" ? key + " moll" : key + ", " + mode}.`,
              })}</span></p>
              <p class="sr-only">${c.t({ en: "Palette:", cs: "Paleta:" })}</p>
              <ul class="swatches">
                <li><i style="--c: ${w.accent}"></i>${c.t({ en: "Accent", cs: "Akcent" })} <code>${w.accent}</code></li>
                <li><i style="--c: ${w.accent2}"></i>${c.t({ en: "Second accent", cs: "Druhý akcent" })} <code>${w.accent2}</code></li>
                <li><i style="--c: ${w.board}"></i>${c.t({ en: "Board", cs: "Deska" })} <code>${w.board}</code></li>
              </ul>
            </div>
          </li>`;
  }).join("\n          ");

  return layout(c, {
    title: {
      en: "Six 3D Worlds With Live Generative Music | Tangletris",
      cs: "Šest 3D světů a hudba, která se skládá živě | Tangletris",
    },
    description: {
      en: "A 3D falling-block puzzle game with music: Tangletris travels from a synthwave highway to the deep sea, a sakura lake, the aurora, deep space and a volcano.",
      cs: "3D hra s padajícími kostkami a hudbou: Tangletris tě provede od synthwavové dálnice přes mořské hlubiny, sakurové jezero a polární záři až do vesmíru a k sopce.",
    },
    h1: { en: "Six worlds, six soundtracks", cs: "Šest světů, šest soundtracků" },
    hero: `<p class="lead">${c.t({
      en: "Tangletris is a 3D falling-block puzzle game with music at its heart. The board floats in front of a living world, and every world has its own soundtrack, composed live in your browser. Clear ten lines and you travel on — from a synthwave highway to the bottom of the sea, a cherry-blossom lake, the northern lights, deep space and finally a volcano.",
      cs: "Tangletris je 3D logická hra s padajícími kostkami, ve které hraje hudba hlavní roli. Deska se vznáší před živým světem a každý svět má vlastní soundtrack, který se skládá přímo v prohlížeči. Smaž deset řad a cestuješ dál – ze synthwavové dálnice na mořské dno, k jezeru pod sakurami, pod polární záři, do hlubokého vesmíru a nakonec do sopky.",
    })}</p>
          ${ctaRow([
            { href: c.game, label: c.t(UI.play) },
            { href: c.play("zen"), label: c.t({ en: "Zen mode: just the worlds", cs: "Režim Zen: jen světy a hudba" }) },
          ])}`,
    body: `
        <section class="section" aria-labelledby="journey">
          <h2 id="journey">${c.t({ en: "The Journey", cs: "Cesta" })}</h2>
          <div class="panel">
            <p>${c.t({
              en: `In Marathon, every level takes you to the next world: ${names[0]} at level 1, then ${joinList(lang, names.slice(1, -1))}, until ${names[n - 1]} at level ${n} — and from level ${n + 1} the journey starts again from the top, only faster. Each level-up plays a transition into the next world and its soundtrack.`,
              cs: `V Maratonu tě každý level posune do dalšího světa: na levelu 1 ${names[0]}, pak ${joinList(lang, names.slice(1, -1))}, až na levelu ${n} ${names[n - 1]} – a od levelu ${n + 1} začíná cesta znovu od začátku, jen rychleji. Každý postup o level doprovodí přechod do nového světa i jeho hudby.`,
            })}</p>
            <ul class="ticks">
              <li>${c.t({
                en: "<strong>Stay in one world.</strong> Press <kbd>T</kbd> or the world button in the top bar to step from Journey through each of the six worlds and back. A pinned world stays put however far you climb.",
                cs: "<strong>Zůstaň v jednom světě.</strong> Klávesou <kbd>T</kbd> nebo tlačítkem světa v horní liště přepínáš z Cesty postupně na každý ze šesti světů a zase zpátky. Vybraný svět zůstane, ať vystoupáš jakkoli vysoko.",
              })}</li>
              <li>${c.fill({
                en: `<strong>Just watch and listen.</strong> <a href="{play:zen}">Zen mode</a> has no game over and no speed-up — a full stack is simply swept away — so you can stay in your favourite world as long as you like.`,
                cs: `<strong>Jen se dívej a poslouchej.</strong> V <a href="{play:zen}">režimu Zen</a> není konec hry ani zrychlování – plná deska se prostě smete – takže můžeš ve svém oblíbeném světě zůstat, jak dlouho chceš.`,
              })}</li>
              <li>${c.t({
                en: "<strong>The worlds react to you, too.</strong> When your stack nears the top, every world gets restless — the water darkens, the wind picks up, the aurora runs hot — and a nervous percussion layer joins the soundtrack.",
                cs: "<strong>Světy reagují i na tebe.</strong> Když se hromada blíží ke stropu, každý svět znervózní – voda potemní, zvedne se vítr, polární záře se rozžhaví – a do hudby se přidají nervózní bicí.",
              })}</li>
            </ul>
          </div>
        </section>

        <ol class="worlds">
          ${cards}
        </ol>

        <section class="section" aria-labelledby="music">
          <h2 id="music">${c.t({ en: "Music that’s written while you play", cs: "Hudba, která vzniká, zatímco hraješ" })}</h2>
          <div class="panel">
            <p>${c.t({
              en: "There isn’t a single audio file in Tangletris. Every instrument — plucked strings, electric piano, bells, supersaw pads, a formant choir, a breathy flute, analog basses and a full drum kit — is synthesized in your browser with the Web Audio API.",
              cs: "V Tangletris není jediný zvukový soubor. Každý nástroj – drnkací struny, elektrické piano, zvony, supersaw plochy, formantový sbor, dechová flétna, analogové basy i celá bicí souprava – se syntetizuje přímo v prohlížeči přes Web Audio API.",
            })}</p>
            <p>${c.t({
              en: "Melodies, arpeggios and drum fills are regenerated every time a song loops, and the arrangement moves through intro, verse, chorus and breakdown, so a soundtrack never plays the same way twice. The tempo rises with your level, and the sound effects are played in key, on whatever chord the music is on — combos climb higher with every link.",
              cs: "Melodie, arpeggia i přechody na bicí se při každém opakování skladby vytvoří znovu a aranžmá prochází intrem, slokou, refrénem i breakdownem, takže soundtrack nikdy nezní dvakrát stejně. Tempo roste s levelem a zvukové efekty hrají v tónině, na akord, který právě zní – a kombo s každým dalším článkem stoupá výš.",
            })}</p>
            <p>${c.t({
              en: "The worlds listen back: grids, jellyfish, lanterns, auroras and lava pulse on the kick drum and flare on chord changes.",
              cs: "Světy poslouchají taky: mřížky, medúzy, lampiony, polární záře i láva pulzují s kopákem a rozzáří se při změně akordu.",
            })}</p>
          </div>
        </section>

        <section class="section" aria-labelledby="devices">
          <h2 id="devices">${c.t({ en: "Runs on phones, too", cs: "Poběží i na mobilu" })}</h2>
          <div class="panel">
            <p>${c.t({
              en: "The worlds are drawn in real time with WebGL 2 — shaders, instancing and particles, without a single texture or model file. On slower devices the game quietly gives up antialiasing, then resolution, then bloom, keeping only the steps that actually help, and climbs back once frames are fast again.",
              cs: "Světy se kreslí v reálném čase přes WebGL 2 – shadery, instancing a částice, bez jediné textury nebo modelu. Na pomalejších zařízeních hra potichu obětuje vyhlazování, pak rozlišení a nakonec bloom, ponechá jen kroky, které opravdu pomáhají, a jakmile se snímky zase zrychlí, vrátí je zpátky.",
            })}</p>
            <p>${c.fill({
              en: `Press <kbd>V</kbd> to switch off the board’s tilt and wobble; a reduced-motion setting on your device is respected automatically. More in the <a href="{page:howto}">how to play</a> guide.`,
              cs: `Klávesa <kbd>V</kbd> vypne náklon a houpání desky; nastavení omezeného pohybu ve tvém zařízení hra respektuje sama. Víc v návodu <a href="{page:howto}">Jak hrát</a>.`,
            })}</p>
          </div>
        </section>
`,
    final: finalCta(
      c,
      { en: "Start the journey", cs: "Vydej se na cestu" },
      {
        en: "Six worlds, ten lines apart. Or put on Zen mode and just enjoy the view.",
        cs: "Šest světů, každý deset řad od sebe. Nebo si pusť Zen a jen se kochej.",
      },
      [
        { href: c.game, label: c.t(UI.play) },
        { href: c.play("zen"), label: c.t({ en: "Play Zen", cs: "Hrát Zen" }) },
      ]
    ),
  });
}

/* =============================================================== HOW TO */

const MODES = [
  {
    id: "marathon",
    name: { en: "Marathon", cs: "Maraton" },
    text: {
      en: "The original endless climb. A new level every 10 lines, a new world with each level, faster falls — and the odd shapes get more common every level until all of them are in play.",
      cs: "Původní nekonečný výstup. Každých 10 řad nový level, s každým levelem nový svět a rychlejší pád – a divných tvarů přibývá, až jsou ve hře všechny.",
    },
    cta: { en: "Play Marathon", cs: "Hrát Maraton" },
  },
  {
    id: "daily",
    name: { en: "Daily Tangle", cs: "Denní Tangle" },
    text: {
      en: `3 minutes, and the same pieces for everyone today. The day’s tangle level is fixed for the whole run, a streak counts the days you play in a row, and you can share your result. <a href="{page:daily}">More about the Daily Tangle</a>.`,
      cs: `3 minuty a pro všechny dnes stejné kostky. Zamotanost dne platí po celou hru, série počítá dny, kdy hraješ v kuse, a výsledek můžeš sdílet. <a href="{page:daily}">Víc o Denním Tanglu</a>.`,
    },
    cta: { en: "Play today’s Daily Tangle", cs: "Zahrát dnešní Denní Tangle" },
  },
  {
    id: "sprint",
    name: { en: "Sprint", cs: "Sprint" },
    text: {
      en: "Clear 40 lines as fast as you can. Your time is your score, so hard drop everything you’re sure about.",
      cs: "Smaž 40 řad co nejrychleji. Skóre je tvůj čas, takže všechno, co máš jisté, rovnou shazuj.",
    },
    cta: { en: "Play Sprint", cs: "Hrát Sprint" },
  },
  {
    id: "chaos",
    name: { en: "Chaos", cs: "Chaos" },
    text: {
      en: `Every odd shape is in the bag from the very first piece — the full tangle from the start, with the usual speed-up. Great practice for the hold slot. <a href="{page:pieces}">Meet the pieces</a>.`,
      cs: `Všechny divné tvary jsou v balíčku hned od první kostky – plná spleť od začátku a k tomu obvyklé zrychlování. Skvělý trénink na odkládání. <a href="{page:pieces}">Poznej tvary</a>.`,
    },
    cta: { en: "Play Chaos", cs: "Hrát Chaos" },
  },
  {
    id: "zen",
    name: { en: "Zen", cs: "Zen" },
    text: {
      en: `No game over and no speed-up: when the stack fills up, it’s simply swept away. For the <a href="{page:worlds}">worlds</a> and the music.`,
      cs: `Žádný konec hry a žádné zrychlování: když se deska zaplní, prostě se smete. Pro <a href="{page:worlds}">světy</a> a hudbu.`,
    },
    cta: { en: "Play Zen", cs: "Hrát Zen" },
  },
];

const KEYS = [
  [["←", "→"], { en: "Move left / right — hold to keep sliding", cs: "Posun doleva / doprava – podržením kostka klouže dál" }],
  [["↓"], { en: "Soft drop (+1 point per row)", cs: "Zrychlený pád (+1 bod za řádek)" }],
  [["↑", "X"], { en: "Rotate clockwise", cs: "Otočit doprava" }],
  [
    { en: ["Z"], cs: ["Y"] },
    {
      en: "Rotate anticlockwise — it’s the key beside X, so Y on a German or Czech keyboard",
      cs: "Otočit doleva – je to klávesa vedle X, takže na anglické klávesnici Z",
    },
  ],
  [{ en: ["Space"], cs: ["Mezerník"] }, { en: "Hard drop (+2 points per row)", cs: "Shodit dolů (+2 body za řádek)" }],
  [["C", "Shift"], { en: "Hold the piece for later (once per piece)", cs: "Odložit kostku na později (jednou za kostku)" }],
  [["P", "Esc"], { en: "Pause", cs: "Pauza" }],
  [["R"], { en: "Restart", cs: "Začít znovu" }],
  [["T"], { en: "Change world: Journey, or one pinned world", cs: "Změnit svět: Cesta, nebo jeden vybraný svět" }],
  [["V"], { en: "Board tilt and motion on / off", cs: "Náklon a pohyb desky zap. / vyp." }],
  [["M"], { en: "Sound effects on / off", cs: "Zvukové efekty zap. / vyp." }],
  [["N"], { en: "Music on / off", cs: "Hudba zap. / vyp." }],
];

const FAQ = [
  {
    q: { en: "Is Tangletris free?", cs: "Je Tangletris zdarma?" },
    a: {
      en: "Yes. Tangletris is free to play in your browser, with no sign-up and nothing to download. It’s also open source under the MIT licence.",
      cs: "Ano. Tangletris hraješ zdarma přímo v prohlížeči, bez registrace a bez stahování. Navíc je open source pod licencí MIT.",
    },
  },
  {
    q: { en: "Can I play Tangletris on my phone?", cs: "Dá se Tangletris hrát na mobilu?" },
    a: {
      en: "Yes, in any current mobile browser with WebGL 2. Swipe to move, swipe down to drop and tap to rotate — or use the buttons under the board.",
      cs: "Ano, v každém aktuálním mobilním prohlížeči s WebGL 2. Přejetím prstu kostku posuneš, přejetím dolů shodíš a klepnutím otočíš – nebo použij tlačítka pod deskou.",
    },
  },
  {
    q: { en: "Can I install it and play offline?", cs: "Jde hru nainstalovat a hrát offline?" },
    a: {
      en: "Yes. Open the game, then choose Install in Chrome or Edge, or Share → Add to Home Screen in Safari. Installed, Tangletris opens like an app and keeps working without a connection.",
      cs: "Ano. Otevři hru a v Chromu nebo Edgi zvol Instalovat, v Safari Sdílet → Přidat na plochu. Nainstalovaný Tangletris se otevírá jako aplikace a funguje i bez připojení.",
    },
  },
  {
    q: { en: "Is this Tetris?", cs: "Je to Tetris?" },
    a: {
      en: "No. Tangletris is an independent Tetris-style falling-block game, not affiliated with The Tetris Company. The core idea — clearing full rows — is the same, but 17 of its 24 pieces are odd shapes the classic game doesn’t have, and it adds a tilting 3D board, six worlds and generative music.",
      cs: "Ne. Tangletris je nezávislá hra ve stylu Tetrisu a se společností The Tetris Company nijak nesouvisí. Princip – mazání plných řad – je stejný, ale 17 z 24 kostek jsou divné tvary, které klasická hra nemá, a navíc tu je nakláněná 3D deska, šest světů a generovaná hudba.",
    },
  },
  {
    q: { en: "What is the Daily Tangle?", cs: "Co je Denní Tangle?" },
    a: {
      en: `A three-minute game with the same pieces for everyone, refreshed at local midnight. Each day has its own tangle level, a streak counts the days you play in a row, and you can share your result. See the <a href="{page:daily}">Daily Tangle page</a>.`,
      cs: `Tříminutová hra se stejnými kostkami pro všechny, která se obnovuje o půlnoci místního času. Každý den má vlastní zamotanost, série počítá dny, kdy hraješ v kuse, a výsledek můžeš sdílet. Víc na stránce <a href="{page:daily}">Denní Tangle</a>.`,
    },
  },
  {
    q: { en: "How does challenging a friend work?", cs: "Jak vyzvat kamaráda?" },
    a: {
      en: "After a game, press Share. In Marathon, Sprint and Chaos the link carries the game’s seed, so your friend gets the same pieces and sees your score — or Sprint time — to beat.",
      cs: "Po hře stiskni Sdílet. V Maratonu, Sprintu a Chaosu nese odkaz seed hry, takže kamarád dostane stejné kostky a uvidí tvoje skóre – nebo čas ve Sprintu –, které má překonat.",
    },
  },
  {
    q: { en: "Where is my score saved?", cs: "Kde se ukládá moje skóre?" },
    a: {
      en: "In your browser’s local storage, on this device only. There are no accounts and no servers: your bests, Daily streak, piece collection and achievements stay with you — and clearing the site’s data resets them.",
      cs: "V místním úložišti prohlížeče, jen na tomhle zařízení. Žádné účty ani servery: rekordy, série v Denním Tanglu, sbírka tvarů i úspěchy zůstávají u tebe – a smazáním dat webu zmizí.",
    },
  },
  {
    q: { en: "Why does it need WebGL 2, and what if it lags?", cs: "Proč hra potřebuje WebGL 2 a co když se seká?" },
    a: {
      en: "The board and the worlds are real-time 3D. Tangletris adapts its quality automatically — antialiasing, then resolution, then bloom — to keep frames smooth. If it still feels heavy, press V to turn off the board’s tilt and motion.",
      cs: "Deska i světy jsou 3D v reálném čase. Tangletris si kvalitu přizpůsobuje sám – vyhlazování, pak rozlišení, nakonec bloom –, aby hra běžela plynule. Pokud je to pořád těžké, klávesou V vypneš náklon a pohyb desky.",
    },
  },
  {
    q: { en: "How is the music made?", cs: "Jak vzniká hudba?" },
    a: {
      en: "It’s generated live in your browser with the Web Audio API — there are no recordings at all. Each world has its own track; melodies and fills are regenerated every loop, the tempo rises with your level and the sound effects play in key.",
      cs: "Generuje se živě v prohlížeči přes Web Audio API, bez jediné nahrávky. Každý svět má vlastní skladbu; melodie a přechody se při každém opakování vytvoří znovu, tempo roste s levelem a zvukové efekty hrají v tónině.",
    },
  },
  {
    q: { en: "How many pieces are there?", cs: "Kolik je ve hře tvarů?" },
    a: {
      en: `24: the seven classic tetrominoes plus 17 odd shapes, from the one-cell Dot to the eight-cell Rocket. See them all, with tips, on the <a href="{page:pieces}">pieces page</a>.`,
      cs: `24: sedm klasických tetromin a 17 divných tvarů, od jednopolíčkové Tečky po osmipolíčkovou Raketu. Všechny i s radami najdeš na stránce <a href="{page:pieces}">Tvary</a>.`,
    },
  },
];

function howtoPage(lang) {
  const c = context(lang, "howto");

  const keyRows = KEYS.map(([keys, action]) => {
    const k = Array.isArray(keys) ? keys : keys[lang];
    return `<tr><td class="keys">${kbd(k)}</td><td>${c.t(action)}</td></tr>`;
  }).join("\n                ");

  const scoring = [
    [{ en: "Single — 1 line", cs: "Jedna řada" }, { en: "100 × level", cs: "100 × level" }],
    [{ en: "Double — 2 lines", cs: "Dvě řady" }, { en: "300 × level", cs: "300 × level" }],
    [{ en: "Triple — 3 lines", cs: "Tři řady" }, { en: "500 × level", cs: "500 × level" }],
    [{ en: "<strong>TANGLE!</strong> — 4 lines", cs: "<strong>TANGLE!</strong> – 4 řady" }, { en: "800 × level", cs: "800 × level" }],
    [
      { en: "Back-to-back Tangle", cs: "Tangle back-to-back" },
      { en: "× 1.5 — 1,200 × level", cs: `× 1,5 – 1${NBSP}200 × level` },
    ],
    [{ en: "Combo", cs: "Kombo" }, { en: "+ 50 × combo × level", cs: "+ 50 × kombo × level" }],
    [
      { en: "Perfect clear — empty board", cs: "Čistá deska – vyprázdníš celou desku" },
      { en: "+ 2,000 × level", cs: `+ 2${NBSP}000 × level` },
    ],
    [{ en: "Soft drop", cs: "Zrychlený pád" }, { en: "+ 1 per row", cs: "+ 1 za řádek" }],
    [{ en: "Hard drop", cs: "Shození" }, { en: "+ 2 per row", cs: "+ 2 za řádek" }],
  ]
    .map(([a, p]) => `<tr><th scope="row">${c.t(a)}</th><td class="num">${c.t(p)}</td></tr>`)
    .join("\n                ");

  const speedLevels = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, FLOOR_LEVEL];
  const speedRows = speedLevels
    .map((l) => {
      const label = l === FLOOR_LEVEL ? `${l}+` : String(l);
      return `<tr><th scope="row">${label}</th><td>${esc(worldAtLevel(l).name)}</td><td class="num">${fallMs(
        l
      )}${NBSP}ms</td><td class="num">${pct(lang, tangleRatio(l))}</td></tr>`;
    })
    .join("\n                ");

  const modeCards = MODES.map(
    (m) => `<li class="card mode">
              <h3>${c.t(m.name)}</h3>
              <p>${c.fill(m.text)}</p>
              <p><a class="more" href="${c.play(m.id)}">${c.t(m.cta)} →</a></p>
            </li>`
  ).join("\n            ");

  const tips = [
    {
      en: "Keep the stack flat and leave one clean well on the side for the Line.",
      cs: "Drž hromadu rovnou a u kraje si nech jednu čistou šachtu pro Čáru.",
    },
    {
      en: "Bank an awkward shape in the hold slot instead of forcing it into a bad spot.",
      cs: "Nešikovný tvar radši odlož, než ho cpát na špatné místo.",
    },
    {
      en: "Clearing lines on consecutive drops builds a combo — every extra clear in the chain is worth more, and the chime climbs higher.",
      cs: "Mazání řad kostkami hned po sobě staví kombo – každé další mazání v řetězu má větší cenu a zvonkohra stoupá výš.",
    },
    {
      en: "Four lines at once is a <strong>Tangle</strong>, and chaining two in a row multiplies the reward by 1.5.",
      cs: "Čtyři řady naráz jsou <strong>Tangle</strong> a dva Tangly po sobě násobí odměnu 1,5×.",
    },
    {
      en: "Watch the ghost piece before you commit; hard drop only when the landing spot is right — it’s worth twice the points of a soft drop.",
      cs: "Než se rozhodneš, sleduj stín kostky; shazuj, až když místo dopadu sedí – shození vynese dvakrát víc bodů než zrychlený pád.",
    },
    {
      en: "Sweeping the board completely empty pays a huge perfect-clear bonus: 2,000 × level.",
      cs: `Úplně vyprázdněná deska vynese obří bonus: 2${NBSP}000 × level.`,
    },
    {
      en: "When the music grows a nervous ticking and the frame glows red, the stack is near the top — dig out before anything else.",
      cs: "Když se v hudbě ozve nervózní tikání a rám zčervená, hromada je u stropu – nejdřív se vyhrab.",
    },
    {
      en: "Leave a one-cell dip somewhere: the Plus, Heart, Rocket and Tree all need one, and they’re much nastier on a perfectly flat stack.",
      cs: "Nech si někde důlek o jedno pole: potřebuje ho Plus, Srdce, Raketa i Strom a na úplně rovné hromadě jsou mnohem zlejší.",
    },
    {
      en: "Read the three previews. A rare shape is announced three pieces ahead — time enough to build the spot it needs or empty your hold slot for it.",
      cs: "Čti náhled tří dalších kostek. Vzácný tvar se ohlásí tři kostky dopředu – dost času připravit mu místo nebo uvolnit odkládací políčko.",
    },
    {
      en: "Save the Dot and Domino for repairs: they plug the single gaps that nothing else fits.",
      cs: "Tečku a Domino si šetři na opravy: ucpou jednotlivé mezery, kam se nic jiného nevejde.",
    },
    {
      en: "Use the lock delay: after a piece lands you have half a second, renewed with every move (up to 15 times), to slide it under an overhang.",
      cs: "Využij prodlevu před zamknutím: po dopadu máš půl sekundy, která se s každým pohybem obnoví (až 15×), na zasunutí kostky pod převis.",
    },
  ]
    .map((t) => `<li>${t[lang]}</li>`)
    .join("\n            ");

  const faqHtml = FAQ.map(
    (f) => `<div class="card">
              <h3>${c.t(f.q)}</h3>
              <p>${c.fill(f.a)}</p>
            </div>`
  ).join("\n            ");

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({
      "@type": "Question",
      name: c.t(f.q),
      acceptedAnswer: { "@type": "Answer", text: plain(c.fill(f.a)) },
    })),
  };

  return layout(c, {
    title: {
      en: "How to Play Tangletris: Controls, Scoring, Modes & FAQ",
      cs: "Jak hrát Tangletris: ovládání, body, režimy a FAQ",
    },
    description: {
      en: "Controls for keyboard and phone, the five game modes, the full scoring table, level speeds, tips for a higher score and quick answers to common questions.",
      cs: "Hra ve stylu Tetrisu online zdarma: ovládání na klávesnici i mobilu, pět herních režimů, bodování, rychlost levelů, tipy a odpovědi na časté otázky.",
    },
    h1: { en: "How to play Tangletris", cs: "Jak hrát Tangletris" },
    hero: `<p class="lead">${c.t({
      en: "Tangletris plays like the falling-block puzzle you already know — move, rotate, clear full rows — with 17 extra shapes, a tilting 3D board and five ways to play. Here’s everything: controls, modes, scoring, speed, tips and quick answers.",
      cs: "Tangletris je logická hra ve stylu Tetrisu, kterou hraješ online zdarma přímo v prohlížeči: posouváš, otáčíš a mažeš plné řady – jen se 17 tvary navíc, nakláněnou 3D deskou a pěti režimy. Tady je všechno: ovládání, režimy, body, rychlost, tipy a rychlé odpovědi.",
    })}</p>
          ${ctaRow([
            { href: c.game, label: c.t(UI.play) },
            { href: c.play("daily"), label: c.t({ en: "Today’s Daily Tangle", cs: "Dnešní Denní Tangle" }) },
          ])}`,
    body: `
        <section class="section" aria-labelledby="goal">
          <h2 id="goal">${c.t({ en: "The goal", cs: "Cíl hry" })}</h2>
          <div class="panel">
            <p>${c.t({
              en: "Pieces fall into a board 10 cells wide and 20 tall. Move and rotate them so they fill complete horizontal rows: a full row disappears and everything above drops down. Clear four rows at once and you’ve scored a <strong>Tangle</strong>. The game ends when the stack reaches the top: a new piece has no room to appear, or a piece locks with part of it sticking out above the board.",
              cs: "Kostky padají do desky široké 10 a vysoké 20 polí. Posouvej je a otáčej tak, aby vyplnily celé vodorovné řady: plná řada zmizí a všechno nad ní spadne dolů. Smažeš-li čtyři řady naráz, máš <strong>Tangle</strong>. Hra končí, když stavba dosáhne stropu: nová kostka se nemá kam vejít, nebo kostka zapadne tak, že jí část trčí nad desku.",
            })}</p>
            <p>${c.fill({
              en: `Most pieces are the seven classic tetrominoes, but the bag also deals hearts, rockets, stars and other <a href="{page:pieces}">odd shapes</a> — more of them with every level.`,
              cs: `Většinu tvoří sedm klasických tetromin, ale balíček rozdává i srdce, rakety, hvězdy a další <a href="{page:pieces}">divné tvary</a> – s každým levelem víc.`,
            })}</p>
          </div>
        </section>

        <section class="section" aria-labelledby="controls">
          <h2 id="controls">${c.t({ en: "Controls", cs: "Ovládání" })}</h2>
          <div class="table-wrap" tabindex="0" role="region" aria-label="${c.t({ en: "Keyboard controls", cs: "Ovládání klávesnicí" })}">
            <table>
              <caption>${c.t({ en: "Keyboard", cs: "Klávesnice" })}</caption>
              <thead>
                <tr><th scope="col">${c.t({ en: "Key", cs: "Klávesa" })}</th><th scope="col">${c.t({ en: "Action", cs: "Akce" })}</th></tr>
              </thead>
              <tbody>
                ${keyRows}
              </tbody>
            </table>
          </div>
          <div class="grid grid-2">
            <div class="card">
              <h3>${c.t({ en: "On a phone or tablet", cs: "Na mobilu a tabletu" })}</h3>
              <p>${c.t({
                en: "Swipe left or right on the board to move, swipe down to hard drop and tap to rotate. Or use the buttons under the board: hold, left, rotate, right, soft drop and hard drop.",
                cs: "Přejetím prstu po desce doleva nebo doprava kostku posuneš, přejetím dolů ji shodíš a klepnutím otočíš. Nebo použij tlačítka pod deskou: odložit, doleva, otočit, doprava, zrychlit pád a shodit.",
              })}</p>
            </div>
            <div class="card">
              <h3>${c.t({ en: "The modern toolkit", cs: "Co ti pomáhá" })}</h3>
              <ul class="ticks small">
                <li>${c.t({
                  en: "<strong>Ghost piece:</strong> a faint outline shows exactly where the piece will land.",
                  cs: "<strong>Stín kostky:</strong> průsvitný obrys ukazuje, kam přesně kostka dopadne.",
                })}</li>
                <li>${c.t({
                  en: "<strong>Hold:</strong> bank the current piece and swap it back later, once per piece.",
                  cs: "<strong>Odložení (Hold):</strong> aktuální kostku si schovej a vyměň ji později, jednou za kostku.",
                })}</li>
                <li>${c.t({
                  en: "<strong>Three previews:</strong> you always see the next three pieces.",
                  cs: "<strong>Tři kostky dopředu:</strong> vždycky vidíš, jaké tři kostky přijdou.",
                })}</li>
                <li>${c.t({
                  en: "<strong>Lock delay:</strong> a landed piece waits half a second before it locks, and each move or turn resets that, up to 15 times.",
                  cs: "<strong>Prodleva před zamknutím:</strong> dopadlá kostka čeká půl sekundy, než se zamkne, a každý posun nebo otočení ten čas obnoví, až 15×.",
                })}</li>
                <li>${c.t({
                  en: "<strong>Wall kicks:</strong> a blocked rotation tries nearby positions, so pieces turn even against a wall or the stack.",
                  cs: "<strong>Odrazy od stěn:</strong> když otočení narazí, hra zkusí blízké pozice, takže kostka se otočí i u stěny nebo u hromady.",
                })}</li>
              </ul>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="modes">
          <h2 id="modes">${c.t({ en: "Five ways to play", cs: "Pět způsobů hry" })}</h2>
          <p class="section-intro">${c.t({
            en: "Pick a mode on the title screen with ← → or a tap. Every link below opens the game with that mode already selected.",
            cs: "Režim vybereš na úvodní obrazovce šipkami ← → nebo klepnutím. Každý odkaz níže otevře hru s už vybraným režimem.",
          })}</p>
          <ul class="grid">
            ${modeCards}
          </ul>
        </section>

        <section class="section" aria-labelledby="scoring">
          <h2 id="scoring">${c.t({ en: "Scoring", cs: "Bodování" })}</h2>
          <div class="table-wrap" tabindex="0" role="region" aria-label="${c.t({ en: "Scoring", cs: "Bodování" })}">
            <table>
              <thead>
                <tr><th scope="col">${c.t({ en: "What you do", cs: "Co uděláš" })}</th><th scope="col" class="num">${c.t({
                  en: "Points",
                  cs: "Body",
                })}</th></tr>
              </thead>
              <tbody>
                ${scoring}
              </tbody>
            </table>
          </div>
          <p>${c.t({
            en: "A combo starts when you clear lines with consecutive pieces: the second clearing piece in a row is combo 1, the third combo 2, and so on — any piece that clears nothing breaks the chain. Back-to-back counts only Tangles: two Tangles with no smaller clear in between.",
            cs: "Kombo vzniká, když mažeš řady kostkami hned po sobě: druhá mazající kostka v řadě je kombo 1, třetí kombo 2 a tak dál – kostka, která nic nesmaže, řetěz přeruší. Back-to-back platí jen pro Tangly: dva Tangly bez menšího mazání mezi nimi.",
          })}</p>
          <p class="muted">${c.t({
            en: "Example: at level 3, a Tangle straight after another Tangle, as the third clear in a row, scores 800 × 3 × 1.5 + 50 × 2 × 3 = 3,900 points.",
            cs: `Příklad: na levelu 3 vynese Tangle hned po jiném Tanglu, jako třetí mazání v řadě, 800 × 3 × 1,5 + 50 × 2 × 3 = 3${NBSP}900 bodů.`,
          })}</p>
        </section>

        <section class="section" aria-labelledby="levels">
          <h2 id="levels">${c.t({ en: "Levels and speed", cs: "Levely a rychlost" })}</h2>
          <p class="section-intro">${c.fill({
            en: `You go up a level every 10 lines. Each level cuts the time a piece takes to fall one row by 14.5% — from ${fallMs(1)} ms at level 1 down to the ${fallMs(FLOOR_LEVEL)} ms floor at level ${FLOOR_LEVEL} — moves you to the next world in Marathon and pulls more <a href="{page:pieces}">odd shapes</a> into the bag.`,
            cs: `Každých 10 řad postoupíš o level. S každým levelem se doba, za kterou kostka spadne o řádek, zkrátí o 14,5${NBSP}% – z ${fallMs(1)} ms na levelu 1 až na spodní hranici ${fallMs(FLOOR_LEVEL)} ms na levelu ${FLOOR_LEVEL} –, v Maratonu se přesuneš do dalšího světa a do balíčku se dostane víc <a href="{page:pieces}">divných tvarů</a>.`,
          })}</p>
          <div class="table-wrap" tabindex="0" role="region" aria-label="${c.t({ en: "Speed and odd shapes by level", cs: "Rychlost a divné tvary podle levelu" })}">
            <table>
              <caption>${c.t({ en: "Marathon", cs: "Maraton" })}</caption>
              <thead>
                <tr><th scope="col">${c.t({ en: "Level", cs: "Level" })}</th><th scope="col">${c.t({
                  en: "World",
                  cs: "Svět",
                })}</th><th scope="col" class="num">${c.t({ en: "One row every", cs: "Pád o řádek za" })}</th><th scope="col" class="num">${c.t({
                  en: "Odd-shape chance",
                  cs: "Šance divných tvarů",
                })}</th></tr>
              </thead>
              <tbody>
                ${speedRows}
              </tbody>
            </table>
          </div>
          <p class="muted">${c.t({
            en: `Odd-shape chance is the probability that each copy of an odd shape makes it into the next bag. It reaches ${pct(lang, 1)} at level ${FULL_TANGLE_LEVEL}; Chaos starts there, the Daily Tangle fixes it for the day, and Zen keeps the speed of level 1.`,
            cs: `Šance divných tvarů je pravděpodobnost, že se každá kopie divného tvaru dostane do příštího balíčku. Na levelu ${FULL_TANGLE_LEVEL} dosáhne ${pct(lang, 1)}; Chaos tam rovnou začíná, Denní Tangle ji na celý den zafixuje a Zen drží rychlost levelu 1.`,
          })}</p>
        </section>

        <section class="section" aria-labelledby="challenge">
          <h2 id="challenge">${c.t({ en: "Challenge a friend", cs: "Vyzvi kamaráda" })}</h2>
          <div class="grid grid-2">
            <div class="card">
              <h3>${c.t({ en: "Share a result", cs: "Sdílej výsledek" })}</h3>
              <p>${c.t({
                en: "When a game ends, press <strong>Share</strong>: you get a picture of your board in its world, a line of text and a link. In Marathon, Sprint and Chaos the link carries the game’s seed, so whoever opens it gets the same pieces — and the game shows them your score, or your Sprint time, to beat.",
                cs: "Po konci hry stiskni <strong>Sdílet</strong>: dostaneš obrázek své desky v jejím světě, krátký text a odkaz. V Maratonu, Sprintu a Chaosu nese odkaz seed hry, takže kdo ho otevře, dostane stejné kostky – a hra mu ukáže tvoje skóre nebo čas ve Sprintu, které má překonat.",
              })}</p>
            </div>
            <div class="card">
              <h3>${c.t({ en: "Collection and achievements", cs: "Sbírka a úspěchy" })}</h3>
              <p>${c.t({
                en: "The game tracks which of the 24 pieces you’ve discovered and how often you’ve placed each one. Achievements mark the moments worth remembering: your first Tangle, a Tangle with an odd shape, a line cleared by the Rocket, an empty board, reaching the Inferno, a finished Sprint, a three-day Daily streak, all 24 pieces found — and more.",
                cs: "Hra si vede přehled, které z 24 tvarů máš objevené a kolikrát byl který položen. Úspěchy oslavují chvíle, které stojí za zapamatování: první Tangle, Tangle divným tvarem, řadu smazanou Raketou, prázdnou desku, cestu až do Inferna, dokončený Sprint, tři dny Denního Tanglu po sobě, všech 24 objevených tvarů – a další.",
              })}</p>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="tips">
          <h2 id="tips">${c.t({ en: "Tips for a higher score", cs: "Tipy na vyšší skóre" })}</h2>
          <div class="panel">
            <ul class="ticks">
            ${tips}
            </ul>
          </div>
        </section>

        <section class="section" aria-labelledby="faq">
          <h2 id="faq">${c.t({ en: "Frequently asked questions", cs: "Časté otázky" })}</h2>
          <div class="faq">
            ${faqHtml}
          </div>
        </section>
`,
    final: finalCta(
      c,
      { en: "That’s all you need", cs: "Víc vědět nemusíš" },
      {
        en: "The rest you’ll learn the first time a Rocket drops in. It’s free, it runs in your browser, and it’s one click away.",
        cs: "Zbytek se naučíš, až poprvé přiletí Raketa. Je to zdarma, běží to v prohlížeči a je to na jedno kliknutí.",
      },
      [
        { href: c.game, label: c.t(UI.play) },
        { href: c.play("sprint"), label: c.t({ en: "Try a 40-line Sprint", cs: "Zkus Sprint na 40 řad" }) },
      ]
    ),
    ld: [faqLd],
  });
}

/* ================================================================ DAILY */

function dailyPage(lang) {
  const c = context(lang, "daily");
  const jsPath = c.root + "js/daily.js";

  const widget = c.t({
    en: `<p class="daily-widget" id="daily-today" hidden>
            <span>Today:</span>
            <strong>Daily Tangle #<span data-daily="number"></span></strong>
            <span class="dot" aria-hidden="true">·</span>
            <span><span data-daily="tangle"></span>% tangled</span>
            <span class="dot" aria-hidden="true">·</span>
            <span>next one in <span data-daily="countdown"></span></span>
          </p>`,
    cs: `<p class="daily-widget" id="daily-today" hidden>
            <span>Dnes:</span>
            <strong>Denní Tangle #<span data-daily="number"></span></strong>
            <span class="dot" aria-hidden="true">·</span>
            <span>zamotanost <span data-daily="tangle"></span>${NBSP}%</span>
            <span class="dot" aria-hidden="true">·</span>
            <span>další za <span data-daily="countdown"></span></span>
          </p>`,
  });

  // The widget asks js/daily.js — the game's own clock — so the number and
  // the tangle always match what the game deals. It stays hidden without JS.
  const script = `    <script type="module">
      import { dailyNumber, dailyTangle, msToNextDaily, formatCountdown } from "${jsPath}";

      const box = document.getElementById("daily-today");
      const field = (k) => box.querySelector('[data-daily="' + k + '"]');
      function render() {
        const now = new Date();
        const n = dailyNumber(now);
        if (n < 1) return;
        field("number").textContent = n;
        field("tangle").textContent = Math.round(dailyTangle(now) * 100);
        field("countdown").textContent = formatCountdown(msToNextDaily(now));
        box.hidden = false;
      }
      render();
      setInterval(render, 1000);
    </script>`;

  const steps = [
    {
      en: "<strong>Three minutes.</strong> The clock starts with the first piece. Score as much as you can before time runs out.",
      cs: "<strong>Tři minuty.</strong> Čas se rozběhne s první kostkou. Nahraj co nejvíc bodů, než vyprší.",
    },
    {
      en: "<strong>The same deal for everyone.</strong> The date is the seed: everybody playing Daily Tangle #N gets the same pieces in the same order, wherever they are.",
      cs: "<strong>Pro všechny stejné kostky.</strong> Kostky určuje datum: kdo hraje Denní Tangle #N, dostane stejné kostky ve stejném pořadí, ať je kdekoli.",
    },
    {
      en: `<strong>A fixed tangle.</strong> Each day is tangled to its own degree — between ${pct(lang, 0.5)} and ${pct(lang, 1)} of the odd shapes, in 5% steps — and it stays fixed for the whole run, however fast you level up.`,
      cs: `<strong>Pevná zamotanost.</strong> Každý den je zamotaný po svém – mezi ${pct(lang, 0.5)} a ${pct(lang, 1)} divných tvarů, po pěti procentech – a zamotanost se během hry nemění, ať stoupáš levely jakkoli rychle.`,
    },
    {
      en: "<strong>A new one at midnight.</strong> The Daily follows your own clock, the way Wordle does: a fresh puzzle at local midnight, with the same number for everyone.",
      cs: "<strong>Nová výzva o půlnoci.</strong> Denní Tangle se řídí tvými hodinami, podobně jako Wordle: nová výzva přijde o půlnoci místního času a má pro všechny stejné číslo.",
    },
    {
      en: "<strong>Replays allowed.</strong> Play again as often as you like — your best attempt of the day is the one that counts.",
      cs: "<strong>Hrát můžeš znovu.</strong> Zkoušej to, kolikrát chceš – počítá se tvůj nejlepší pokus dne.",
    },
    {
      en: "<strong>Keep the streak.</strong> Play on consecutive days and your streak grows; miss a day and it starts again from one.",
      cs: "<strong>Drž sérii.</strong> Hraj den po dni a série roste; když den vynecháš, začíná znovu od jedničky.",
    },
    {
      en: "<strong>Share it.</strong> At the end you get a short, spoiler-free result to paste anywhere, with a link that opens today’s Daily Tangle:",
      cs: "<strong>Pochlub se.</strong> Na konci dostaneš krátký výsledek bez spoilerů, který vložíš kamkoli, s odkazem na dnešní Denní Tangle:",
    },
  ]
    .map((s) => `<li>${s[lang]}</li>`)
    .join("\n              ");

  const sample = c.t({
    en: "Tangletris Daily #12 🧩\n18,430 · 37 lines · 75% tangled\n🔥 5-day streak",
    cs: `Tangletris Denní #12 🧩\n18${NBSP}430 · 37 řad · zamotanost 75${NBSP}%\n🔥 série 5 dní`,
  });

  const tips = [
    {
      en: "<strong>Check the tangle first.</strong> At 50% it plays like an early Marathon; at 100% every odd shape is in the bag, so keep the hold slot free for the rare ones.",
      cs: "<strong>Nejdřív mrkni na zamotanost.</strong> Při 50 % se hraje jako začátek Maratonu; při 100 % jsou v balíčku všechny divné tvary, tak si nech odkládací políčko volné pro ty vzácné.",
    },
    {
      en: "<strong>Every attempt deals the same pieces in the same order.</strong> Replay, and you know when the Rocket arrives — plan for it.",
      cs: "<strong>Každý pokus rozdá stejné kostky ve stejném pořadí.</strong> Když hraješ znovu, víš, kdy přiletí Raketa – připrav se na ni.",
    },
    {
      en: "<strong>Three minutes is short.</strong> Tangles and back-to-back bonuses pay more than playing it safe — but a topped-out board ends the run early.",
      cs: "<strong>Tři minuty jsou krátké.</strong> Tangly a back-to-back bonusy vynesou víc než opatrná hra – jenže přeplněná deska hru ukončí předčasně.",
    },
    {
      en: "<strong>Points scale with level.</strong> Lines cleared late in the run are worth more, and the pieces fall faster, too.",
      cs: "<strong>Body se násobí levelem.</strong> Řady smazané ke konci mají větší cenu – a kostky taky padají rychleji.",
    },
  ]
    .map((t) => `<li>${t[lang]}</li>`)
    .join("\n              ");

  const qa = [
    {
      q: { en: "Do I need an account?", cs: "Potřebuju účet?" },
      a: {
        en: "No. Your best score of the day and your streak are kept in this browser’s local storage.",
        cs: "Ne. Dnešní rekord i série se ukládají v místním úložišti tohoto prohlížeče.",
      },
    },
    {
      q: { en: "When does the next one start?", cs: "Kdy začíná další výzva?" },
      a: {
        en: "At midnight on your device’s clock — the countdown above shows how long is left.",
        cs: "O půlnoci podle hodin ve tvém zařízení – odpočet nahoře ukazuje, kolik zbývá.",
      },
    },
    {
      q: { en: "What does “% tangled” mean?", cs: "Co znamená zamotanost?" },
      a: {
        en: `The chance that each copy of an odd shape makes it into the bag. At 100%, every bag holds all ${ODD_COUNT} odd shapes.`,
        cs: `Pravděpodobnost, že se každá kopie divného tvaru dostane do balíčku. Při 100${NBSP}% je v každém balíčku všech ${ODD_COUNT} divných tvarů.`,
      },
    },
  ]
    .map(
      (f) => `<div class="card">
              <h3>${c.t(f.q)}</h3>
              <p>${c.t(f.a)}</p>
            </div>`
    )
    .join("\n            ");

  return layout(c, {
    title: {
      en: "Daily Tangle — A Free Daily Puzzle Challenge | Tangletris",
      cs: "Denní Tangle – denní výzva pro všechny | Tangletris",
    },
    description: {
      en: "A daily Tetris-style challenge: one three-minute game a day, the same pieces for everyone, a streak to keep and a result to share. Resets at local midnight.",
      cs: "Denní Tangle ve stylu Tetrisu: jedna tříminutová hra denně, pro všechny stejné kostky, série dní v řadě a výsledek ke sdílení. Nová výzva každou půlnoc.",
    },
    h1: { en: "The Daily Tangle", cs: "Denní Tangle" },
    hero: `<p class="lead">${c.t({
      en: "One short game a day, the same for everyone. Three minutes on the clock, today’s pieces in today’s order, and a streak that grows every day you show up — a daily puzzle for falling-block fans.",
      cs: "Jedna krátká hra denně, pro všechny stejná. Tři minuty na hodinách, dnešní kostky v dnešním pořadí a série, která roste s každým dnem, kdy přijdeš – denní hádanka pro všechny, kdo mají rádi padající kostky.",
    })}</p>
          ${widget}
          ${ctaRow([
            { href: c.play("daily"), label: c.t({ en: "Play today’s Daily Tangle", cs: "Zahrát dnešní Denní Tangle" }) },
            { href: c.page("howto"), label: c.t({ en: "How to play", cs: "Jak hrát" }) },
          ])}`,
    body: `
        <section class="section" aria-labelledby="rules">
          <h2 id="rules">${c.t({ en: "How it works", cs: "Jak to funguje" })}</h2>
          <div class="panel">
            <ol class="steps">
              ${steps}
            </ol>
            <p class="share-sample"><samp>${esc(sample)}</samp></p>
          </div>
        </section>

        <section class="section" aria-labelledby="daily-tips">
          <h2 id="daily-tips">${c.t({ en: "Tips for a three-minute run", cs: "Tipy na tříminutovku" })}</h2>
          <div class="panel">
            <ul class="ticks">
              ${tips}
            </ul>
            <p class="muted">${c.fill({
              en: `New to the odd shapes? The <a href="{page:pieces}">pieces guide</a> shows where each one wants to go.`,
              cs: `Divné tvary jsou pro tebe novinka? <a href="{page:pieces}">Průvodce tvary</a> ukáže, kam s kterým.`,
            })}</p>
          </div>
        </section>

        <section class="section" aria-labelledby="daily-faq">
          <h2 id="daily-faq">${c.t({ en: "Quick answers", cs: "Rychlé odpovědi" })}</h2>
          <div class="faq">
            ${qa}
          </div>
        </section>
`,
    final: finalCta(
      c,
      { en: "Today’s puzzle is waiting", cs: "Dnešní výzva čeká" },
      {
        en: "Three minutes. The same pieces as everyone else. Go.",
        cs: "Tři minuty. Stejné kostky jako všichni ostatní. Jdeš do toho?",
      },
      [
        { href: c.play("daily"), label: c.t({ en: "Play today’s Daily Tangle", cs: "Zahrát dnešní Denní Tangle" }) },
        { href: c.page("pieces"), label: c.t({ en: "Learn the pieces", cs: "Poznej tvary" }) },
      ]
    ),
    scripts: script,
  });
}

/* ============================================================== SITEMAP */

function sitemap() {
  const pairs = [GAME].concat(NAV_ORDER.map((k) => PAGES[k]));
  const urls = [];
  for (const pair of pairs) {
    for (const lang of ["en", "cs"]) {
      urls.push(`  <url>
    <loc>${BASE + pair[lang]}</loc>
    <lastmod>${LASTMOD}</lastmod>
    <xhtml:link rel="alternate" hreflang="en" href="${BASE + pair.en}"/>
    <xhtml:link rel="alternate" hreflang="cs" href="${BASE + pair.cs}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE + pair.en}"/>
  </url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

/* ================================================================ WRITE */

const BUILDERS = { howto: howtoPage, pieces: piecesPage, worlds: worldsPage, daily: dailyPage };

function write(path, content) {
  const file = join(ROOT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log("wrote " + path);
}

for (const key of NAV_ORDER) {
  for (const lang of ["en", "cs"]) write(PAGES[key][lang] + "index.html", BUILDERS[key](lang));
}
write("sitemap.xml", sitemap());
