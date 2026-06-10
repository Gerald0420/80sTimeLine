#!/usr/bin/env node
/* ============================================================================
 * fetch-images.mjs — download FREE (Wikimedia Commons) images for the timeline
 * ----------------------------------------------------------------------------
 * Run this where you have open network access (your laptop, or a Claude Code
 * web session whose network policy allows wikimedia.org).
 *
 *   PUBLIC build (safe to deploy) — free Wikimedia Commons images only:
 *       node scripts/fetch-images.mjs
 *     → writes /images (commit these; they get served on your public site)
 *
 *   PRIVATE build (LOCAL USE ONLY) — every lead image, posters/covers too:
 *       node scripts/fetch-images.mjs --all
 *     → writes /private (gitignored; NEVER published). For your eyes only.
 *
 * What it does:
 *   • For every event it tries a prioritized list of Wikipedia articles
 *     (the event's own article first, then curated alternatives such as the
 *     performer, the hardware, or the venue).
 *   • PUBLIC build accepts an image ONLY if its thumbnail is served from
 *     /wikipedia/commons/ — Wikimedia Commons hosts only freely-licensed
 *     (public-domain / CC) media, so nothing copyrighted is stored.
 *   • PRIVATE build (--all) accepts whatever the article's lead image is,
 *     including local fair-use posters and album covers, for personal
 *     offline viewing only.
 *   • Writes manifest.json (consumed by index.html) and a credits/sources
 *     file alongside the images.
 *
 * Requires Node 18+ (uses global fetch).
 * ==========================================================================*/
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = process.argv.includes('--all') || process.argv.includes('--private');
const IMG_DIR = join(ROOT, ALL ? 'private' : 'images');   // private/ is gitignored
const MANIFEST_PATH = join(IMG_DIR, 'manifest.json');
const CREDITS_PATH = join(IMG_DIR, ALL ? 'SOURCES.md' : 'CREDITS.md');
const UA = '80sTimeline-image-fetch/1.0 (https://github.com/Gerald0420/80sTimeLine)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => (s ? String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '');

/* ---- Curated free-image alternatives for the copyrighted (icon) cards ----
   The event's own article is always tried first; these are fallbacks whose
   lead image is typically a free Commons photo (a person, a product, a place). */
const ALT = {
  'The Empire Strikes Back': ['Harrison Ford', 'Mark Hamill', 'Carrie Fisher'],
  'Pac-Man Fever': ['Toru Iwatani', 'Namco'],
  '“Who Shot J.R.?”': ['Larry Hagman'],
  'John Lennon Assassinated': ['John Lennon', 'The Dakota'],
  'MTV Launches': ['MTV'],
  'Raiders of the Lost Ark': ['Harrison Ford', 'Steven Spielberg', 'George Lucas'],
  'E.T. Phones Home': ['Steven Spielberg', 'Drew Barrymore'],
  'Michael Jackson’s Thriller': ['Michael Jackson'],
  'The First Emoticon': ['Scott Fahlman'],
  'M*A*S*H Finale': ['Alan Alda'],
  'Return of the Jedi': ['Mark Hamill', 'Harrison Ford', 'Carrie Fisher'],
  '“Thriller” Video Premieres': ['Michael Jackson', 'John Landis'],
  'Ghostbusters': ['Bill Murray', 'Dan Aykroyd', 'Sigourney Weaver'],
  'Prince’s Purple Rain': ['Prince (musician)'],
  'The Terminator': ['Arnold Schwarzenegger', 'James Cameron', 'Linda Hamilton'],
  'Band Aid': ['Bob Geldof', 'Midge Ure'],
  'Live Aid': ['Wembley Stadium (1923)', 'Bob Geldof', 'Queen (band)'],
  '“We Are the World”': ['Lionel Richie', 'Quincy Jones', 'Michael Jackson'],
  'Back to the Future': ['DMC DeLorean', 'Michael J. Fox', 'Christopher Lloyd'],
  'The Breakfast Club': ['Molly Ringwald', 'Judd Nelson', 'John Hughes (filmmaker)'],
  'Nintendo & Super Mario': ['Nintendo Entertainment System', 'Shigeru Miyamoto'],
  'Top Gun': ['Grumman F-14 Tomcat', 'Tom Cruise'],
  'Oprah Goes National': ['Oprah Winfrey'],
  'The Simpsons Debut': ['Matt Groening'],
  'Michael Jackson’s Bad': ['Michael Jackson'],
  'U2’s The Joshua Tree': ['U2', 'Bono', 'The Edge'],
  'Dirty Dancing': ['Patrick Swayze', 'Jennifer Grey'],
  'Who Framed Roger Rabbit': ['Robert Zemeckis', 'Bob Hoskins'],
  'Die Hard': ['Bruce Willis', 'Alan Rickman'],
  'Rain Man': ['Dustin Hoffman', 'Tom Cruise', 'Barry Levinson'],
  'A Brief History of Time': ['Stephen Hawking'],
  'Batman': ['Michael Keaton', 'Jack Nicholson', 'Tim Burton'],
  'The Little Mermaid': ['Jodi Benson', 'Walt Disney Animation Studios'],
  'Seinfeld Pilot': ['Jerry Seinfeld', 'Jason Alexander'],
  // a few world-event famous photos are also non-free; offer free fallbacks
  'Iran Hostages Freed': ['Jimmy Carter'],
  'The Tylenol Crisis': ['Tylenol (brand)'],
  'KAL 007 Shot Down': ['Boeing 747'],
  'Vietnam Memorial Opens': ['Vietnam Veterans Memorial'],
};

const titleFromSlug = s => decodeURIComponent(s).replace(/_/g, ' ');

/* Pull the WIKI {title: slug} map straight out of index.html so the two
   never drift apart. */
async function loadEvents() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const block = html.match(/const WIKI = \{([\s\S]*?)\};/);
  if (!block) throw new Error('Could not find WIKI map in index.html');
  const re = /'((?:[^'\\]|\\.)*)':'((?:[^'\\]|\\.)*)'/g;
  const events = [];
  let m;
  while ((m = re.exec(block[1]))) {
    const title = m[1];
    const primary = titleFromSlug(m[2]);
    events.push({ title, candidates: [primary, ...(ALT[title] || [])] });
  }
  return events;
}

async function api(params) {
  const url = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query&' + params;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function leadImage(title) {
  const d = await api('prop=pageimages&piprop=thumbnail|name&pithumbsize=800&titles=' + encodeURIComponent(title));
  const pages = d && d.query && d.query.pages;
  if (!pages) return null;
  const pg = pages[Object.keys(pages)[0]];
  const thumb = pg && pg.thumbnail && pg.thumbnail.source;
  if (!thumb) return null;
  if (!ALL && !thumb.includes('/commons/')) return null;   // public build: Commons (free) only
  return { thumb, file: pg.pageimage, free: thumb.includes('/commons/') };
}

async function creditFor(file) {
  const fallback = { author: 'Wikimedia Commons', license: '', url: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file) };
  try {
    const d = await api('prop=imageinfo&iiprop=extmetadata|url&titles=' + encodeURIComponent('File:' + file));
    const pages = d && d.query && d.query.pages;
    const pg = pages[Object.keys(pages)[0]];
    const ii = pg && pg.imageinfo && pg.imageinfo[0];
    const meta = (ii && ii.extmetadata) || {};
    return {
      author: strip(meta.Artist && meta.Artist.value) || 'Wikimedia Commons',
      license: strip(meta.LicenseShortName && meta.LicenseShortName.value) || '',
      url: (ii && ii.descriptionurl) || fallback.url,
    };
  } catch {
    return fallback;
  }
}

const slugify = t =>
  t.toLowerCase().replace(/[’'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  console.log(ALL
    ? '⚠  PRIVATE build — downloading ALL lead images (incl. copyrighted fair-use)\n   into /private. This folder is gitignored: keep it local, do NOT publish.\n'
    : 'PUBLIC build — downloading FREE Wikimedia Commons images only into /images.\n');
  await mkdir(IMG_DIR, { recursive: true });
  const events = await loadEvents();
  const manifest = {};
  const credits = [];
  const skipped = [];

  for (const ev of events) {
    let hit = null, usedTitle = null;
    for (const cand of ev.candidates) {
      try {
        hit = await leadImage(cand);
      } catch { hit = null; }
      if (hit) { usedTitle = cand; break; }
      await sleep(120);
    }
    if (!hit) { skipped.push(ev.title); console.log('· skip  ', ev.title); continue; }

    const ext = (hit.thumb.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const fname = `${slugify(ev.title)}.${ext}`;
    try {
      const bytes = await download(hit.thumb, join(IMG_DIR, fname));
      const credit = await creditFor(hit.file);
      manifest[ev.title] = { file: fname, credit };
      credits.push(`- **${ev.title}** — via *${usedTitle}* — ${credit.author}${credit.license ? ' · ' + credit.license : ''} — ${credit.url}`);
      console.log(`✓ ${fname.padEnd(34)} ${(bytes / 1024 | 0)}KB  (${usedTitle})`);
    } catch (e) {
      skipped.push(ev.title);
      console.log('· fail  ', ev.title, String(e.message || e));
    }
    await sleep(150);
  }

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const header = ALL
    ? '# Private image sources — LOCAL USE ONLY\n\nThese images were pulled from Wikipedia for personal, offline viewing and may include copyrighted, fair-use material. Do NOT redistribute or deploy them publicly.\n\n'
    : '# Image credits\n\nAll images below are hosted on Wikimedia Commons under public-domain or Creative Commons licenses.\n\n';
  await writeFile(CREDITS_PATH, header + credits.sort().join('\n') + '\n');

  console.log(`\nDone. ${Object.keys(manifest).length} images saved to /${ALL ? 'private' : 'images'}, ${skipped.length} ${ALL ? 'had no image' : 'left as stylized art'}.`);
  if (skipped.length) console.log('No image found for:\n  ' + skipped.join('\n  '));
  if (ALL) console.log('\nView locally:  npx serve .   (or: python3 -m http.server)\nthen open the printed http://localhost URL — the private images load automatically.');
}

main().catch(e => { console.error(e); process.exit(1); });
