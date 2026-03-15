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

export interface JinaResult {
  text: string;
  // The final URL after redirects, parsed from Jina's SSE metadata block.
  // Falls back to the requested URL if metadata is absent.
  finalUrl: string;
}

// Parses the final URL from Jina's SSE response (event: metadata / data: {"url": ...}).
function parseFinalUrl(sseText: string, fallback: string): string {
  // SSE uses \r\n; strip \r so line comparisons work reliably
  const lines = sseText.split('\n').map(l => l.replace(/\r$/, ''));

  // Look for event: metadata, then find the next non-empty data: line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'event: metadata') {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].trim() === '') continue;
        if (lines[j].startsWith('data:')) {
          try {
            const json = JSON.parse(lines[j].slice(5).trim());
            if (typeof json.url === 'string' && json.url.startsWith('http')) {
              return json.url;
            }
          } catch { /* malformed — keep looking */ }
        }
        break;
      }
    }
  }

  // Fallback: scan all data: lines for any JSON blob containing a url field
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    try {
      const json = JSON.parse(line.slice(5).trim());
      if (typeof json.url === 'string' && json.url.startsWith('http')) {
        return json.url;
      }
    } catch { /* not JSON */ }
  }

  return fallback;
}

export async function fetchWithJina(
  url: string,
  log: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void,
  customHeaders: Record<string, string> = {}
): Promise<JinaResult> {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(`${JINA_READER_URL}${targetUrl}`, { headers, signal: controller.signal });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      log('Jina Reader virhe: Aikakatkaisu (30s)', 'error');
      throw new Error('Jina Reader timeout');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

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

  const finalUrl = parseFinalUrl(text, targetUrl);

  log(`Jina: Vastaus vastaanotettu (${text.length} merkkiä).`, 'success');
  return { text, finalUrl };
}
