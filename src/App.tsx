/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef } from 'react';
import { 
  Search, 
  Upload, 
  FileText, 
  Download, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  Globe, 
  Mail, 
  Phone, 
  User, 
  ExternalLink,
  Trash2,
  Play,
  MessageSquareQuote
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import Papa from 'papaparse';

// --- Types ---

interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

interface Lead {
  id: string;
  companyName: string;
  domain: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  comment: string;
  found: boolean;
  sourceUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  statusMessage?: string;
  logs: LogEntry[];
  error?: string;
}

interface ExtractionResult {
  name: string;
  title: string;
  email: string;
  phone: string;
  comment: string;
  found: boolean;
  sourceUrl?: string;
}

// --- Constants ---

const JINA_READER_URL = 'https://r.jina.ai/';

// --- Components ---

export default function App() {
  const [activeTab, setActiveTab] = useState<'single' | 'batch' | 'bulk'>('single');
  const [singleUrl, setSingleUrl] = useState('');
  const [singleCompanyName, setSingleCompanyName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize Gemini
  const getAi = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const addLog = (leadId: string, message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLeads(prev => prev.map(l => l.id === leadId ? { 
      ...l, 
      logs: [...l.logs, { timestamp, message, type }] 
    } : l));
  };

  const callGeminiWithRetry = async (leadId: string, taskName: string, apiCall: () => Promise<GenerateContentResponse>) => {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error: any) {
        // Check for 503 Service Unavailable or similar overloaded/busy errors
        const is503 = error.status === 503 || 
                      error.message?.includes('503') || 
                      error.message?.toLowerCase().includes('overloaded') ||
                      error.message?.toLowerCase().includes('busy');
        
        if (is503 && attempt < maxRetries) {
          const delay = (attempt + 1) * 3000; 
          addLog(leadId, `${taskName}: Gemini ruuhkautunut (503). Yritetään uudelleen (${attempt + 1}/${maxRetries}) ${delay}ms kuluttua...`, 'warning');
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  };

  const fetchWithJina = async (url: string, leadId: string, customHeaders: Record<string, string> = {}) => {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;
    addLog(leadId, `Yhdistetään Jina Readeriin: ${targetUrl}...`);
    
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      ...customHeaders
    };

    if (process.env.JINA_API_KEY) {
      addLog(leadId, `Käytetään Jina API-avainta.`, 'success');
      headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    }

    try {
      const response = await fetch(`${JINA_READER_URL}${targetUrl}`, { headers });
      if (!response.ok) {
        addLog(leadId, `Jina Reader virhe: ${response.status} ${response.statusText}`, 'error');
        throw new Error(`Jina Reader failed: ${response.statusText}`);
      }
      const text = await response.text();
      
      // Tarkistetaan onko kyseessä vale-onnistuminen (200 OK mutta sisältö on oikeasti 404-virhesivu)
      const lowerText = text.toLowerCase();
      const isShort = text.length < 1500;
      
      // Etsitään selkeitä virheilmoitus-fraaseja
      const has404Phrase = lowerText.includes('404 not found') || 
                           lowerText.includes('404 - sivua ei löytynyt') ||
                           lowerText.includes('sivua ei löytynyt') || 
                           lowerText.includes('page not found') ||
                           (isShort && lowerText.includes('404'));

      if (has404Phrase) {
        addLog(leadId, `Jina: Sivu tunnistettiin virhesivuksi (404-sisältö).`, 'warning');
        throw new Error('Page content is 404');
      }

      // ÄLYKÄS EVÄSTE-SUODATUS:
      // Jos teksti alkaa valtavalla evästeilmoituksella, hypätään sen yli.
      let processedText = text;
      const cookieMarkers = ["tämä sivusto käyttää evästeitä", "cookieconsent", "yksityiskohdat", "välttämätön"];
      if (cookieMarkers.some(m => lowerText.substring(0, 5000).includes(m))) {
        const consentEndIndex = lowerText.indexOf("tallenna valinnat");
        // Balkonserilla evästeet voivat viedä jopa 20k+ merkkiä
        if (consentEndIndex !== -1 && consentEndIndex < 30000) {
          addLog(leadId, `Jina: Suodatetaan evästeilmoitus pois (${consentEndIndex} merkkiä).`, 'info');
          processedText = text.substring(consentEndIndex + 20);
        }
      }

      addLog(leadId, `Jina: Vastaus vastaanotettu (${processedText.length} merkkiä).`, 'success');
      return processedText;
    } catch (error: any) {
      addLog(leadId, `Jina haku epäonnistui: ${error.message}`, 'error');
      throw error;
    }
  };

  const findBestContactUrl = async (content: string, domain: string, leadId: string): Promise<string | null> => {
    addLog(leadId, `Agentti (Reitittäjä): Etsitään todennäköisin yhteystietosivu linkeistä...`, 'info');
    
    // Otetaan vain sivun loppuosa, johon Jina lisää "Links/Images summary" -osion
    const textEnd = content.length > 15000 ? content.slice(-15000) : content;

    try {
      const response = await callGeminiWithRetry(leadId, 'Reitittäjä', () => {
        const ai = getAi();
        return ai.models.generateContent({
          model: "gemini-flash-latest",
          contents: `Tehtävä: Analysoi alla oleva verkkosivun loppuosa, joka sisältää tiivistelmän sivun linkeistä.
        
        Domain: ${domain}
        
        Etsi linkkien joukosta YKSI (1) URL, joka todennäköisimmin sisältää yrityksen päättäjien yhteystiedot tai henkilöstön. 
        Priorisoi sivuja kuten: /yhteystiedot, /tiimi, /meista, /contact, /about.
        
        PALAUTA VAIN JA AINOASTAAN URL-OSOITE tekstinä. Jos sopivaa linkkiä ei löydy, palauta teksti: EI_LOYTYNYT.
        Varmista, että palauttamasi URL alkaa "http", täydennä se tarvittaessa domainilla.
        
        Teksti (jossa linkkilista):
        ${textEnd}`,
          config: {
            temperature: 0.1 // Pidetään hallusinaatioriski minimissä
          }
        });
      });

      const resultUrl = (response?.text || '').trim();
      
      if (resultUrl === 'EI_LOYTYNYT' || !resultUrl.startsWith('http')) {
        addLog(leadId, `Agentti (Reitittäjä): Sopivaa alasivua ei löytynyt etusivun linkeistä.`, 'warning');
        return null;
      }

      addLog(leadId, `Agentti (Reitittäjä): Valitsi parhaaksi alasivuksi: ${resultUrl}`, 'success');
      return resultUrl;
      
    } catch (error: any) {
      addLog(leadId, `Agentti (Reitittäjä) epäonnistui: ${error.message}`, 'error');
      return null;
    }
  };

  const extractLead = async (content: string, companyName: string, leadId: string): Promise<ExtractionResult> => {
    addLog(leadId, `Gemini: Poimitaan tiedot (tiukka tekstianalyysi)...`);
    
    // Gemini 1.5 Flash kestää suuria määriä, mutta optimoidaan silti.
    // Otetaan 50k alusta ja 50k lopusta, jos teksti on valtava.
    const maxChars = 100000;
    let analysisText = content;
    if (content.length > maxChars) {
      addLog(leadId, `Teksti on erittäin laaja (${content.length} merkkiä), optimoidaan analyysia...`, 'info');
      analysisText = content.substring(0, maxChars / 2) + 
                     "\n\n... [TEKSTIÄ KATKAISTU VÄLISTÄ] ...\n\n" + 
                     content.substring(content.length - maxChars / 2);
    }

    try {
      const response = await callGeminiWithRetry(leadId, 'Analyysi', () => {
        const ai = getAi();
        return ai.models.generateContent({
          model: "gemini-flash-latest",
          contents: `Tehtävä: Poimi yrityksen markkinointipäättäjän tai johdon yhteystiedot ANNETUSTA TEKSTISTÄ.
        
        TÄRKEÄÄ: 
        1. Käytä VAIN alla olevaa tekstiä. ÄLÄ käytä aiempaa tietoasi tai arvaa tietoja.
        2. Jos tietoa ei löydy tekstistä, aseta 'found': false.
        3. Älä hallusinoi sähköpostiosoitteita, jos niitä ei ole mainittu. Ainoa poikkeus on Jos sivulla selvästi ilmoitetaan sähköpostien olevan standardimuotoa esim etunimi.sukunimi voit rakentaa tuon osoitteen.
        
        Yritys: ${companyName}
        
        Tekstisisältö:
        ${analysisText}`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                title: { type: Type.STRING },
                email: { type: Type.STRING },
                phone: { type: Type.STRING },
                comment: { type: Type.STRING, description: "Perustelu valinnalle. Kerro myös jos tietoa ei löytynyt." },
                found: { type: Type.BOOLEAN }
              },
              required: ["name", "title", "email", "phone", "comment", "found"]
            }
          }
        });
      });

      const result = JSON.parse(response?.text || '{}') as ExtractionResult;
      if (result.found) {
        addLog(leadId, `Gemini: Löydettiin päättäjä: ${result.name}`, 'success');
      } else {
        addLog(leadId, `Gemini: Tietoja ei löytynyt tästä tekstiosasta.`, 'warning');
      }
      return result;
    } catch (error: any) {
      addLog(leadId, `Gemini: Analyysi epäonnistui: ${error.message}`, 'error');
      return { name: '', title: '', email: '', phone: '', comment: `Analysis failed: ${error.message}`, found: false };
    }
  };

  const processLead = async (lead: Lead) => {
    const updateStatus = (msg: string, status: Lead['status'] = 'processing') => {
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status, statusMessage: msg } : l));
    };

    addLog(lead.id, `Agentti käynnistetty: Aloitetaan kohteen ${lead.companyName} analyysi (Täsmäisku-strategia).`, 'info');
    
    try {
      // --- VAIHE 1: Etusivu ja Linkkilista ---
      updateStatus('Tarkistetaan etusivu...');
      // Pyydetään Jinaa lisäämään linkkilista sivun loppuun
      const homeContent = await fetchWithJina(lead.domain, lead.id, { 'X-With-links-Summary': 'true' });
      
      const homeResult = await extractLead(homeContent, lead.companyName, lead.id);
      
      if (homeResult.found) {
        const fullHomeUrl = lead.domain.startsWith('http') ? lead.domain : `https://${lead.domain}`;
        addLog(lead.id, `LÖYTYI: Tiedot löytyivät suoraan etusivulta.`, 'success');
        setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, ...homeResult, sourceUrl: fullHomeUrl, status: 'completed', statusMessage: 'Valmis' } : l));
        return;
      }

      // --- VAIHE 2: Valitaan paras alasivu Reitittäjän avulla ---
      updateStatus('Reititetään alasivulle...');
      const targetUrl = await findBestContactUrl(homeContent, lead.domain, lead.id);

      if (!targetUrl) {
        // Luovutetaan, jos Gemini ei keksi mihin mennä
        addLog(lead.id, `Agentti lopetti työn. Ei selkeää yhteystietosivua.`, 'warning');
        setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: 'completed', statusMessage: 'Ei löytynyt' } : l));
        return;
      }

      // --- VAIHE 3: Haetaan ainoastaan valittu alasivu ---
      updateStatus(`Haetaan alasivu: ${new URL(targetUrl).pathname}...`);
      const subContent = await fetchWithJina(targetUrl, lead.id);
      const subResult = await extractLead(subContent, lead.companyName, lead.id);

      const finalUrl = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;

      setLeads(prev => prev.map(l => l.id === lead.id ? { 
        ...l, 
        ...subResult, 
        sourceUrl: subResult.found ? finalUrl : l.sourceUrl,
        status: 'completed',
        statusMessage: subResult.found ? 'Valmis' : 'Ei löytynyt'
      } : l));
      
      addLog(lead.id, `Agentti lopetti työn. Lopputulos: ${subResult.found ? 'Yhteystiedot poimittu' : 'Tietoja ei löytynyt'}`, subResult.found ? 'success' : 'warning');

    } catch (error: any) {
      addLog(lead.id, `Agentti keskeytti työn virheen vuoksi: ${error.message}`, 'error');
      setLeads(prev => prev.map(l => l.id === lead.id ? { 
        ...l, 
        status: 'error', 
        statusMessage: 'Virhe',
        error: error.message || 'Unknown error' 
      } : l));
    }
  };

  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleUrl) return;

    const newLead: Lead = {
      id: Math.random().toString(36).substr(2, 9),
      companyName: singleCompanyName || singleUrl,
      domain: singleUrl,
      name: '',
      title: '',
      email: '',
      phone: '',
      comment: '',
      found: false,
      status: 'pending',
      logs: []
    };

    setLeads(prev => [newLead, ...prev]);
    setSingleUrl('');
    setSingleCompanyName('');
    await processLead(newLead);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const newLeads: Lead[] = results.data.map((row: any) => ({
          id: Math.random().toString(36).substr(2, 9),
          companyName: row.company_name || row.yritys || row.Name || '',
          domain: row.domain || row.verkkosivu || row.URL || '',
          name: '',
          title: '',
          email: '',
          phone: '',
          comment: '',
          found: false,
          status: 'pending',
          logs: []
        })).filter(l => l.domain);

        setLeads(prev => [...newLeads, ...prev]);
      }
    });
  };

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkText.trim()) return;

    const domains = bulkText
      .split('\n')
      .map(d => d.trim())
      .filter(d => d.length > 0);

    if (domains.length === 0) return;

    const newLeads: Lead[] = domains.map(domain => ({
      id: Math.random().toString(36).substr(2, 9),
      companyName: domain,
      domain: domain,
      name: '',
      title: '',
      email: '',
      phone: '',
      comment: '',
      found: false,
      status: 'pending',
      logs: []
    }));

    setLeads(prev => [...newLeads, ...prev]);
    setBulkText('');
    
    // Start processing them
    for (const lead of newLeads) {
      await processLead(lead);
    }
  };

  const runBatch = async () => {
    const pendingLeads = leads.filter(l => l.status === 'pending');
    if (pendingLeads.length === 0) return;

    setIsProcessing(true);
    // Process in sequence to avoid rate limits, or small batches
    for (const lead of pendingLeads) {
      await processLead(lead);
    }
    setIsProcessing(false);
  };

  const exportCsv = () => {
    const exportData = leads.map(({ companyName, domain, name, title, email, phone, comment, found, sourceUrl }) => ({
      Yritys: companyName,
      Verkkosivu: domain,
      Nimi: name,
      Titteli: title,
      Sähköposti: email,
      Puhelin: phone,
      Kommentti: comment,
      Lähde: sourceUrl || '',
      Löytyi: found ? 'Kyllä' : 'Ei'
    }));

    const csv = Papa.unparse(exportData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `sisulead_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearLeads = () => {
    if (confirm('Haluatko varmasti tyhjentää kaikki tulokset?')) {
      setLeads([]);
    }
  };

  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showReasoningId, setShowReasoningId] = useState<string | null>(null);
  const selectedLead = leads.find(l => l.id === selectedLeadId);
  const reasoningLead = leads.find(l => l.id === showReasoningId);

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Reasoning Overlay */}
      <AnimatePresence>
        {reasoningLead && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowReasoningId(null)}
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-[#141414]"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-[#141414] flex justify-between items-center bg-[#F9F9F8]">
                <div className="flex items-center gap-3">
                  <div className="bg-[#141414] text-white p-2 rounded-lg">
                    <MessageSquareQuote size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest">Poiminnan perustelut</h3>
                    <p className="text-[10px] opacity-50 font-mono mt-1">{reasoningLead.companyName}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowReasoningId(null)}
                  className="p-2 hover:bg-black/5 rounded-full transition-colors"
                >
                  <Trash2 size={18} className="rotate-45" />
                </button>
              </div>
              
              <div className="p-8 text-sm leading-relaxed text-[#141414] italic">
                "{reasoningLead.comment || 'Ei lisätietoja saatavilla.'}"
              </div>
              
              <div className="p-4 bg-[#F9F9F8] border-t border-[#141414]/10 flex justify-end">
                <button 
                  onClick={() => setShowReasoningId(null)}
                  className="px-6 py-2 bg-[#141414] text-white rounded-lg text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity"
                >
                  Sulje
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Log Console Overlay */}
      <AnimatePresence>
        {selectedLead && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setSelectedLeadId(null)}
          >
            <motion.div 
              initial={{ x: 400 }}
              animate={{ x: 0 }}
              exit={{ x: 400 }}
              className="w-full max-w-md h-full bg-[#141414] text-[#E4E3E0] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-white/10"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-white/10 flex justify-between items-center bg-white/5">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest">Developer Console</h3>
                  <p className="text-[10px] opacity-50 font-mono mt-1">{selectedLead.companyName}</p>
                </div>
                <button 
                  onClick={() => setSelectedLeadId(null)}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <Trash2 size={18} className="rotate-45" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] space-y-3">
                {selectedLead.logs.length === 0 && (
                  <div className="opacity-30 italic">Odotetaan tapahtumia...</div>
                )}
                {selectedLead.logs.map((log, i) => (
                  <div key={i} className="flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300">
                    <span className="opacity-30 shrink-0">[{log.timestamp}]</span>
                    <span className={`
                      ${log.type === 'success' ? 'text-emerald-400' : ''}
                      ${log.type === 'error' ? 'text-red-400' : ''}
                      ${log.type === 'warning' ? 'text-amber-400' : ''}
                      ${log.type === 'info' ? 'text-blue-300' : ''}
                    `}>
                      {log.message}
                    </span>
                  </div>
                ))}
                <div id="log-end" />
              </div>
              
              <div className="p-4 bg-white/5 border-t border-white/10 text-[9px] uppercase tracking-widest opacity-40 text-center">
                Live Process Monitoring Active
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-white/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-[#141414] text-[#E4E3E0] p-2 rounded-lg">
            <Search size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase">SisuLead Miner</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-50 font-mono">Finnish B2B Lead Extraction v1.0</p>
          </div>
        </div>
        <div className="flex gap-4">
          {leads.length > 0 && (
            <>
              <button 
                onClick={exportCsv}
                className="flex items-center gap-2 px-4 py-2 border border-[#141414] rounded-md hover:bg-[#141414] hover:text-[#E4E3E0] transition-all text-xs font-medium uppercase tracking-wider"
              >
                <Download size={14} />
                Export CSV
              </button>
              <button 
                onClick={clearLeads}
                className="flex items-center gap-2 px-4 py-2 border border-red-200 text-red-600 rounded-md hover:bg-red-50 transition-all text-xs font-medium uppercase tracking-wider"
              >
                <Trash2 size={14} />
                Clear
              </button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Controls Column */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-white border border-[#141414] rounded-xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="flex border-b border-[#141414]">
              <button 
                onClick={() => setActiveTab('single')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-widest transition-colors ${activeTab === 'single' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-black/5'}`}
              >
                Single URL
              </button>
              <button 
                onClick={() => setActiveTab('batch')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-widest transition-colors ${activeTab === 'batch' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-black/5'}`}
              >
                Batch (CSV)
              </button>
              <button 
                onClick={() => setActiveTab('bulk')}
                className={`flex-1 py-3 text-xs font-bold uppercase tracking-widest transition-colors ${activeTab === 'bulk' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-black/5'}`}
              >
                Bulk Text
              </button>
            </div>

            <div className="p-6">
              {activeTab === 'single' ? (
                <form onSubmit={handleSingleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Company Name (Optional)</label>
                    <input 
                      type="text" 
                      value={singleCompanyName}
                      onChange={(e) => setSingleCompanyName(e.target.value)}
                      placeholder="Esim. Sisu Oy"
                      className="w-full px-4 py-2 border border-[#141414] rounded-md focus:outline-none focus:ring-2 focus:ring-[#141414]/10 bg-[#F9F9F8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Domain / URL</label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 opacity-30" size={16} />
                      <input 
                        type="text" 
                        required
                        value={singleUrl}
                        onChange={(e) => setSingleUrl(e.target.value)}
                        placeholder="sisu.fi"
                        className="w-full pl-10 pr-4 py-2 border border-[#141414] rounded-md focus:outline-none focus:ring-2 focus:ring-[#141414]/10 bg-[#F9F9F8]"
                      />
                    </div>
                  </div>
                  <button 
                    type="submit"
                    disabled={isProcessing}
                    className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs hover:bg-[#141414]/90 transition-all flex items-center justify-center gap-2"
                  >
                    {isProcessing ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
                    Start Extraction
                  </button>
                </form>
              ) : activeTab === 'bulk' ? (
                <form onSubmit={handleBulkSubmit} className="space-y-4">
                  <div>
                    <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Paste Domains (one per line)</label>
                    <textarea 
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      placeholder="www.kaivo.fi&#10;www.vesivek.fi&#10;vhapipetechnology.fi"
                      rows={8}
                      className="w-full px-4 py-3 border border-[#141414] rounded-md focus:outline-none focus:ring-2 focus:ring-[#141414]/10 bg-[#F9F9F8] text-sm font-mono"
                    />
                  </div>
                  <button 
                    type="submit"
                    disabled={isProcessing}
                    className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs hover:bg-[#141414]/90 transition-all flex items-center justify-center gap-2"
                  >
                    {isProcessing ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
                    Start Bulk Extraction
                  </button>
                </form>
              ) : (
                <div className="space-y-6">
                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-[#141414]/20 rounded-xl p-8 text-center cursor-pointer hover:border-[#141414]/40 hover:bg-black/5 transition-all group"
                  >
                    <input 
                      type="file" 
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      accept=".csv"
                      className="hidden"
                    />
                    <Upload className="mx-auto mb-4 opacity-30 group-hover:opacity-60 transition-opacity" size={32} />
                    <p className="text-sm font-medium mb-1">Click to upload CSV</p>
                    <p className="text-[10px] uppercase opacity-40">Columns: company_name, domain</p>
                  </div>

                  {leads.filter(l => l.status === 'pending').length > 0 && (
                    <button 
                      onClick={runBatch}
                      disabled={isProcessing}
                      className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs hover:bg-[#141414]/90 transition-all flex items-center justify-center gap-2"
                    >
                      {isProcessing ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
                      Process {leads.filter(l => l.status === 'pending').length} Leads
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="bg-[#141414] text-[#E4E3E0] p-6 rounded-xl shadow-[4px_4px_0px_0px_rgba(255,255,255,0.1)]">
            <h3 className="text-xs font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
              <AlertCircle size={14} />
              Extraction Logic
            </h3>
            <ul className="text-[11px] space-y-3 opacity-80 font-mono">
              <li className="flex gap-2">
                <span className="text-emerald-400">01</span>
                <span>Prioritizes Marketing Directors & Managers</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">02</span>
                <span>Fallback to CEO / Entrepreneur / Owner</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">03</span>
                <span>Scans homepage + 2 relevant subpages</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">04</span>
                <span>Cleans email obfuscation ([at], etc.)</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Results Column */}
        <div className="lg:col-span-8">
          <div className="bg-white border border-[#141414] rounded-xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="p-4 border-b border-[#141414] flex justify-between items-center bg-[#F9F9F8]">
              <h2 className="text-xs font-bold uppercase tracking-widest">Extraction Results</h2>
              <span className="text-[10px] font-mono bg-[#141414] text-[#E4E3E0] px-2 py-0.5 rounded">
                {leads.length} Total
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F9F9F8] border-b border-[#141414]">
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Company</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Lead / Title</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Contact</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#141414]/10">
                  <AnimatePresence initial={false}>
                    {leads.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-12 text-center opacity-30 italic text-sm">
                          No leads processed yet. Start by adding a URL or uploading a CSV.
                        </td>
                      </tr>
                    ) : (
                      leads.map((lead) => (
                        <motion.tr 
                          key={lead.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="hover:bg-black/[0.02] transition-colors group"
                        >
                          <td className="p-4">
                            <div className="font-bold text-sm">{lead.companyName}</div>
                            <div className="text-[10px] font-mono opacity-50 flex items-center gap-1 mt-1">
                              <Globe size={10} />
                              {lead.domain}
                            </div>
                          </td>
                          <td className="p-4">
                            {lead.status === 'completed' && lead.found ? (
                              <>
                                <div className="font-bold text-sm flex items-center gap-1.5">
                                  <User size={12} className="opacity-40" />
                                  {lead.name}
                                </div>
                                <div className="text-[10px] uppercase tracking-wider font-medium opacity-60 mt-0.5">{lead.title}</div>
                                {lead.sourceUrl && (
                                  <a 
                                    href={lead.sourceUrl} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="text-[9px] text-blue-600 hover:underline flex items-center gap-1 mt-1 opacity-70"
                                  >
                                    <ExternalLink size={10} />
                                    Lähde: {lead.sourceUrl.replace(/^https?:\/\/(www\.)?/, '')}
                                  </a>
                                )}
                                {lead.status === 'completed' && lead.comment && (
                                  <button 
                                    onClick={() => setShowReasoningId(lead.id)}
                                    className="mt-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-tighter text-amber-600 hover:text-amber-700 transition-colors bg-amber-50 px-2 py-1 rounded border border-amber-200/50"
                                  >
                                    <MessageSquareQuote size={10} />
                                    Katso perustelut
                                  </button>
                                )}
                              </>
                            ) : lead.status === 'completed' ? (
                              <span className="text-[10px] uppercase font-bold text-red-500/70">Not Found</span>
                            ) : (
                              <div className="h-4 w-24 bg-black/5 animate-pulse rounded" />
                            )}
                          </td>
                          <td className="p-4">
                            {lead.status === 'completed' && lead.found ? (
                              <div className="space-y-1">
                                {lead.email && (
                                  <div className="text-[11px] font-mono flex items-center gap-1.5 group-hover:text-emerald-600 transition-colors">
                                    <Mail size={10} />
                                    {lead.email}
                                  </div>
                                )}
                                {lead.phone && (
                                  <div className="text-[11px] font-mono flex items-center gap-1.5 opacity-60">
                                    <Phone size={10} />
                                    {lead.phone}
                                  </div>
                                )}
                              </div>
                            ) : lead.status === 'completed' ? (
                              <span className="text-[10px] opacity-30 italic">—</span>
                            ) : (
                              <div className="space-y-1">
                                <div className="h-3 w-32 bg-black/5 animate-pulse rounded" />
                                <div className="h-3 w-20 bg-black/5 animate-pulse rounded" />
                              </div>
                            )}
                          </td>
                          <td className="p-4">
                            <div className="flex items-center justify-between group/row">
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[#141414]">
                                  {lead.status === 'processing' && <Loader2 size={12} className="animate-spin" />}
                                  {lead.status === 'completed' && <CheckCircle2 size={12} className="text-emerald-600" />}
                                  {lead.status === 'error' && <AlertCircle size={12} className="text-red-500" />}
                                  {lead.status === 'pending' && <div className="w-3 h-3 border border-[#141414]/20 rounded-full" />}
                                  {lead.status === 'processing' ? 'Käsitellään...' : lead.status === 'completed' ? 'Valmis' : lead.status === 'error' ? 'Virhe' : 'Jonossa'}
                                </div>
                                <div className="text-[9px] font-mono opacity-50 truncate max-w-[120px]">
                                  {lead.statusMessage || (lead.status === 'pending' ? 'Odottaa vuoroaan' : '')}
                                </div>
                              </div>
                              
                              <button 
                                onClick={() => setSelectedLeadId(lead.id)}
                                className="p-2 hover:bg-[#141414] hover:text-[#E4E3E0] rounded-md transition-all opacity-0 group-hover/row:opacity-100"
                                title="Avaa konsoli"
                              >
                                <FileText size={14} />
                              </button>
                            </div>
                          </td>
                        </motion.tr>
                      ))
                    )}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>

          {/* Comment Section (Selected Lead Detail) */}
          <AnimatePresence>
            {leads.some(l => l.status === 'completed' && l.comment) && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-8 p-6 bg-white border border-[#141414] rounded-xl shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]"
              >
                <h3 className="text-[10px] uppercase font-bold tracking-widest mb-4 opacity-50 flex items-center gap-2">
                  <FileText size={14} />
                  Latest Extraction Insights
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {leads
                    .filter(l => l.status === 'completed' && l.comment)
                    .slice(0, 2)
                    .map(lead => (
                      <div key={`insight-${lead.id}`} className="border-l-2 border-[#141414] pl-4 py-1">
                        <div className="text-xs font-bold mb-1">{lead.companyName}</div>
                        <p className="text-[11px] italic opacity-70 leading-relaxed">
                          "{lead.comment}"
                        </p>
                      </div>
                    ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto p-12 text-center">
        <div className="h-px bg-[#141414]/10 mb-8" />
        <p className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-30">
          Built for Finnish Growth & Visibility • Powered by Gemini AI
        </p>
      </footer>
    </div>
  );
}
