# SisuLead Miner

B2B-liidien etsintätyökalu suomalaisille myyntitiimeille. Syötä lista yrityksiä — saat takaisin päättäjien nimet, tittelit, sähköpostit ja puhelinnumerot.

---

## Mitä se tekee

SisuLead Miner käy läpi yrityksen verkkosivut automaattisesti ja poimii oikean päättäjän yhteystiedot tekoälyn avulla. Myyjä antaa listan domaineja aamulla — tunnissa hänellä on täytetty taulukko valmiina CRM-tuontia varten.

**Hakuprosessi per liidi:**
1. Jina Reader hakee etusivun sisällön
2. Gemini Flash tunnistaa päättäjän (tai toteaa ettei löydy)
3. Jos etusivulta löytyi vain yleinen yrityssähköposti — jatketaan alasivulle automaattisesti
4. Gemini reitittää oikealle alasivulle (Yhteystiedot / Tiimi / Meistä)
5. Toistetaan ekstraktio — tallennetaan tulos

**Ominaisuudet:**
- Persona-kohdistus per kampanja: ensisijainen rooli + varavalinta (CMO, CEO, Myyntijohtaja jne.)
- Älykäs yleiskontaktin tunnistus: info@, toimisto@, vaihde → ei hyväksytä, jatketaan hakua
- Reaaliaikaiset päivitykset SSE:n kautta (taulukko täyttyy livenä)
- Rinnakkainen käsittely (p-queue, concurrency=3)
- CSV-tuonti ja -vienti
- Kaikki data pysyy omalla koneella (SQLite, ei pilveä)

---

## Asennus — Windows .exe (suositeltu ei-teknisille käyttäjille)

### 1. Lataa installer

Lataa uusin `SisuLead Miner Setup x.x.x.exe` [Releases](../../releases)-sivulta.

### 2. Asenna

Kaksoisklikkaa Setup-tiedostoa ja seuraa asennusohjetta. Node.js:ää tai muita riippuvuuksia ei tarvita.

### 3. API-avaimet

Ohjelma tarvitsee kaksi API-avainta toimiakseen. Avaa asennushakemistosta tiedosto:

```
resources\.env.local
```

Oletuspolku (jos asensit oletuspolkuun):
```
C:\Program Files\SisuLead Miner\resources\.env.local
```

Täytä avaimet:
```
GEMINI_API_KEY=...
JINA_API_KEY=...
```

- **Gemini API key** — [Google AI Studio](https://aistudio.google.com/app/apikey) (ilmainen tier riittää alkuun)
- **Jina API key** — [jina.ai](https://jina.ai/) (ilmainen tier: 1 M tokenia)

### 4. Käynnistä

Etsi "SisuLead Miner" Käynnistä-valikosta tai työpöydältä.

Data tallentuu automaattisesti:
```
C:\Users\<käyttäjänimi>\AppData\Roaming\SisuLead Miner\sisulead.db
```

Loki virhetilanteissa:
```
C:\Users\<käyttäjänimi>\AppData\Roaming\SisuLead Miner\server.log
```

---

## Kehitysympäristö

**Vaatimukset:** Node.js 20+

```bash
git clone <repo-url>
cd sisuleads
npm install
# täytä .env.local (GEMINI_API_KEY, JINA_API_KEY)
npm run start    # käynnistää Vite :3000 + Express :3001
```

Avaa selain: `http://localhost:3000`

### Electron-kehitys

```bash
npm run electron:dev    # käynnistää Electron-ikkunan kehitysmoodissa
```

### Tuotantopaketointi

```bash
npm run dist    # luo release/SisuLead Miner Setup x.x.x.exe
```

Vaatii `.env.local` täytettynä ennen pakkausta — avaimet kopioituvat asennuspakettiin.

---

## Arkkitehtuuri

```
Electron main process
  └── fork() → Express + SQLite (CJS bundle, esbuild)
        ├── p-queue (concurrency=3)
        ├── Jina Reader API   (web scraping)
        ├── Gemini Flash API  (AI-ekstraktio + reititys)
        └── better-sqlite3    (paikallinen tietokanta)

React + Vite frontend (palvellaan Express:n kautta portissa 3001)
  └── SSE-yhteys reaaliaikaisiin päivityksiin
```

| Kerros | Teknologia |
|---|---|
| UI | React 19, Tailwind CSS 4, Lucide |
| Backend | Express 4, better-sqlite3 |
| AI | Gemini 2.0 Flash (`@google/genai`) |
| Scraping | Jina Reader API |
| Queue | p-queue (concurrency=3) |
| Paketointi | Electron 34, electron-builder (NSIS) |
| Build | Vite (frontend), esbuild (server) |

---

## Käyttö

1. **Luo kampanja** — anna nimi ja valitse kohdepersona (esim. Markkinointijohtaja + fallback CEO)
2. **Tuo liidit** — liitä lista domaineja tekstikenttään tai lataa CSV
3. **Käynnistä** — paina Start, seuraa etenemistä reaaliajassa
4. **Vie tulokset** — Export CSV → tuo HubSpotiin, Pipedriveen tai muuhun CRM:ään

Amber-korostuksella merkityt rivit = löytyi vain yleinen yrityssähköposti, ei henkilökohtainen päättäjä.
