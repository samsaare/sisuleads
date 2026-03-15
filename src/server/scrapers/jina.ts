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
  // The URL that was actually requested (after local normalization).
  // Cross-domain redirect detection is handled in processLead via resolveRedirect().
  finalUrl: string;
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

  // On 400, retry with alternative URL variants before giving up.
  // Some servers require/forbid the www. prefix; others reject extra headers.
  if (response.status === 400) {
    const errorBody = await response.text().catch(() => '');
    log(`Jina Reader: 400 Bad Request — ${errorBody.slice(0, 200) || '(ei virheviestiä)'}`, 'warning');

    // Variant 1: toggle www. prefix
    const wwwVariant = targetUrl.includes('://www.')
      ? targetUrl.replace('://www.', '://')
      : targetUrl.replace('://', '://www.');

    log(`Jina Reader: Kokeillaan URL-varianttia: ${wwwVariant}...`, 'info');
    const r2 = await fetch(`${JINA_READER_URL}${wwwVariant}`, { headers }).catch(() => null);

    if (r2?.ok) {
      response = r2;
    } else {
      // Variant 2: minimal headers (no X-Remove-Selector / X-Respond-Timing)
      const minHeaders: Record<string, string> = { Accept: 'text/event-stream', 'X-Locale': 'fi-FI' };
      if (headers['Authorization']) minHeaders['Authorization'] = headers['Authorization'];
      log('Jina Reader: Kokeillaan minimal headers -varianttia...', 'info');
      const r3 = await fetch(`${JINA_READER_URL}${targetUrl}`, { headers: minHeaders }).catch(() => null);
      if (r3?.ok) {
        response = r3;
      } else {
        log(`Jina Reader virhe: 400 kaikilla varianteilla — sivu ei onnistu.`, 'error');
        throw new Error(`Jina Reader failed: Bad Request`);
      }
    }
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

  log(`Jina: Vastaus vastaanotettu (${text.length} merkkiä).`, 'success');
  return { text, finalUrl: targetUrl };
}
