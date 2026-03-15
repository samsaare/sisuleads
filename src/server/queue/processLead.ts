import { getDb } from '../db/connection.js';
import { fetchWithJina } from '../scrapers/jina.js';
import { extractLead, findContactUrlCandidates } from '../ai/gemini.js';
import type { ExtractionResult } from '../ai/gemini.js';
import { broadcast } from './sseManager.js';
import { logger } from '../logger.js';
import type { Lead, LogEntry, PersonaConfig } from '../../shared/types.js';

function dbLeadToLead(row: any): Lead {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    companyName: row.company_name,
    domain: row.domain,
    contactName: row.contact_name,
    contactTitle: row.contact_title,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    extractionComment: row.extraction_comment,
    found: Boolean(row.found),
    isGenericContact: Boolean(row.is_generic_contact),
    sourceUrl: row.source_url,
    status: row.status,
    statusMessage: row.status_message,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function updateLeadStatus(
  leadId: string,
  fields: Partial<{
    status: string;
    statusMessage: string;
    errorMessage: string;
    contactName: string;
    contactTitle: string;
    contactEmail: string;
    contactPhone: string;
    extractionComment: string;
    found: boolean;
    isGenericContact: boolean;
    sourceUrl: string;
  }>
) {
  const db = getDb();
  const now = Date.now();

  const sets: string[] = ['updated_at = ?'];
  const values: any[] = [now];

  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.statusMessage !== undefined) { sets.push('status_message = ?'); values.push(fields.statusMessage); }
  if (fields.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(fields.errorMessage); }
  if (fields.contactName !== undefined) { sets.push('contact_name = ?'); values.push(fields.contactName); }
  if (fields.contactTitle !== undefined) { sets.push('contact_title = ?'); values.push(fields.contactTitle); }
  if (fields.contactEmail !== undefined) { sets.push('contact_email = ?'); values.push(fields.contactEmail); }
  if (fields.contactPhone !== undefined) { sets.push('contact_phone = ?'); values.push(fields.contactPhone); }
  if (fields.extractionComment !== undefined) { sets.push('extraction_comment = ?'); values.push(fields.extractionComment); }
  if (fields.found !== undefined) { sets.push('found = ?'); values.push(fields.found ? 1 : 0); }
  if (fields.isGenericContact !== undefined) { sets.push('is_generic_contact = ?'); values.push(fields.isGenericContact ? 1 : 0); }
  if (fields.sourceUrl !== undefined) { sets.push('source_url = ?'); values.push(fields.sourceUrl); }

  values.push(leadId);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
  if (updated) {
    broadcast({ type: 'lead.updated', payload: dbLeadToLead(updated) });
  }
}

function addLog(
  leadId: string,
  message: string,
  level: LogEntry['level'] = 'info'
) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    'INSERT INTO lead_logs (lead_id, timestamp, message, level) VALUES (?, ?, ?, ?)'
  ).run(leadId, now, message, level);

  const log: LogEntry = { timestamp: now, message, level };
  broadcast({ type: 'lead.log', payload: { leadId, log } });
}

export async function processLead(leadId: string) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
  if (!row) return;

  const lead = dbLeadToLead(row);

  // Load campaign's persona config
  const campaignRow = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(lead.campaignId) as any;
  let personaConfig: PersonaConfig | null = null;
  if (campaignRow?.persona_config) {
    try {
      personaConfig = JSON.parse(campaignRow.persona_config);
    } catch {
      // Malformed JSON — proceed with default persona
    }
  }

  addLog(leadId, `Agentti käynnistetty: Aloitetaan kohteen ${lead.companyName} analyysi.`, 'info');
  updateLeadStatus(leadId, { status: 'processing', statusMessage: 'Tarkistetaan etusivu...' });

  try {
    // Pre-flight: resolve cross-domain redirects (e.g. beamark.fi → beam.fi)
    // Direct HEAD request lets Node.js follow redirects; response.url = final URL.
    const inputUrl = lead.domain.startsWith('http') ? lead.domain : `https://${lead.domain}`;
    const effectiveDomain = await (async () => {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 5000);
        const res = await fetch(inputUrl, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
        return res.url || inputUrl;
      } catch {
        return inputUrl;
      }
    })();

    if (effectiveDomain !== inputUrl) {
      const from = new URL(inputUrl).hostname;
      const to = new URL(effectiveDomain).hostname;
      addLog(leadId, `Domain redirectasi ${from} → ${to}, käytetään uutta domainia alisivu-hauissa.`, 'info');
    }

    // VAIHE 1: Etusivu
    const { text: homeContent } = await fetchWithJina(
      lead.domain,
      (msg, level) => addLog(leadId, msg, level),
      { 'X-With-links-Summary': 'true' }
    );

    const homeResult = await extractLead(
      homeContent,
      lead.companyName,
      (msg, level) => addLog(leadId, msg, level),
      personaConfig
    );

    // Found a real personal contact on homepage → done
    if (homeResult.found && !homeResult.isGenericContact) {
      const fullUrl = effectiveDomain;
      addLog(leadId, 'LÖYTYI: Henkilökohtaiset yhteystiedot löytyivät suoraan etusivulta.', 'success');
      updateLeadStatus(leadId, {
        status: 'completed',
        statusMessage: 'Valmis',
        contactName: homeResult.name,
        contactTitle: homeResult.title,
        contactEmail: homeResult.email,
        contactPhone: homeResult.phone,
        extractionComment: homeResult.comment,
        found: true,
        isGenericContact: false,
        sourceUrl: fullUrl,
      });
      return;
    }

    // Found only generic contact on homepage → don't stop, continue to subpage
    if (homeResult.found && homeResult.isGenericContact) {
      addLog(leadId, 'Etusivulta löytyi vain yleinen yritysyhteystieto — jatketaan alasivulle.', 'warning');
    }

    // VAIHE 2: Haetaan rankattu lista alasivuehdokkaista (1 routing-kutsu)
    updateLeadStatus(leadId, { statusMessage: 'Reititetään alasivulle...' });
    const rawCandidates = await findContactUrlCandidates(
      homeContent,
      effectiveDomain,
      (msg, level) => addLog(leadId, msg, level)
    );

    // Filter out unusable candidates:
    // - Hash-fragment URLs (e.g. #contact-us-5) — Jina ignores fragments, returns same page
    // - CGI / PHP script URLs — typically server-side systems that Jina can't render
    const candidates = rawCandidates.filter(url => {
      try {
        const u = new URL(url);
        if (u.hash) return false;                          // anchor link → same page
        if (/\/cgi[-/]|\.php$/i.test(u.pathname)) return false; // CGI/PHP → likely broken
        return true;
      } catch { return false; }
    });

    const homeFullUrl = effectiveDomain;

    if (candidates.length === 0) {
      // Ei yhtään ehdokasta — tallennetaan mitä on
      if (homeResult.found && homeResult.isGenericContact) {
        addLog(leadId, 'Ei yhteystietosivua. Tallennetaan yleinen yritysyhteystieto.', 'warning');
        updateLeadStatus(leadId, {
          status: 'completed', statusMessage: 'Yleinen yhteystieto',
          contactName: homeResult.name, contactTitle: homeResult.title,
          contactEmail: homeResult.email, contactPhone: homeResult.phone,
          extractionComment: homeResult.comment,
          found: true, isGenericContact: true, sourceUrl: homeFullUrl,
        });
      } else {
        addLog(leadId, 'Agentti lopetti työn. Ei selkeää yhteystietosivua.', 'warning');
        updateLeadStatus(leadId, { status: 'completed', statusMessage: 'Ei löytynyt' });
      }
      return;
    }

    // VAIHE 3: Käydään ehdokkaat läpi järjestyksessä (max 2)
    let bestSubResult: ExtractionResult | null = null;
    let bestSubUrl = '';
    // Save first substantive subpage content for potential level-2 routing (avoids re-fetch)
    let firstSubContentForL2: string | null = null;
    let firstSubUrlForL2: string | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const targetUrl = candidates[i];
      const attemptLabel = candidates.length > 1 ? ` (${i + 1}/${candidates.length})` : '';
      let pathname = targetUrl;
      try { pathname = new URL(targetUrl).pathname; } catch {}

      updateLeadStatus(leadId, { statusMessage: `Haetaan alasivu${attemptLabel}: ${pathname}...` });

      const { text: subContent } = await fetchWithJina(targetUrl, (msg, level) => addLog(leadId, msg, level));

      // Save for level-2 if this looks like a directory page with real content
      const DIRECTORY_PATTERNS = /yhteystiedot|contact|tiimi|team|about|meista|meist%C3%A4|henkilosto|people/i;
      if (!firstSubContentForL2 && subContent.length > 500 && DIRECTORY_PATTERNS.test(pathname)) {
        firstSubContentForL2 = subContent;
        firstSubUrlForL2 = targetUrl;
      }

      const subResult = await extractLead(subContent, lead.companyName, (msg, level) => addLog(leadId, msg, level), personaConfig);

      if (subResult.found && !subResult.isGenericContact) {
        addLog(leadId, 'LÖYTYI: Henkilökohtaiset yhteystiedot poimittu alasivulta.', 'success');
        updateLeadStatus(leadId, {
          status: 'completed', statusMessage: 'Valmis',
          contactName: subResult.name, contactTitle: subResult.title,
          contactEmail: subResult.email, contactPhone: subResult.phone,
          extractionComment: subResult.comment,
          found: true, isGenericContact: false, sourceUrl: targetUrl,
        });
        return;
      }

      if (subResult.found && subResult.isGenericContact && !bestSubResult) {
        bestSubResult = subResult;
        bestSubUrl = targetUrl;
        if (i + 1 < candidates.length) {
          addLog(leadId, 'Alasivulta löytyi vain yleinen yhteystieto — kokeillaan seuraavaa ehdokasta.', 'warning');
        }
      }
    }

    // VAIHE 3b: Level-2 routing — jos taso-1 hakemistosivu ei sisältänyt kontaktia,
    // kokeillaan syventyä yhden tason lisää (esim. /yhteystiedot → /yhteystietohaku).
    // Käytetään jo haettua sisältöä — ei uutta Jina-kutsua tässä vaiheessa.
    if (!bestSubResult && !homeResult.found && firstSubContentForL2 && firstSubUrlForL2) {
      addLog(leadId, `Reitittäjä (taso 2): Etsitään syvempiä linkkejä sivulta ${firstSubUrlForL2}`, 'info');
      updateLeadStatus(leadId, { statusMessage: 'Syvennetään hakua (taso 2)...' });

      try {
        const l2Candidates = await findContactUrlCandidates(
          firstSubContentForL2,
          firstSubUrlForL2,
          (msg, level) => addLog(leadId, msg, level)
        );

        const l2Url = l2Candidates.find(u => u !== firstSubUrlForL2);
        if (l2Url) {
          let l2Pathname = l2Url;
          try { l2Pathname = new URL(l2Url).pathname; } catch {}
          updateLeadStatus(leadId, { statusMessage: `Haetaan taso-2 alasivu: ${l2Pathname}...` });

          const { text: l2Content } = await fetchWithJina(l2Url, (msg, level) => addLog(leadId, msg, level));
          const l2Result = await extractLead(l2Content, lead.companyName, (msg, level) => addLog(leadId, msg, level), personaConfig);

          if (l2Result.found && !l2Result.isGenericContact) {
            addLog(leadId, 'LÖYTYI: Henkilökohtaiset yhteystiedot poimittu taso-2 alasivulta.', 'success');
            updateLeadStatus(leadId, {
              status: 'completed', statusMessage: 'Valmis',
              contactName: l2Result.name, contactTitle: l2Result.title,
              contactEmail: l2Result.email, contactPhone: l2Result.phone,
              extractionComment: l2Result.comment,
              found: true, isGenericContact: false, sourceUrl: l2Url,
            });
            return;
          }
          if (l2Result.found && l2Result.isGenericContact) {
            bestSubResult = l2Result;
            bestSubUrl = l2Url;
          }
        }
      } catch { /* taso-2 virhe — jatketaan normaaliin lopetukseen */ }
    }

    // Kaikki ehdokkaat käyty läpi — otetaan paras käytettävissä oleva tulos
    // Prioriteetti: alasivu generic > etusivu generic > ei löytynyt
    const usedResult = bestSubResult ?? (homeResult.found ? homeResult : null);
    const usedUrl = bestSubResult ? bestSubUrl : homeFullUrl;
    const isGeneric = usedResult
      ? (bestSubResult ? bestSubResult.isGenericContact : homeResult.isGenericContact)
      : false;

    if (!usedResult) {
      addLog(leadId, 'Agentti lopetti työn. Tietoja ei löytynyt.', 'warning');
      updateLeadStatus(leadId, { status: 'completed', statusMessage: 'Ei löytynyt' });
    } else {
      addLog(leadId, isGeneric
        ? 'Agentti lopetti työn. Löydettiin vain yleinen yritysyhteystieto.'
        : 'LÖYTYI: Yhteystiedot poimittu.',
        isGeneric ? 'warning' : 'success');
      updateLeadStatus(leadId, {
        status: 'completed',
        statusMessage: isGeneric ? 'Yleinen yhteystieto' : 'Valmis',
        contactName: usedResult.name, contactTitle: usedResult.title,
        contactEmail: usedResult.email, contactPhone: usedResult.phone,
        extractionComment: usedResult.comment,
        found: true, isGenericContact: isGeneric, sourceUrl: usedUrl,
      });
    }
  } catch (error: any) {
    logger.error(`processLead [${lead.domain}]:`, error.stack || error.message);
    addLog(leadId, `Agentti keskeytti työn virheen vuoksi: ${error.message}`, 'error');
    updateLeadStatus(leadId, {
      status: 'error',
      statusMessage: 'Virhe',
      errorMessage: error.message || 'Tuntematon virhe',
    });
  }
}
