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
  const personaConfig: PersonaConfig | null = campaignRow?.persona_config
    ? JSON.parse(campaignRow.persona_config)
    : null;

  addLog(leadId, `Agentti käynnistetty: Aloitetaan kohteen ${lead.companyName} analyysi.`, 'info');
  updateLeadStatus(leadId, { status: 'processing', statusMessage: 'Tarkistetaan etusivu...' });

  try {
    // VAIHE 1: Etusivu
    const homeContent = await fetchWithJina(
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
      const fullUrl = lead.domain.startsWith('http') ? lead.domain : `https://${lead.domain}`;
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
    const candidates = await findContactUrlCandidates(
      homeContent,
      lead.domain,
      (msg, level) => addLog(leadId, msg, level)
    );

    const homeFullUrl = lead.domain.startsWith('http') ? lead.domain : `https://${lead.domain}`;

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

    for (let i = 0; i < candidates.length; i++) {
      const targetUrl = candidates[i];
      const attemptLabel = candidates.length > 1 ? ` (${i + 1}/${candidates.length})` : '';
      let pathname = targetUrl;
      try { pathname = new URL(targetUrl).pathname; } catch {}

      updateLeadStatus(leadId, { statusMessage: `Haetaan alasivu${attemptLabel}: ${pathname}...` });

      const subContent = await fetchWithJina(targetUrl, (msg, level) => addLog(leadId, msg, level));
      const subResult = await extractLead(subContent, lead.companyName, (msg, level) => addLog(leadId, msg, level), personaConfig);

      if (subResult.found && !subResult.isGenericContact) {
        // Henkilökohtainen kontakti löytyi — lopetetaan heti
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
        // Yleinen kontakti — tallennetaan parhaaksi toistaiseksi, jatketaan seuraavaan
        bestSubResult = subResult;
        bestSubUrl = targetUrl;
        if (i + 1 < candidates.length) {
          addLog(leadId, 'Alasivulta löytyi vain yleinen yhteystieto — kokeillaan seuraavaa ehdokasta.', 'warning');
        }
      }
      // Ei löytynyt → jatketaan seuraavaan ehdokkaaseen
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
