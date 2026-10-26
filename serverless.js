// TRMNL serverless transform (Node.js runtime) for the NWS Weather Story.
//
// Input (from TRMNL):
//   The polled https://api.weather.gov/points/{lat},{lon} response; properties.cwa names the office.
//   trmnl.plugin_settings.custom_fields_values: { location, story }
//   trmnl.state: { location, office, page, next } from the last run; {} on a fresh install.
// Offices post their stories in the same tab widget, some at /{office}/weatherstory and
// some on their home page /{office}/. The page that last had stories is tried first, then
// the other. A failed poll is refetched here, and a known office outlives an API outage.
//
// Output: { office, story, count, error, trmnl_state }, consumed by shared.liquid.
//   office: { id, name }, or null when no office covers the location.
//   story: { title, description, image, updated, number }, or null with an error.
//   count: how many stories the office has posted.
//   trmnl_state: what the next run starts from; TRMNL strips it from the merge variables.

const API = 'https://api.weather.gov';
const SITE = 'https://www.weather.gov';
const HEADERS = { 'User-Agent': 'Leo Herzog <leo@herzog.tech>' };
const PAGES = {
  weatherstory: (id) => `${SITE}/${id}/weatherstory`,
  home: (id) => `${SITE}/${id}/`,
};

// The run is cut off at 5 s. All requests share this budget, so a slow
// weather.gov fails the request in flight instead of the whole run.
const BUDGET_MS = 4500;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function budget(ms) {
  const end = Date.now() + ms;
  return () => AbortSignal.timeout(Math.max(1, end - Date.now()));
}

// "42.963412, -85.668086" or "42.96 -85.67" -> "42.9634,-85.6681"; null when unparseable.
// api.weather.gov redirects any point given to more than 4 decimals.
function parseLocation(text) {
  const m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `${Number(lat.toFixed(4))},${Number(lon.toFixed(4))}`;
}

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] || m;
  });
}

// Markup to one line of plain text. Emoji go too: ePaper fonts have no glyphs for them.
function text(html) {
  const plain = decode(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || null;
}

// Port of worker.js URL normalization: resolves protocol- and root-relative
// sources and collapses doubled slashes in the path.
function absolute(src) {
  try {
    const url = new URL(decode(src), `${SITE}/`);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    return url.href;
  } catch (e) {
    return null;
  }
}

function imgSrc(html) {
  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? absolute(m[1]) : null;
}

// Each tab of the story widget is one story: the nav link holds its title, the
// matching c-tab its graphic and description, in the same order. Home pages also
// carry a sidebar wxstory thumbnail outside the widget, so nothing outside it counts.
function parseTabs(html) {
  const start = html.indexOf('id="tabs"');
  const end = start < 0 ? -1 : html.indexOf('tabs.js', start);
  const widget = start < 0 ? '' : html.slice(start, end < 0 ? undefined : end);
  const titles = [...widget.matchAll(/class="c-tabs-nav__link[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
  return widget
    .split(/<div class="c-tab(?: is-active)?">/)
    .slice(1)
    .map((tab, i) => {
      const desc = tab.match(/class="description"[^>]*>([\s\S]*?)(?:<div class="more"|$)/);
      return { title: titles[i] || null, image: imgSrc(tab), description: desc ? text(desc[1]) : null };
    })
    .filter((s) => s.image);
}

function officeName(html) {
  const m = html.match(/<p class="sitename-name">([^<]+)<\/p>/);
  const name = m && text(m[1]);
  return name ? name.replace(/^NWS\s+/i, '') : null;
}

// The lowercase id of the office covering the point; null when no office does.
async function findOffice(input, point, state, signal) {
  const polled = input && input.properties && input.properties.cwa;
  if (polled) return polled.toLowerCase();
  if (state.location === point && state.office) return state.office;
  const res = await fetch(`${API}/points/${point}`, { headers: HEADERS, signal: signal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`api.weather.gov answered ${res.status}`);
  const body = await res.json();
  const cwa = body && body.properties && body.properties.cwa;
  return cwa ? cwa.toLowerCase() : null;
}

// The office's stories from whichever page has them, trying `first` before the other.
async function loadStories(id, first, signal) {
  const order = first === 'home' ? ['home', 'weatherstory'] : ['weatherstory', 'home'];
  let name = null;
  for (const page of order) {
    const res = await fetch(PAGES[page](id), { headers: HEADERS, signal: signal() });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`weather.gov answered ${res.status}`);
    const html = await res.text();
    name = name || officeName(html);
    const stories = parseTabs(html);
    if (stories.length) return { page, name, stories };
  }
  return { page: null, name, stories: [] };
}

// Some offices link graphicast/smallN.png, a 725x408 thumbnail of the 1920x1080 graphicast/N.png.
function fullSize(url) {
  return url.replace(/\/graphicast\/small(\d+)\.png$/i, '/graphicast/$1.png');
}

// The largest version of the graphic that exists, and when it was last replaced (null when unknown).
async function resolveImage(url, signal) {
  for (const candidate of new Set([fullSize(url), url])) {
    try {
      const res = await fetch(candidate, { method: 'HEAD', headers: HEADERS, signal: signal() });
      if (!res.ok) continue;
      const modified = res.headers.get('last-modified');
      const date = modified ? new Date(modified) : null;
      return { url: candidate, updated: date && !Number.isNaN(date.getTime()) ? date : null };
    } catch (e) {
      break;
    }
  }
  return { url, updated: null };
}

async function run(input) {
  const trmnl = (input && input.trmnl) || {};
  const fields = (trmnl.plugin_settings && trmnl.plugin_settings.custom_fields_values) || {};
  const state = trmnl.state || {};
  const point = parseLocation(fields.location);
  if (!point) {
    return { office: null, story: null, count: 0, error: 'Set a location in the plugin settings.' };
  }
  const signal = budget(BUDGET_MS);

  let id;
  try {
    id = await findOffice(input, point, state, signal);
  } catch (e) {
    return { office: null, story: null, count: 0, error: 'weather.gov is unavailable right now.' };
  }
  if (!id) {
    return { office: null, story: null, count: 0, error: 'No NWS forecast office covers this location.' };
  }

  let found;
  try {
    found = await loadStories(id, state.office === id ? state.page : null, signal);
  } catch (e) {
    return { office: { id: id.toUpperCase(), name: null }, story: null, count: 0, error: 'weather.gov is unavailable right now.' };
  }
  const office = { id: id.toUpperCase(), name: found.name };
  if (!found.stories.length) {
    return { office, story: null, count: 0, error: 'This office has no Weather Story posted right now.', trmnl_state: { location: point, office: id } };
  }

  let index = 0;
  if (fields.story === 'rotate' && state.office === id) index = (Number(state.next) || 0) % found.stories.length;
  const story = found.stories[index];

  // Offices overwrite the same file name with each new graphic, so the version
  // keeps the merge variables, and with them the screen, changing with the picture.
  const image = await resolveImage(story.image, signal);
  const updated = image.updated ? image.updated.toISOString() : null;
  const src = image.updated ? `${image.url}?v=${Math.floor(image.updated.getTime() / 1000)}` : image.url;

  return {
    office,
    story: { ...story, image: src, updated, number: index + 1 },
    count: found.stories.length,
    error: null,
    trmnl_state: { location: point, office: id, page: found.page, next: index + 1 },
  };
}
