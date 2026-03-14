import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Search, Upload, FileText, Download, Loader2, CheckCircle2,
  AlertCircle, Globe, Mail, Phone, User, ExternalLink, Trash2,
  Play, MessageSquareQuote, Square, Plus, ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Papa from 'papaparse';
import type { Campaign, Lead, LogEntry, QueueStatus, SSEEvent, PersonaConfig, PersonaRole } from './shared/types.js';
import { PERSONA_ROLES } from './shared/types.js';

// --- API helpers ---

const api = {
  async getCampaigns(): Promise<Campaign[]> {
    const r = await fetch('/api/campaigns');
    return r.json();
  },
  async createCampaign(name: string, personaConfig: any): Promise<Campaign> {
    const r = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, personaConfig }),
    });
    return r.json();
  },
  async deleteCampaign(id: string) {
    await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
  },
  async getLeads(campaignId: string): Promise<Lead[]> {
    const r = await fetch(`/api/leads?campaignId=${campaignId}`);
    return r.json();
  },
  async getLead(id: string): Promise<Lead & { logs: LogEntry[] }> {
    const r = await fetch(`/api/leads/${id}`);
    return r.json();
  },
  async importLeads(campaignId: string, leads: { companyName: string; domain: string }[]) {
    const r = await fetch('/api/leads/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, leads }),
    });
    return r.json();
  },
  async deleteLead(id: string) {
    await fetch(`/api/leads/${id}`, { method: 'DELETE' });
  },
  async startJobs(campaignId: string) {
    const r = await fetch('/api/jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId }),
    });
    return r.json();
  },
  async stopJobs() {
    await fetch('/api/jobs/stop', { method: 'POST' });
  },
  exportCsvUrl(campaignId: string) {
    return `/api/leads/export/csv?campaignId=${campaignId}`;
  },
};

// --- App ---

export default function App() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadLogs, setLeadLogs] = useState<Record<string, LogEntry[]>>({});
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({ pending: 0, processing: 0, completed: 0, error: 0, isRunning: false });

  const [activeTab, setActiveTab] = useState<'single' | 'batch' | 'bulk'>('single');
  const [singleUrl, setSingleUrl] = useState('');
  const [singleCompanyName, setSingleCompanyName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showReasoningId, setShowReasoningId] = useState<string | null>(null);
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [showCampaignDropdown, setShowCampaignDropdown] = useState(false);
  const [primaryRole, setPrimaryRole] = useState<PersonaRole>('marketing');
  const [fallbackRole, setFallbackRole] = useState<PersonaRole | null>(null);
  const [acceptAnyContact, setAcceptAnyContact] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeCampaign = campaigns.find(c => c.id === activeCampaignId);

  // Load campaigns on mount
  useEffect(() => {
    api.getCampaigns().then(data => {
      setCampaigns(data);
      if (data.length > 0) setActiveCampaignId(data[0].id);
    });
  }, []);

  // Load leads when campaign changes
  useEffect(() => {
    if (!activeCampaignId) { setLeads([]); return; }
    api.getLeads(activeCampaignId).then(setLeads);
  }, [activeCampaignId]);

  // SSE subscription for real-time updates
  useEffect(() => {
    const es = new EventSource('/api/events');

    es.onmessage = (e) => {
      const event = JSON.parse(e.data) as SSEEvent;

      if (event.type === 'lead.updated') {
        const updated = event.payload;
        setLeads(prev => {
          const exists = prev.some(l => l.id === updated.id);
          if (!exists) return prev;
          return prev.map(l => l.id === updated.id ? { ...l, ...updated } : l);
        });
      }

      if (event.type === 'lead.log') {
        const { leadId, log } = event.payload;
        setLeadLogs(prev => ({
          ...prev,
          [leadId]: [...(prev[leadId] || []), log],
        }));
      }

      if (event.type === 'queue.status') {
        setQueueStatus(event.payload);
      }
    };

    es.onerror = () => {
      // SSE will auto-reconnect
    };

    return () => es.close();
  }, []);

  const createCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCampaignName.trim()) return;
    const created = await api.createCampaign(newCampaignName.trim(), { primaryRole, fallbackRole, acceptAnyContact });
    setCampaigns(prev => [created, ...prev]);
    setActiveCampaignId(created.id);
    setNewCampaignName('');
    setShowNewCampaign(false);
  };

  const importAndStart = async (leads: { companyName: string; domain: string }[]) => {
    if (!activeCampaignId) return;
    const result = await api.importLeads(activeCampaignId, leads);
    if (result.created > 0) {
      const refreshed = await api.getLeads(activeCampaignId);
      setLeads(refreshed);
      await api.startJobs(activeCampaignId);
    }
  };

  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleUrl || !activeCampaignId) return;
    await importAndStart([{ companyName: singleCompanyName || singleUrl, domain: singleUrl }]);
    setSingleUrl('');
    setSingleCompanyName('');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeCampaignId) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const items = (results.data as any[])
          .map(row => ({
            companyName: row.company_name || row.yritys || row.Name || '',
            domain: row.domain || row.verkkosivu || row.URL || '',
          }))
          .filter(l => l.domain);

        if (items.length > 0) await importAndStart(items);
      },
    });
    e.target.value = '';
  };

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkText.trim() || !activeCampaignId) return;

    const items = bulkText
      .split('\n')
      .map(d => d.trim())
      .filter(d => d.length > 0)
      .map(domain => ({ companyName: domain, domain }));

    if (items.length === 0) return;
    await importAndStart(items);
    setBulkText('');
  };

  const runPending = async () => {
    if (!activeCampaignId) return;
    await api.startJobs(activeCampaignId);
  };

  const stopProcessing = async () => {
    await api.stopJobs();
  };

  const selectedLead = leads.find(l => l.id === selectedLeadId);
  const reasoningLead = leads.find(l => l.id === showReasoningId);
  const pendingCount = leads.filter(l => l.status === 'pending' || l.status === 'queued').length;
  const isRunning = queueStatus.isRunning;

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">

      {/* Reasoning Overlay */}
      <AnimatePresence>
        {reasoningLead && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowReasoningId(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-[#141414]"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-[#141414] flex justify-between items-center bg-[#F9F9F8]">
                <div className="flex items-center gap-3">
                  <div className="bg-[#141414] text-white p-2 rounded-lg"><MessageSquareQuote size={18} /></div>
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest">Poiminnan perustelut</h3>
                    <p className="text-[10px] opacity-50 font-mono mt-1">{reasoningLead.companyName}</p>
                  </div>
                </div>
                <button onClick={() => setShowReasoningId(null)} className="p-2 hover:bg-black/5 rounded-full">
                  <Trash2 size={18} className="rotate-45" />
                </button>
              </div>
              <div className="p-8 text-sm leading-relaxed italic">
                "{reasoningLead.extractionComment || 'Ei lisätietoja.'}"
              </div>
              <div className="p-4 bg-[#F9F9F8] border-t border-[#141414]/10 flex justify-end">
                <button onClick={() => setShowReasoningId(null)}
                  className="px-6 py-2 bg-[#141414] text-white rounded-lg text-xs font-bold uppercase tracking-widest">
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
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setSelectedLeadId(null)}
          >
            <motion.div
              initial={{ x: 400 }} animate={{ x: 0 }} exit={{ x: 400 }}
              className="w-full max-w-md h-full bg-[#141414] text-[#E4E3E0] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-white/10"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-white/10 flex justify-between items-center bg-white/5">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest">Developer Console</h3>
                  <p className="text-[10px] opacity-50 font-mono mt-1">{selectedLead.companyName}</p>
                </div>
                <button onClick={() => setSelectedLeadId(null)} className="p-2 hover:bg-white/10 rounded-full">
                  <Trash2 size={18} className="rotate-45" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] space-y-3">
                {(leadLogs[selectedLead.id] || []).length === 0 && (
                  <div className="opacity-30 italic">Odotetaan tapahtumia...</div>
                )}
                {(leadLogs[selectedLead.id] || []).map((log, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="opacity-30 shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className={
                      log.level === 'success' ? 'text-emerald-400' :
                      log.level === 'error' ? 'text-red-400' :
                      log.level === 'warning' ? 'text-amber-400' : 'text-blue-300'
                    }>{log.message}</span>
                  </div>
                ))}
              </div>
              <div className="p-4 bg-white/5 border-t border-white/10 text-[9px] uppercase tracking-widest opacity-40 text-center">
                Live Process Monitoring
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="border-b border-[#141414] p-4 flex justify-between items-center bg-white/50 backdrop-blur-sm sticky top-0 z-10 gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <div className="bg-[#141414] text-[#E4E3E0] p-2 rounded-lg"><Search size={20} /></div>
          <div>
            <h1 className="text-lg font-bold tracking-tight uppercase">SisuLead Miner</h1>
            <p className="text-[9px] uppercase tracking-widest opacity-50 font-mono">Finnish B2B Lead Extraction</p>
          </div>
        </div>

        {/* Campaign selector */}
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <div className="relative flex-1">
            <button
              onClick={() => setShowCampaignDropdown(v => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-[#141414] rounded-md text-xs font-medium bg-white hover:bg-black/5 transition-colors"
            >
              <span className="truncate">{activeCampaign?.name || 'Valitse kampanja'}</span>
              <ChevronDown size={12} className="shrink-0" />
            </button>
            {showCampaignDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#141414] rounded-md shadow-lg z-20 overflow-hidden">
                {campaigns.map(c => (
                  <button
                    key={c.id}
                    onClick={() => { setActiveCampaignId(c.id); setShowCampaignDropdown(false); }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-black/5 transition-colors ${c.id === activeCampaignId ? 'font-bold bg-black/5' : ''}`}
                  >
                    {c.name}
                    <span className="ml-2 opacity-40 font-normal">{(c.totalLeads || 0)} liidiä</span>
                  </button>
                ))}
                {campaigns.length === 0 && (
                  <div className="px-3 py-2 text-xs opacity-40 italic">Ei kampanjoita</div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setShowNewCampaign(v => !v)}
            className="p-2 border border-[#141414] rounded-md hover:bg-[#141414] hover:text-[#E4E3E0] transition-colors"
            title="Uusi kampanja"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="flex gap-2 shrink-0">
          {activeCampaignId && leads.length > 0 && (
            <a
              href={api.exportCsvUrl(activeCampaignId)}
              download
              className="flex items-center gap-2 px-3 py-2 border border-[#141414] rounded-md hover:bg-[#141414] hover:text-[#E4E3E0] transition-all text-xs font-medium uppercase tracking-wider"
            >
              <Download size={13} />
              Export CSV
            </a>
          )}
        </div>
      </header>

      {/* New campaign form */}
      <AnimatePresence>
        {showNewCampaign && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-b border-[#141414] overflow-hidden"
          >
            <form onSubmit={createCampaign} className="max-w-7xl mx-auto px-6 py-4 space-y-3">
              <div className="flex gap-3 items-center">
                <input
                  autoFocus
                  type="text"
                  value={newCampaignName}
                  onChange={e => setNewCampaignName(e.target.value)}
                  placeholder="Kampanjan nimi, esim. IT-yritykset Tampere Q2"
                  className="flex-1 px-3 py-2 border border-[#141414] rounded-md text-sm focus:outline-none bg-white"
                />
                <button type="submit" className="px-4 py-2 bg-[#141414] text-white rounded-md text-xs font-bold uppercase tracking-wider shrink-0">
                  Luo
                </button>
                <button type="button" onClick={() => setShowNewCampaign(false)} className="px-3 py-2 border border-[#141414] rounded-md text-xs shrink-0">
                  Peruuta
                </button>
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase font-bold opacity-50 shrink-0">Ensisijainen rooli</label>
                  <select
                    value={primaryRole}
                    onChange={e => setPrimaryRole(e.target.value as PersonaRole)}
                    className="px-2 py-1.5 border border-[#141414] rounded-md text-xs bg-white focus:outline-none"
                  >
                    {PERSONA_ROLES.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase font-bold opacity-50 shrink-0">Varavalinta</label>
                  <select
                    value={fallbackRole ?? ''}
                    onChange={e => setFallbackRole(e.target.value ? e.target.value as PersonaRole : null)}
                    className="px-2 py-1.5 border border-[#141414] rounded-md text-xs bg-white focus:outline-none"
                  >
                    <option value="">(Ei varavalintaa)</option>
                    {PERSONA_ROLES.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={acceptAnyContact}
                    onChange={e => setAcceptAnyContact(e.target.checked)}
                    className="rounded border-[#141414]"
                  />
                  <span className="opacity-60">Hyväksy kuka tahansa nimetty (viim. vaihtoehto)</span>
                </label>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Controls Column */}
        <div className="lg:col-span-4 space-y-6">
          {!activeCampaignId ? (
            <div className="bg-white border border-[#141414] rounded-xl p-8 text-center shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
              <p className="text-sm font-medium mb-4 opacity-60">Luo ensin kampanja aloittaaksesi</p>
              <button
                onClick={() => setShowNewCampaign(true)}
                className="flex items-center gap-2 mx-auto px-4 py-2 bg-[#141414] text-white rounded-md text-xs font-bold uppercase tracking-widest"
              >
                <Plus size={14} /> Uusi kampanja
              </button>
            </div>
          ) : (
            <div className="bg-white border border-[#141414] rounded-xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
              <div className="flex border-b border-[#141414]">
                {(['single', 'batch', 'bulk'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-widest transition-colors ${activeTab === tab ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-black/5'}`}
                  >
                    {tab === 'single' ? 'Yksittäinen' : tab === 'batch' ? 'CSV' : 'Bulk'}
                  </button>
                ))}
              </div>

              <div className="p-6">
                {activeTab === 'single' && (
                  <form onSubmit={handleSingleSubmit} className="space-y-4">
                    <div>
                      <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Yrityksen nimi (vapaaehtoinen)</label>
                      <input type="text" value={singleCompanyName} onChange={e => setSingleCompanyName(e.target.value)}
                        placeholder="Esim. Sisu Oy"
                        className="w-full px-4 py-2 border border-[#141414] rounded-md focus:outline-none bg-[#F9F9F8] text-sm" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Domain / URL</label>
                      <div className="relative">
                        <Globe className="absolute left-3 top-1/2 -translate-y-1/2 opacity-30" size={14} />
                        <input type="text" required value={singleUrl} onChange={e => setSingleUrl(e.target.value)}
                          placeholder="sisu.fi"
                          className="w-full pl-9 pr-4 py-2 border border-[#141414] rounded-md focus:outline-none bg-[#F9F9F8] text-sm" />
                      </div>
                    </div>
                    <button type="submit" disabled={isRunning}
                      className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                      <Play size={14} /> Hae liidi
                    </button>
                  </form>
                )}

                {activeTab === 'bulk' && (
                  <form onSubmit={handleBulkSubmit} className="space-y-4">
                    <div>
                      <label className="block text-[10px] uppercase font-bold mb-1.5 opacity-60">Domainit (yksi per rivi)</label>
                      <textarea value={bulkText} onChange={e => setBulkText(e.target.value)}
                        placeholder={"www.kaivo.fi\nwww.vesivek.fi\nvhapipetechnology.fi"}
                        rows={8}
                        className="w-full px-4 py-3 border border-[#141414] rounded-md focus:outline-none bg-[#F9F9F8] text-sm font-mono" />
                    </div>
                    <button type="submit" disabled={isRunning}
                      className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                      <Play size={14} /> Käynnistä ({bulkText.split('\n').filter(l => l.trim()).length} kpl)
                    </button>
                  </form>
                )}

                {activeTab === 'batch' && (
                  <div className="space-y-6">
                    <div onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-[#141414]/20 rounded-xl p-8 text-center cursor-pointer hover:border-[#141414]/40 hover:bg-black/5 transition-all group">
                      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv" className="hidden" />
                      <Upload className="mx-auto mb-4 opacity-30 group-hover:opacity-60" size={28} />
                      <p className="text-sm font-medium mb-1">Lataa CSV</p>
                      <p className="text-[10px] uppercase opacity-40">Sarakkeet: yritys, verkkosivu (tai company_name, domain)</p>
                    </div>
                    {pendingCount > 0 && !isRunning && (
                      <button onClick={runPending}
                        className="w-full py-3 bg-[#141414] text-[#E4E3E0] rounded-md font-bold uppercase tracking-widest text-xs flex items-center justify-center gap-2">
                        <Play size={14} /> Käsittele {pendingCount} jonossa olevaa
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Queue status */}
          <div className="bg-[#141414] text-[#E4E3E0] p-6 rounded-xl shadow-[4px_4px_0px_0px_rgba(255,255,255,0.1)]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                <AlertCircle size={12} />
                {isRunning ? 'Käsitellään...' : 'Jono'}
              </h3>
              {isRunning && (
                <button onClick={stopProcessing}
                  className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 uppercase font-bold border border-red-400/30 px-2 py-1 rounded">
                  <Square size={10} /> Pysäytä
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
              <div className="bg-white/5 rounded p-2">
                <div className="opacity-50 text-[9px] uppercase mb-1">Jonossa</div>
                <div className="font-bold text-lg">{queueStatus.pending}</div>
              </div>
              <div className="bg-white/5 rounded p-2">
                <div className="opacity-50 text-[9px] uppercase mb-1">Käsitellään</div>
                <div className="font-bold text-lg text-blue-400">{queueStatus.processing}</div>
              </div>
              <div className="bg-white/5 rounded p-2">
                <div className="opacity-50 text-[9px] uppercase mb-1">Valmis</div>
                <div className="font-bold text-lg text-emerald-400">{queueStatus.completed}</div>
              </div>
              <div className="bg-white/5 rounded p-2">
                <div className="opacity-50 text-[9px] uppercase mb-1">Virhe</div>
                <div className="font-bold text-lg text-red-400">{queueStatus.error}</div>
              </div>
            </div>
            <div className="mt-4 text-[9px] opacity-40 space-y-1 font-mono">
              {activeCampaign?.personaConfig ? (
                <>
                  <div>01 Priorisoi: {PERSONA_ROLES.find(r => r.value === activeCampaign.personaConfig!.primaryRole)?.label}</div>
                  {activeCampaign.personaConfig.fallbackRole && (
                    <div>02 Fallback: {PERSONA_ROLES.find(r => r.value === activeCampaign.personaConfig!.fallbackRole)?.label}</div>
                  )}
                  <div>{activeCampaign.personaConfig.fallbackRole ? '03' : '02'} Etusivu + alasivu (LLM-reititys)</div>
                  <div>{activeCampaign.personaConfig.fallbackRole ? '04' : '03'} Data pysyy paikallisesti</div>
                </>
              ) : (
                <>
                  <div>01 Priorisoi markkinointipäättäjät</div>
                  <div>02 Fallback: toimitusjohtaja / yrittäjä</div>
                  <div>03 Etusivu + alasivu (LLM-reititys)</div>
                  <div>04 Data pysyy paikallisesti</div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Results Column */}
        <div className="lg:col-span-8">
          <div className="bg-white border border-[#141414] rounded-xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="p-4 border-b border-[#141414] flex justify-between items-center bg-[#F9F9F8]">
              <h2 className="text-xs font-bold uppercase tracking-widest">
                {activeCampaign?.name || 'Tulokset'}
              </h2>
              <span className="text-[10px] font-mono bg-[#141414] text-[#E4E3E0] px-2 py-0.5 rounded">
                {leads.length} liidiä
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F9F9F8] border-b border-[#141414]">
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Yritys</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Päättäjä</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Yhteystiedot</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-50 italic">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#141414]/10">
                  <AnimatePresence initial={false}>
                    {leads.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-12 text-center opacity-30 italic text-sm">
                          {activeCampaignId
                            ? 'Ei liidejä tässä kampanjassa. Lisää URL tai lataa CSV.'
                            : 'Luo kampanja aloittaaksesi.'}
                        </td>
                      </tr>
                    ) : (
                      leads.map(lead => (
                        <motion.tr
                          key={lead.id}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`transition-colors group ${lead.isGenericContact ? 'bg-amber-50/60 hover:bg-amber-50' : 'hover:bg-black/[0.02]'}`}
                        >
                          <td className="p-4">
                            <div className="font-bold text-sm">{lead.companyName}</div>
                            <div className="text-[10px] font-mono opacity-50 flex items-center gap-1 mt-1">
                              <Globe size={9} />{lead.domain}
                            </div>
                          </td>
                          <td className="p-4">
                            {lead.status === 'completed' && lead.found ? (
                              <>
                                <div className="font-bold text-sm flex items-center gap-1.5">
                                  <User size={11} className="opacity-40" />{lead.contactName}
                                  {lead.isGenericContact && (
                                    <span title="Yleinen yritysyhteystieto — ei henkilökohtainen" className="text-amber-500 text-[10px]">⚠</span>
                                  )}
                                </div>
                                <div className="text-[10px] uppercase tracking-wider font-medium opacity-60 mt-0.5">{lead.contactTitle}</div>
                                {lead.sourceUrl && (
                                  <a href={lead.sourceUrl} target="_blank" rel="noreferrer"
                                    className="text-[9px] text-blue-600 hover:underline flex items-center gap-1 mt-1 opacity-70">
                                    <ExternalLink size={9} />
                                    {lead.sourceUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
                                  </a>
                                )}
                                {lead.extractionComment && (
                                  <button onClick={() => setShowReasoningId(lead.id)}
                                    className="mt-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-tighter text-amber-600 hover:text-amber-700 bg-amber-50 px-2 py-1 rounded border border-amber-200/50">
                                    <MessageSquareQuote size={9} /> Perustelut
                                  </button>
                                )}
                              </>
                            ) : lead.status === 'completed' ? (
                              <span className="text-[10px] uppercase font-bold text-red-500/70">Ei löytynyt</span>
                            ) : (
                              <div className="h-4 w-24 bg-black/5 animate-pulse rounded" />
                            )}
                          </td>
                          <td className="p-4">
                            {lead.status === 'completed' && lead.found ? (
                              <div className="space-y-1">
                                {lead.contactEmail && (
                                  <div className="text-[11px] font-mono flex items-center gap-1.5 group-hover:text-emerald-600 transition-colors">
                                    <Mail size={9} />{lead.contactEmail}
                                  </div>
                                )}
                                {lead.contactPhone && (
                                  <div className="text-[11px] font-mono flex items-center gap-1.5 opacity-60">
                                    <Phone size={9} />{lead.contactPhone}
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
                                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
                                  {(lead.status === 'processing' || lead.status === 'queued') && <Loader2 size={11} className="animate-spin" />}
                                  {lead.status === 'completed' && <CheckCircle2 size={11} className="text-emerald-600" />}
                                  {lead.status === 'error' && <AlertCircle size={11} className="text-red-500" />}
                                  {lead.status === 'pending' && <div className="w-2.5 h-2.5 border border-[#141414]/20 rounded-full" />}
                                  {lead.status === 'processing' ? 'Käsitellään' :
                                   lead.status === 'queued' ? 'Jonossa' :
                                   lead.status === 'completed' ? 'Valmis' :
                                   lead.status === 'error' ? 'Virhe' : 'Odottaa'}
                                </div>
                                <div className="text-[9px] font-mono opacity-50 truncate max-w-[110px]">
                                  {lead.statusMessage}
                                </div>
                              </div>
                              <button
                                onClick={() => setSelectedLeadId(lead.id)}
                                className="p-2 hover:bg-[#141414] hover:text-[#E4E3E0] rounded-md transition-all opacity-0 group-hover/row:opacity-100"
                                title="Avaa konsoli"
                              >
                                <FileText size={13} />
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
        </div>
      </main>

      <footer className="max-w-7xl mx-auto p-10 text-center">
        <div className="h-px bg-[#141414]/10 mb-6" />
        <p className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-30">
          SisuLead Miner • Data pysyy paikallisesti • Powered by Gemini AI
        </p>
      </footer>
    </div>
  );
}
