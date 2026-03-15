import { GoogleGenAI, Type } from '@google/genai';
import type { PersonaConfig, PersonaRole } from '../../shared/types.js';

export interface ExtractionResult {
  name: string;
  title: string;
  email: string;
  phone: string;
  comment: string;
  found: boolean;
  isGenericContact: boolean;
}

function getAi() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

export async function callGeminiWithRetry<T>(
  taskName: string,
  log: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void,
  apiCall: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error: any) {
      const is503 =
        error.status === 503 ||
        error.message?.includes('503') ||
        error.message?.toLowerCase().includes('overloaded') ||
        error.message?.toLowerCase().includes('busy');

      if (is503 && attempt < maxRetries) {
        const delay = (attempt + 1) * 3000;
        log(
          `${taskName}: Gemini ruuhkautunut. Uudelleenyritys (${attempt + 1}/${maxRetries}) ${delay}ms kuluttua...`,
          'warning'
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

export async function findContactUrlCandidates(
  content: string,
  domain: string,
  log: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void
): Promise<string[]> {
  log('Agentti (Reitittäjä): Etsitään yhteystietosivuehdokkaat linkeistä...', 'info');
  const textEnd = content.length > 15000 ? content.slice(-15000) : content;

  try {
    const response = await callGeminiWithRetry('Reitittäjä', log, () => {
      const ai = getAi();
      return ai.models.generateContent({
        model: 'gemini-flash-latest',
        contents: `Tehtävä: Analysoi alla oleva verkkosivun linkkilista.

Domain: ${domain}

Etsi linkeistä KORKEINTAAN KAKSI (2) URL-osoitetta, jotka todennäköisimmin sisältävät
yrityksen henkilöstön tai päättäjien HENKILÖKOHTAISET yhteystiedot.

Priorisoi sivut tässä järjestyksessä:
1. /yhteystiedot, /tiimi, /henkilosto, /meista, /about, /contact, /people, /team
2. Muut sivut, joilla voi olla henkilölistaus tai henkilökohtaisia yhteystietoja

ÄLÄ SISÄLLYTÄ sivuja, jotka ovat todennäköisesti pelkkiä yhteydenottolomakkeita
(esim. /ota-yhteytta, /contact-form, /lomake, /palaute, /yhteydenottolomake)
— elleivät ne ole ainoa vaihtoehto eikä mitään muuta löydy.

Palauta URL:t JSON-taulukkona tärkeysjärjestyksessä. Jos vain yksi hyvä vaihtoehto,
palauta taulukko jossa yksi alkio. Jos ei yhtään sopivaa, palauta tyhjä taulukko [].
Varmista että jokainen URL alkaa "http". Täydennä tarvittaessa domainilla.

Linkkilista:
${textEnd}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          temperature: 0.1,
        },
      });
    });

    const raw = JSON.parse(response?.text || '[]') as unknown[];
    const candidates = raw
      .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
      .slice(0, 2);

    if (candidates.length === 0) {
      log('Reitittäjä: Sopivaa alasivua ei löydetty.', 'warning');
    } else {
      log(`Reitittäjä: Ehdokkaat: ${candidates.join(', ')}`, 'info');
    }
    return candidates;
  } catch (error: any) {
    log(`Agentti (Reitittäjä) epäonnistui: ${error.message}`, 'error');
    return [];
  }
}

const ROLE_LABELS: Record<PersonaRole, string> = {
  marketing: 'Markkinointijohtaja / CMO / Marketing Manager / markkinointipäällikkö',
  ceo:       'Toimitusjohtaja / CEO / yrittäjä / omistaja',
  sales:     'Myyntijohtaja / Sales Manager / myyntipäällikkö',
  hr:        'HR-johtaja / Henkilöstöjohtaja / People & Culture',
  comms:     'Viestintäjohtaja / Communications Manager / tiedottaja',
  cfo:       'Talousjohtaja / CFO / talouspäällikkö',
  digital:   'Digitaalijohtaja / CDO / Digital Manager / digimarkkinointi',
  cto:       'Teknologiajohtaja / CTO / IT-johtaja / teknologiapäällikkö',
};

function buildPersonaInstructions(persona: PersonaConfig | null): string {
  if (!persona) {
    // Default behaviour: same as before
    return `Etsi ensisijaisesti markkinoinnin päättäjä (Markkinointijohtaja, CMO, Marketing Manager).
Jos ei löydy, etsi seuraavaksi paras johtotason henkilö (Toimitusjohtaja, CEO, yrittäjä).`;
  }

  const primary = ROLE_LABELS[persona.primaryRole];
  const lines: string[] = [`Ensisijainen kohderooli: ${primary}.`];

  if (persona.fallbackRole) {
    const fallback = ROLE_LABELS[persona.fallbackRole];
    lines.push(`Jos ensisijaista ei löydy, etsi: ${fallback}.`);
  }

  if (persona.acceptAnyContact) {
    lines.push('Jos kumpaakaan roolia ei löydy, kelpuuta kuka tahansa nimetty henkilö viimeisenä vaihtoehtona.');
  } else {
    lines.push('Jos sopivaa roolia ei löydy, aseta found:false — älä palauta muita henkilöitä.');
  }

  return lines.join('\n');
}

export async function extractLead(
  content: string,
  companyName: string,
  log: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void,
  persona: PersonaConfig | null = null
): Promise<ExtractionResult> {
  log('Gemini: Poimitaan tiedot (tiukka tekstianalyysi)...');

  const maxChars = 100000;
  let analysisText = content;
  if (content.length > maxChars) {
    log(`Teksti on erittäin laaja (${content.length} merkkiä), optimoidaan analyysia...`, 'info');
    analysisText =
      content.substring(0, maxChars / 2) +
      '\n\n... [TEKSTIÄ KATKAISTU VÄLISTÄ] ...\n\n' +
      content.substring(content.length - maxChars / 2);
  }

  const personaInstructions = buildPersonaInstructions(persona);

  try {
    const response = await callGeminiWithRetry('Analyysi', log, () => {
      const ai = getAi();
      return ai.models.generateContent({
        model: 'gemini-flash-latest',
        contents: `Tehtävä: Poimi yrityksen päättäjän yhteystiedot ANNETUSTA TEKSTISTÄ.

TÄRKEÄÄ:
1. Käytä VAIN alla olevaa tekstiä. ÄLÄ käytä aiempaa tietoasi tai arvaa tietoja.
2. Jos tietoa ei löydy tekstistä, aseta 'found': false.
3. Älä hallusinoi sähköpostiosoitteita, jos niitä ei ole mainittu. Ainoa poikkeus on jos sivulla selvästi ilmoitetaan sähköpostien olevan standardimuotoa esim etunimi.sukunimi voit rakentaa tuon osoitteen.

KOHDEROOLIT:
${personaInstructions}

HENKILÖKOHTAINEN vs. YLEINEN YHTEYSTIETO:
- Sähköposti on HENKILÖKOHTAINEN jos: etunimi@, etunimi.sukunimi@, e.sukunimi@ tai vastaava henkilöön viittaava muoto.
- Sähköposti on YLEINEN (ei kelpaa henkilökohtaiseksi) jos: info@, toimisto@, myynti@, asiakaspalvelu@, hello@, contact@, office@ tai muu yleinen osoite.
- Puhelinnumero on HENKILÖKOHTAINEN jos: suomalainen matkapuhelin — alkaa 040, 041, 044, 045, 050, 0400 tai kansainvälisessä muodossa +3584.
- Puhelinnumero on YLEINEN (ei kelpaa) jos: alkaa 09, 03, 010, 020 tai on muuten selvästi vaihde/yleislinja.

Aseta isGenericContact:true jos:
- Löydät nimetyn henkilön mutta hänellä on vain yleinen sähköposti/yleinen numero (ei henkilökohtainen).
- Löydät vain yleisiä yritysyhteystietoja ilman nimettyä henkilöä (tällöin myös found:false).

Jos henkilöllä on henkilökohtainen yhteystieto: isGenericContact:false.

Yritys: ${companyName}

Tekstisisältö:
${analysisText}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name:             { type: Type.STRING },
              title:            { type: Type.STRING },
              email:            { type: Type.STRING },
              phone:            { type: Type.STRING },
              comment:          {
                type: Type.STRING,
                description: 'Perustelu valinnalle. Kerro myös jos tietoa ei löytynyt tai yhteystieto on yleinen.',
              },
              found:            { type: Type.BOOLEAN },
              isGenericContact: { type: Type.BOOLEAN },
            },
            required: ['name', 'title', 'email', 'phone', 'comment', 'found', 'isGenericContact'],
          },
        },
      });
    });

    const result = JSON.parse(response?.text || '{}') as ExtractionResult;
    if (result.found && !result.isGenericContact) {
      log(`Gemini: Löydettiin päättäjä: ${result.name}`, 'success');
    } else if (result.found && result.isGenericContact) {
      log(`Gemini: Löydettiin henkilö mutta vain yleinen yhteystieto: ${result.name}`, 'warning');
    } else {
      log('Gemini: Tietoja ei löytynyt tästä tekstiosasta.', 'warning');
    }
    return result;
  } catch (error: any) {
    log(`Gemini: Analyysi epäonnistui: ${error.message}`, 'error');
    return { name: '', title: '', email: '', phone: '', comment: `Analyysi epäonnistui: ${error.message}`, found: false, isGenericContact: false };
  }
}
