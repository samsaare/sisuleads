const JINA_READER_URL = 'https://r.jina.ai/';

// Applied to every request. Removes known noise elements at the HTML level
// before Jina extracts text — more reliable than post-processing the returned string.
const BASE_HEADERS: Record<string, string> = {
  // Cookie/consent banners: these never contain B2B contact info.
  // Covers: OneTrust, CookieConsent.js, Cookiebot, and generic patterns.
  'X-Remove-Selector': [
    '[class*="cookie"]',
    '[id*="cookie"]',
    '#onetrust-banner-sdk',
    '.cc-window',
    '#CybotCookiebotDialog',
  ].join(', '),

  // Wait for JS mutations to settle (React/Vue/Angular SPAs, WP JS overlays).
  // Equivalent to: no DOM mutations for 200ms. Adds ~0.2–1s on JS-heavy pages,
  // negligible on static sites.
  'X-Respond-Timing': 'mutation-idle',

  // Finnish locale — bilingual sites (fi/en) will default to Finnish content.
  'X-Locale': 'fi-FI',
};

export async function fetchWithJina(
  url: string,
  log: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void,
  customHeaders: Record<string, string> = {}
): Promise<string> {
  const targetUrl = url.startsWith('http') ? url : `https://${url}`;
  log(`Jina Reader: Haetaan ${targetUrl}...`);

  const headers: Record<string, string> = {
    // SSE format: Jina returns a rich JSON structure alongside the content.
    // The full SSE payload (~20-30k chars) gives Gemini enough context to
    // reliably identify contacts even when titles are missing.
    // Plain format (~4-5k chars) causes Gemini to miss contacts without titles.
    Accept: 'text/event-stream',
    ...BASE_HEADERS,
    ...customHeaders,
  };

  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;

  const response = await fetch(`${JINA_READER_URL}${targetUrl}`, { headers });

  if (!response.ok) {
    log(`Jina Reader virhe: ${response.status} ${response.statusText}`, 'error');
    throw new Error(`Jina Reader failed: ${response.statusText}`);
  }

  const text = await response.text();
  const lower = text.toLowerCase();

  // Detect 404 / error pages
  if (
    lower.includes('404 not found') ||
    lower.includes('sivua ei löytynyt') ||
    lower.includes('page not found') ||
    (text.length < 1500 && lower.includes('404'))
  ) {
    log('Jina: Sivu tunnistettiin virhesivuksi (404).', 'warning');
    throw new Error('Page content is 404');
  }

  log(`Jina: Vastaus vastaanotettu (${text.length} merkkiä).`, 'success');
  return text;
}
