import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import nestClient from '../../api/nest-client';
import { formatPatientName } from '../../utils/patientName';
import { formatDateTime } from '../../utils/date';
import { buildLabSections } from './labSections';
import { BLOOD_GROUPS, flagForTest, flagBadge, refText } from './labResult';

/** The sheets a catalog row belongs to (a test can be printed on two sheets). */
const sheetsOf = (t: any): string[] =>
  String(t?.sheet || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);



/** Deterministic barcode-like SVG (same approach as the pharmacy label). */
function Barcode({ seed, width = 140 }: { seed: string; width?: number }) {
  const bars = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const out: number[] = [];
    let x = h >>> 0;
    for (let i = 0; i < 48; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out.push((x >> 16) % 3 === 0 ? 1 : 2);
    }
    return out;
  }, [seed]);

  return (
    <svg width={width} height="40" viewBox="0 0 140 40" className="d-block">
      {bars.map((w, i) => (
        <rect key={i} x={i * 2.9} y={0} width={w === 2 ? 2.4 : 1.2} height="34" fill="#1e293b" rx="0.4" />
      ))}
    </svg>
  );
}

export default function LabResultFormPage() {
  const { pid: urlPid } = useParams<{ pid: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [patientSearch, setPatientSearch] = useState('');
  const [selectedPid, setSelectedPid] = useState<string>(urlPid || '');
  const [selectedTests, setSelectedTests] = useState<Record<number, boolean>>({});
  const [values, setValues] = useState<Record<number, string>>({});
  const [comments, setComments] = useState<Record<number, string>>({});
  const [showAll, setShowAll] = useState(false);
  /** Explicit open/closed overrides for the category folders (see `catFolders`). */
  const [catOpen, setCatOpen] = useState<Record<string, boolean>>({});
  /** Quick-find across every test, whatever the folder state. */
  const [testSearch, setTestSearch] = useState('');
  const [tab, setTab] = useState<'form' | 'history'>('form');
  const [reportId, setReportId] = useState<number | null>(null);
  const [labNo, setLabNo] = useState('');
  const [toast, setToast] = useState('');

  /**
   * The "Normal Value" thresholds come from lab_test_catalog. Admins can correct
   * them here; the catalog reseed no longer overwrites an existing range, so a
   * change made in the app survives restarts.
   */
  const isAdmin = user?.role === 'admin';
  const [editRanges, setEditRanges] = useState(false);
  const [rangeDraft, setRangeDraft] = useState<Record<number, { min: string; max: string; text: string }>>({});

  const draftFor = (t: any) =>
    rangeDraft[t.id] ?? {
      min: t.ref_min != null ? String(t.ref_min) : '',
      max: t.ref_max != null ? String(t.ref_max) : '',
      text: t.ref_text || '',
    };

  const saveRange = useMutation({
    mutationFn: async (t: any) => {
      const d = rangeDraft[t.id];
      if (!d) return null;
      const body: any = {
        refText: d.text,
        refMin: d.min === '' ? null : d.min,
        refMax: d.max === '' ? null : d.max,
      };
      const r = await nestClient.patch(`/lab/catalog/${t.id}`, body);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lab-catalog'] });
      setToast('Normal value saved');
    },
    onError: (e: any) => setToast(e?.response?.data?.message || 'Could not save the normal value'),
  });

  const { data: patients = [] } = useQuery({
    queryKey: ['lab-patient-search', patientSearch],
    queryFn: async () => {
      if (patientSearch.trim().length < 2) return [];
      const r = await nestClient.get('/patients', { params: { search: patientSearch, limit: 15 } });
      return r.data;
    },
    enabled: patientSearch.trim().length >= 2,
  });

  const { data: patient } = useQuery({
    queryKey: ['patient', selectedPid],
    queryFn: async () => { const r = await nestClient.get(`/patients/${selectedPid}`); return r.data; },
    enabled: !!selectedPid,
  });

  const { data: catalog = [] } = useQuery({
    queryKey: ['lab-catalog'],
    queryFn: async () => { const r = await nestClient.get('/lab/catalog'); return r.data; },
  });

  const { data: orderedTests = [] } = useQuery({
    queryKey: ['lab-ordered-tests', selectedPid],
    queryFn: async () => {
      if (!selectedPid) return [];
      try { const r = await nestClient.get(`/patients/${selectedPid}/lab/ordered-tests`); return r.data || []; } catch { return []; }
    },
    enabled: !!selectedPid,
  });

  const { data: reports = [] } = useQuery({
    queryKey: ['lab-reports', selectedPid],
    queryFn: async () => { const r = await nestClient.get(`/patients/${selectedPid}/lab-reports`); return r.data; },
    enabled: !!selectedPid,
  });

  /**
   * Only the tests printed on a RESULT sheet reach this form. A test printed on
   * two sheets is listed in each folder but stays one row, so the value entered
   * is shared and the two sheets can never disagree.
   */
  const sheetTests = useMemo(
    () => (catalog as any[]).filter((t: any) => sheetsOf(t).length > 0),
    [catalog],
  );

  /**
   * The ordered section tree (shared with the Lab Orders result entry) resolved
   * against the live catalog. Items whose code is missing from the catalog are
   * skipped, so the render and the counts all come from one structure.
   */
  const sectionData = useMemo(() => buildLabSections(catalog as any[]), [catalog]);


  const orderedLower = useMemo(() => new Set((orderedTests as string[]).map(s => s.toLowerCase())), [orderedTests]);

  const selectPatient = (p: any) => {
    setSelectedPid(String(p.pid ?? p.id));
    setPatientSearch('');
    setSelectedTests({});
    setValues({});
    setComments({});
    setReportId(null);
    setLabNo('');
    // Auto-select the result-sheet tests that match the ordered test names.
    const sel: Record<number, boolean> = {};
    for (const t of sheetTests as any[]) {
      const match = orderedLower.has(String(t.name).toLowerCase()) ||
        orderedLower.has(String(t.code).toLowerCase());
      if (match) sel[t.id] = true;
    }
    setSelectedTests(sel);
  };

  const visibleTests = useMemo(() => {
    const list = (sheetTests as any[]).filter(t => showAll || selectedTests[t.id]);
    return list;
  }, [sheetTests, selectedTests, showAll]);

  /**
   * The catalog is 155 tests across ~20 sections, which makes one very long
   * page. Each section is presented as a folder instead, and the defaults are
   * chosen so the technician only sees what the order actually needs:
   *
   *  - "Show all" off  -> a folder is listed only when it holds a selected test.
   *  - "Show all" on   -> every folder is listed.
   *  - A folder opens when it holds a selected test, otherwise it stays shut and
   *    just reports its counts. Clicking a header pins it open/shut; the search
   *    box overrides everything and opens only the folders that match.
   */
  const needles = useMemo(
    () => testSearch.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [testSearch],
  );

  const catFolders = useMemo(() => {
    const rows: {
      cat: string;
      groups: { subsection?: string; items: { t: any; label: string }[] }[];
      total: number;
      selected: number;
      open: boolean;
      matched: number;
    }[] = [];

    const matches = (t: any) =>
      needles.every((n: string) =>
        `${t.name} ${t.code} ${t.unit || ''} ${t.ref_text || ''}`.toLowerCase().includes(n),
      );

    for (const sec of sectionData) {
      const all = sec.flat.map(i => i.t);
      const selected = all.filter((t: any) => selectedTests[t.id]).length;

      if (needles.length) {
        if (!all.some(matches)) continue;
      } else if (!showAll && !selected) {
        continue; // nothing ordered in this section — keep the page short
      }

      const groups = sec.groups
        .map(g => ({
          subsection: g.subsection,
          items: g.items.filter(i => (needles.length ? matches(i.t) : showAll || selectedTests[i.t.id])),
        }))
        .filter(g => g.items.length);
      if (!groups.length) continue;

      const matched = needles.length ? groups.reduce((n, g) => n + g.items.length, 0) : 0;

      rows.push({
        cat: sec.title,
        groups,
        total: all.length,
        selected,
        matched,
        open: needles.length ? true : (catOpen[sec.title] ?? selected > 0),
      });
    }
    return rows;
  }, [sectionData, selectedTests, showAll, needles, catOpen]);

  const openFolders = catFolders.filter(f => f.open).length;
  const setAllFolders = (open: boolean) =>
    setCatOpen(Object.fromEntries(catFolders.map(f => [f.cat, open])));

  const saveReport = useMutation({
    mutationFn: async (verify: boolean) => {
      const items = visibleTests.map(t => ({
        testId: t.id, code: t.code, name: t.name, category: t.category, unit: t.unit,
        refMin: t.ref_min, refMax: t.ref_max, refText: t.ref_text, resultType: t.result_type,
        resultValue: values[t.id] || '', comments: comments[t.id] || '',
      }));
      const payload = {
        items, labNo: labNo || undefined,
        technicianId: null,
        technicianName: user?.displayName || null,
        status: verify ? 'VERIFIED' : 'DRAFT',
      };
      if (reportId) {
        await nestClient.put(`/lab/reports/${reportId}`, { items });
        if (verify) await nestClient.post(`/lab/reports/${reportId}/verify`, payload);
      } else {
        const r = await nestClient.post(`/patients/${selectedPid}/lab-reports`, payload);
        return r.data;
      }
    },
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ['lab-reports', selectedPid] });
      setToast(d?.labNo ? `Saved ${d.labNo}` : 'Report saved');
      if (!reportId && d?.id) setReportId(d.id);
    },
    onError: (e: any) => setToast(e?.response?.data?.message || 'Save failed'),
  });

  const openReport = async (id: number) => {
    try {
      const r = await nestClient.get(`/lab/reports/${id}`);
      const rep = r.data;
      setReportId(rep.id);
      setLabNo(rep.lab_no || '');
      setSelectedPid(String(rep.pid));
      const sel: Record<number, boolean> = {};
      const val: Record<number, string> = {};
      const cm: Record<number, string> = {};
      for (const it of rep.items || []) {
        if (it.test_id) { sel[it.test_id] = true; val[it.test_id] = it.result_value || ''; cm[it.test_id] = it.comments || ''; }
      }
      setSelectedTests(sel);
      setValues(val);
      setComments(cm);
      setTab('form');
    } catch (e: any) { setToast('Could not load report'); }
  };

  const renderInput = (t: any) => {
    if (t.result_type === 'POSITIVE_NEGATIVE') {
      return (
        <select className="form-select form-select-sm" value={values[t.id] || ''} onChange={e => setValues({ ...values, [t.id]: e.target.value })}>
          <option value="">—</option>
          <option>Negative</option><option>Positive</option><option>Non-Reactive</option><option>Reactive</option>
        </select>
      );
    }
    if (t.result_type === 'BLOOD_GROUP') {
      return (
        <select className="form-select form-select-sm" value={values[t.id] || ''} onChange={e => setValues({ ...values, [t.id]: e.target.value })}>
          <option value="">—</option>
          {BLOOD_GROUPS.map(g => <option key={g}>{g}</option>)}
        </select>
      );
    }
    if (t.result_type === 'SELECT' && t.options) {
      return (
        <select className="form-select form-select-sm" value={values[t.id] || ''} onChange={e => setValues({ ...values, [t.id]: e.target.value })}>
          <option value="">—</option>
          {String(t.options).split(',').map(o => <option key={o}>{o}</option>)}
        </select>
      );
    }
    return <input className="form-control form-control-sm" type={t.result_type === 'NUMERIC' ? 'number' : 'text'} step="any" value={values[t.id] || ''} onChange={e => setValues({ ...values, [t.id]: e.target.value })} />;
  };

  return (
    <div className="glass-page position-relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #dbeafe 0%, #f5faff 45%, #d1fae5 100%)', borderRadius: '20px', minHeight: '100vh', padding: '16px' }}>
      {toast && (
        <div className="alert alert-info py-2 small d-flex justify-content-between align-items-center">
          <span><i className="bi bi-info-circle me-1"></i>{toast}</span>
          <button className="btn-close btn-sm" onClick={() => setToast('')}></button>
        </div>
      )}

      <div className="rounded-4 p-4 mb-4 text-white" style={{ background: 'linear-gradient(135deg, #0d6efd 0%, #198754 60%, #00c9a7 100%)' }}>
        <h3 className="mb-1 fw-bold"><i className="bi bi-droplet-half me-2"></i>Patient Laboratory Result Form</h3>
        <p className="mb-0 text-white text-opacity-75 small">MA JUAH MEMORIAL CLINIC · DELIVERING QUALITY MEDICAL SERVICES</p>
      </div>

      {/* Patient selector */}
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: '16px' }}>
        <div className="card-body">
          <label className="form-label small fw-semibold">Select patient</label>
          <div className="position-relative">
            <input className="form-control" placeholder="Search patient name…" value={patientSearch} onChange={e => setPatientSearch(e.target.value)} />
            {patientSearch.trim().length >= 2 && patients.length > 0 && (
              <div className="list-group position-absolute w-100 shadow" style={{ zIndex: 10, maxHeight: '260px', overflowY: 'auto' }}>
                {patients.map((p: any) => (
                  <button key={p.id} type="button" className="list-group-item list-group-item-action small" onClick={() => selectPatient(p)}>
                    {formatPatientName(p)} · {p.sex || '—'} · PID #{p.pid}
                  </button>
                ))}
              </div>
            )}
          </div>
          {patient && (
            <div className="row g-2 mt-3">
              <div className="col-md-3"><small className="text-muted">Name</small><div className="fw-semibold">{formatPatientName(patient)}</div></div>
              <div className="col-md-2"><small className="text-muted">Age</small><div>{patient.DOB ? String(patient.DOB).slice(0, 10) : '—'}</div></div>
              <div className="col-md-2"><small className="text-muted">Sex</small><div>{patient.sex || '—'}</div></div>
              <div className="col-md-2"><small className="text-muted">Reg #</small><div>{patient.public_id || `#${patient.pid}`}</div></div>
              <div className="col-md-3"><small className="text-muted">Lab No</small><input className="form-control form-control-sm" placeholder="Auto" value={labNo} onChange={e => setLabNo(e.target.value)} /></div>
            </div>
          )}
          {patient && (
            <div className="d-flex align-items-end gap-3 mt-3">
              <div className="p-2 bg-white border rounded-3">
                <Barcode seed={labNo || patient.public_id || `#${patient.pid}`} />
                <div className="small text-muted text-center" style={{ fontSize: '0.7rem' }}>{labNo || patient.public_id || `#${patient.pid}`}</div>
              </div>
              <div className="small text-muted"><i className="bi bi-upc-scan me-1"></i>Specimen / Lab No barcode</div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <ul className="nav nav-pills gap-2 mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === 'form' ? 'active' : ''}`} onClick={() => setTab('form')}><i className="bi bi-pencil-square me-1"></i>Result Entry</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}><i className="bi bi-clock-history me-1"></i>Lab History</button></li>
      </ul>

      {tab === 'form' ? (
        <>
          <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
            <span className="small text-muted">
              <i className="bi bi-folder2-open me-1"></i>
              {catFolders.length} section{catFolders.length === 1 ? '' : 's'} · {openFolders} open
              <span className="ms-2">{visibleTests.length} tests shown</span>
            </span>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill"
                onClick={() => setAllFolders(true)} disabled={!catFolders.length}>
                <i className="bi bi-arrows-expand me-1"></i>Expand all
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill"
                onClick={() => setAllFolders(false)} disabled={!catFolders.length}>
                <i className="bi bi-arrows-collapse me-1"></i>Collapse all
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className={`btn btn-sm rounded-pill ${editRanges ? 'btn-primary' : 'btn-outline-secondary'}`}
                  onClick={() => { setEditRanges(v => !v); setRangeDraft({}); }}
                  title="Correct the normal-value / threshold ranges stored for each test"
                >
                  <i className="bi bi-sliders me-1"></i>
                  {editRanges ? 'Done editing normal values' : 'Edit normal values'}
                </button>
              )}
              <div className="form-check form-switch mb-0">
                <input className="form-check-input" type="checkbox" id="showAll" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
                <label className="form-check-label small" htmlFor="showAll">Show All Tests</label>
              </div>
            </div>
          </div>

          {/* Quick-find: opens only the sections that match, whatever the folder state */}
          <div className="input-group input-group-sm mb-3" style={{ maxWidth: 420 }}>
            <span className="input-group-text bg-white"><i className="bi bi-search text-muted"></i></span>
            <input
              className="form-control"
              placeholder="Find a test (name, code, unit or normal value)…"
              value={testSearch}
              onChange={e => setTestSearch(e.target.value)}
            />
            {testSearch && (
              <button className="btn btn-outline-secondary" type="button" onClick={() => setTestSearch('')} title="Clear">
                <i className="bi bi-x-lg"></i>
              </button>
            )}
          </div>

          <p className="text-muted mb-3" style={{ fontSize: '0.78rem' }}>
            <i className="bi bi-info-circle me-1"></i>
            Results are recorded under the laboratory sections — Haematology, Clinical Chemistry, Serology, Microbiology,
            Malaria / Parasitology, Immunohaematology, Immunology / Allergy and Urine Chemistry. Tests ordered from the
            laboratory request form that are not on this form are not recorded here.
          </p>

          {!selectedPid ? (
            <div className="text-center text-muted py-5"><i className="bi bi-person-search fs-1 d-block mb-2"></i>Select a patient to begin result entry.</div>
          ) : catFolders.length === 0 ? (
            <div className="text-center text-muted py-5">
              <i className="bi bi-folder2 fs-1 d-block mb-2"></i>
              {needles.length ? 'No test matches that search.' : 'No tests are selected for this patient yet.'}
              {!needles.length && !showAll && <div className="small mt-2">Turn on “Show All Tests” to pick any test from the catalog.</div>}
            </div>
          ) : catFolders.map(folder => {
            const { cat, groups, total, selected, open, matched } = folder;
            const picked = needles.length ? [] : groups.flatMap(g => g.items).filter(i => selectedTests[i.t.id]);
            return (
              <div className="card border-0 shadow-sm mb-2" key={cat} style={{ borderRadius: '16px' }}>
                <button
                  type="button"
                  className="card-header bg-white py-2 d-flex align-items-center gap-2 w-100 border-0 text-start"
                  style={{ borderRadius: '16px', cursor: 'pointer' }}
                  onClick={() => setCatOpen({ ...catOpen, [cat]: !open })}
                  aria-expanded={open}
                >
                  <i className={`bi bi-chevron-${open ? 'down' : 'right'} text-muted small`} style={{ width: 12 }}></i>
                  <i className="bi bi-folder-fill" style={{ color: selected ? '#ffc107' : '#c8ced6' }}></i>
                  <span className="mb-0 fw-bold small text-uppercase flex-grow-1">{cat}</span>
                  {selected > 0 && (
                    <span className="badge rounded-pill bg-primary" style={{ fontSize: '0.62rem' }}>{selected} selected</span>
                  )}
                  <span className="badge rounded-pill bg-light text-dark border" style={{ fontSize: '0.62rem' }}>
                    {needles.length ? `${matched} match` : total}
                  </span>
                </button>
                {!open && picked.length > 0 && (
                  <div className="px-3 pb-2 text-muted" style={{ fontSize: '0.7rem' }}>
                    <i className="bi bi-check2-circle me-1"></i>
                    {picked.slice(0, 4).map((i) => i.label).join(', ')}
                    {picked.length > 4 ? ` +${picked.length - 4} more` : ''}
                  </div>
                )}
                {open && (
                <div className="card-body p-0">
                  <div className="table-responsive">
                    <table className="table table-sm table-hover mb-0 align-middle">
                      <thead className="table-light">
                        <tr><th style={{ width: 40 }}></th><th>Test Request</th><th>Results</th><th>Unit</th><th>Normal Value</th><th>Flag</th><th>Comments</th></tr>
                      </thead>
                      <tbody>
                        {groups.map((g, gi) => (
                          <Fragment key={g.subsection || `g${gi}`}>
                            {g.subsection && (
                              <tr className="table-secondary">
                                <td colSpan={7} className="fw-bold small text-uppercase py-1" style={{ letterSpacing: '0.03em' }}>{g.subsection}</td>
                              </tr>
                            )}
                            {g.items.map(({ t, label }) => (
                          <tr key={t.id} className={selectedTests[t.id] ? '' : 'opacity-50'}>
                            <td><input type="checkbox" className="form-check-input" checked={!!selectedTests[t.id]} onChange={e => setSelectedTests({ ...selectedTests, [t.id]: e.target.checked })} /></td>
                            <td className="fw-semibold">{label}</td>
                            <td style={{ minWidth: 140 }}>{renderInput(t)}</td>
                            <td>{t.unit || '—'}</td>
                            <td>
                              {editRanges ? (() => {
                                const d = draftFor(t);
                                const setD = (patch: Partial<typeof d>) =>
                                  setRangeDraft({ ...rangeDraft, [t.id]: { ...d, ...patch } });
                                return (
                                  <div className="d-flex align-items-center gap-1" style={{ minWidth: 210 }}>
                                    <input className="form-control form-control-sm" style={{ width: 52 }} placeholder="min"
                                      value={d.min} onChange={e => setD({ min: e.target.value })} />
                                    <span className="text-muted small">–</span>
                                    <input className="form-control form-control-sm" style={{ width: 52 }} placeholder="max"
                                      value={d.max} onChange={e => setD({ max: e.target.value })} />
                                    <input className="form-control form-control-sm" style={{ width: 92 }} placeholder="text"
                                      title="Printed normal value (overrides min–max in the display)"
                                      value={d.text} onChange={e => setD({ text: e.target.value })} />
                                    <button type="button" className="btn btn-sm btn-outline-success py-0 px-1"
                                      disabled={saveRange.isPending}
                                      title="Save this normal value"
                                      onClick={() => saveRange.mutate(t)}>
                                      <i className="bi bi-check-lg"></i>
                                    </button>
                                  </div>
                                );
                              })() : refText(t)}
                            </td>
                            <td>{values[t.id] ? <span className={`badge ${flagBadge(flagForTest(t, values[t.id]))}`}>{flagForTest(t, values[t.id])}</span> : '—'}</td>
                            <td><input className="form-control form-control-sm" value={comments[t.id] || ''} onChange={e => setComments({ ...comments, [t.id]: e.target.value })} /></td>
                          </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                )}
              </div>
            );
          })}

          {selectedPid && (
            <div className="d-flex gap-2 justify-content-end mt-3 flex-wrap">
              <button className="btn btn-outline-secondary rounded-pill"
                onClick={() => { setAllFolders(true); setTestSearch(''); setTimeout(() => window.print(), 150); }}
                title="Prints every section, so collapsed folders are opened first">
                <i className="bi bi-printer me-1"></i>Print
              </button>
              <button className="btn btn-primary rounded-pill px-4" disabled={saveReport.isPending} onClick={() => saveReport.mutate(false)}>
                <i className="bi bi-save me-1"></i>Save Draft
              </button>
              <button className="btn btn-success rounded-pill px-4" disabled={saveReport.isPending} onClick={() => saveReport.mutate(true)}>
                <i className="bi bi-check2-circle me-1"></i>Save & Verify
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
          <div className="card-body p-0">
            {!reports || reports.length === 0 ? (
              <div className="text-center text-muted py-5">No laboratory reports for this patient.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-hover small mb-0 align-middle">
                  <thead className="table-light"><tr><th>Date</th><th>Lab No</th><th>Tests</th><th>Status</th><th>Technician</th><th>Actions</th></tr></thead>
                  <tbody>
                    {(reports as any[]).map((r: any) => (
                      <tr key={r.id}>
                        <td>{formatDateTime(r.created_at)}</td>
                        <td>{r.lab_no || `#${r.id}`}</td>
                        <td>{r.item_count}</td>
                        <td><span className={`badge ${r.status === 'VERIFIED' ? 'bg-success' : 'bg-secondary'}`}>{r.status}</span></td>
                        <td>{r.technician_name || '—'}</td>
                        <td>
                          <button className="btn btn-outline-primary btn-sm rounded-pill me-1" onClick={() => openReport(r.id)}><i className="bi bi-pencil"></i> View/Edit</button>
                          <button className="btn btn-outline-secondary btn-sm rounded-pill" onClick={() => { setReportId(r.id); setTab('form'); openReport(r.id).then(() => window.print()); }}><i className="bi bi-printer"></i></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Print-only report */}
      <div className="print-only" style={{ display: 'none' }}>
        <style>{`
          @media print {
            body * { visibility: hidden; }
            .print-only, .print-only * { visibility: visible; }
            .print-only { position: absolute; left: 0; top: 0; width: 100%; }
          }
        `}</style>
        <div style={{ padding: '20px', fontFamily: 'Georgia, serif' }}>
          <div className="text-center mb-2">
            <h3 className="mb-0 fw-bold">MA JUAH MEMORIAL CLINIC</h3>
            <div className="text-uppercase small">Delivering Quality Medical Services</div>
            <div className="d-inline-block mt-2">
              <Barcode seed={labNo || patient?.public_id || `#${patient?.pid || '—'}`} />
              <div className="small" style={{ letterSpacing: 2 }}>{labNo || patient?.public_id || `#${patient?.pid || '—'}`}</div>
            </div>
          </div>
          <table className="table table-bordered table-sm mb-3">
            <tbody>
              <tr><th>Patient's Name:</th><td>{patient ? formatPatientName(patient) : '—'}</td><th>Sex:</th><td>{patient?.sex || '—'}</td></tr>
              <tr><th>Reg #:</th><td>{patient?.public_id || `#${patient?.pid || '—'}`}</td><th>Date:</th><td>{new Date().toLocaleDateString()}</td></tr>
              <tr><th>Lab No:</th><td>{labNo || 'Auto'}</td><th>Age:</th><td>{patient?.DOB ? String(patient.DOB).slice(0, 10) : '—'}</td></tr>
            </tbody>
          </table>
          <table className="table table-bordered table-sm">
            <thead><tr><th>Test Request</th><th>Results</th><th>Normal Value</th></tr></thead>
            <tbody>
              {visibleTests.map((t: any) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{values[t.id] || ''} {t.unit || ''}</td>
                  <td>{refText(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="d-flex justify-content-between mt-4">
            <div>Lab Technician's Name: {user?.displayName || '________________'}</div>
            <div>Signature: ______________________</div>
            <div>Date: {new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
