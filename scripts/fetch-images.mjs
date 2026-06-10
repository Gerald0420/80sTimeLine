#!/usr/bin/env node
/* ============================================================================
 * fetch-images.mjs — download FREE (Wikimedia Commons) images for the timeline
 * ----------------------------------------------------------------------------
 * Run this where you have open network access (your laptop, or a Claude Code
 * web session whose network policy allows wikimedia.org):
 *
 *     node scripts/fetch-images.mjs
 *
 * What it does:
 *   • For every event it tries a prioritized list of Wikipedia articles
 *     (the event's own article first, then curated free-image alternatives
 *     such as the performer, the hardware, or the venue).
 *   • It ONLY accepts an image whose thumbnail is served from
 *     /wikipedia/commons/ — i.e. hosted on Wikimedia Commons, which accepts
 *     only freely-licensed (public-domain / Creative Commons) media. Local
 *     fair-use files (/wikipedia/en/) are rejected, so nothing copyrighted is
 *     ever stored.
 *   • Saves images to /images, writes images/manifest.json (consumed by
 *     index.html) and images/CREDITS.md (author + license for every image).
 *
 * Requires Node 18+ (uses global fetch).
 * ==========================================================================*/
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = join(ROOT, 'images');
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
  if (!thumb || !thumb.includes('/commons/')) return null; // free (Commons) only
  return { thumb, file: pg.pageimage };
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

  await writeFile(join(IMG_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(IMG_DIR, 'CREDITS.md'),
    `# Image credits\n\nAll images below are hosted on Wikimedia Commons under public-domain or Creative Commons licenses.\n\n${credits.sort().join('\n')}\n`
  );

  console.log(`\nDone. ${Object.keys(manifest).length} images saved, ${skipped.length} left as stylized art.`);
  if (skipped.length) console.log('No free image found for:\n  ' + skipped.join('\n  '));
}

main().catch(e => { console.error(e); process.exit(1); });
