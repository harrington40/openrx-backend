import { useState, useMemo, useEffect } from 'react';
import { formatDateTime } from '../../utils/date';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { useDebounce } from '../../hooks/useDebounce';
import nestClient from '../../api/nest-client';
import {
  administerMedicationOrder,
  ackMedicationAlert,
  hospitalizePatient,
} from '../../api/endpoints/medicationAdministration';
import {
  getHandover,
  getIO,
  addIO,
  getSafety,
  saveSafety,
  getFlags,
  setFlags,
  escalate,
  completeTask,
  getPatient360,
  getChecklist,
} from '../../api/endpoints/rnWorkbench';
import {
  assessPatient,
  computeNEWS2,
  riskBadge,
  type VitalsSnapshot,
} from '../../utils/nursingSafety';
import { classifyBP, formatVital, formatBP } from '../../utils/vitalsClassify';
import { formatPatientName } from '../../utils/patientName';

/** Normalise a vitals row into a snapshot for the safety algorithm. */
function toSnapshot(v: any): VitalsSnapshot {
  const nz = (x: any): number | string | null => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const temp = Number(v?.temperature);
  const tempC = Number.isFinite(temp) && temp > 45
    ? Math.round(((temp - 32) * 5 / 9) * 10) / 10
    : Number.isFinite(temp) && temp > 0 ? temp : null;
  return {
    bps: nz(v?.bps), bpd: nz(v?.bpd), pulse: nz(v?.pulse),
    temperature: tempC,
    respiration: nz(v?.respiration),
    oxygen_saturation: nz(v?.oxygen_saturation),
  };
}

function riskRank(level: string): number {
  switch (level) {
    case 'Critical': return 4;
    case 'High': return 3;
    case 'Moderate': return 2;
    case 'Low': return 1;
    default: return 0;
  }
}

export default function NurseRNDashboardPage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 250);
  const [selectedPatient, setSelectedPatient] = useState<any>(null);
  const [tab, setTab] = useState('meds');

  // ── Forms ─────────────────────────────────────────────────────────────
  const [planForm, setPlanForm] = useState({ description: '', care_plan_type: 'nursing' });
  const [noteForm, setNoteForm] = useState({ title: '', note: '' });

  // ── RN dashboard: active ward patients + shared notes ─────────────────
  const { data: nurseData } = useQuery({
    queryKey: ['nurse-dashboard'],
    queryFn: async () => {
      try { const r = await nestClient.get('/nurse/dashboard'); return r.data; }
      catch { return { patients: [], assignedPatients: [], sharedNotes: [], unreadCount: 0 }; }
    },
    refetchInterval: 30000,
  });

  const patients = useMemo(() => {
    const list = nurseData?.patients || nurseData?.assignedPatients || [];
    const q = debounced.trim().toLowerCase();
    const filtered = q
      ? list.filter((p: any) => `${p.fname} ${p.lname}`.toLowerCase().includes(q))
      : list;
    return filtered
      .map((p: any) => ({ ...p, risk: assessPatient(toSnapshot(p), p.acuity_level) }))
      .sort((a: any, b: any) => riskRank(b.risk.level) - riskRank(a.risk.level));
  }, [nurseData, debounced]);

  const criticalCount = patients.filter((p: any) => p.risk.level === 'Critical').length;
  const highCount = patients.filter((p: any) => p.risk.level === 'High').length;
  const unreadCount = nurseData?.unreadCount || 0;

  const pid = selectedPatient?.pid ?? null;

  // ── Patient detail queries ─────────────────────────────────────────────
  const { data: vitalsHistory = [] } = useQuery({
    queryKey: ['vitals', pid],
    queryFn: async () => (pid ? (await nestClient.get(`/patients/${pid}/vitals`)).data : []),
    enabled: !!pid,
  });
  const { data: medications = [] } = useQuery({
    queryKey: ['medications', pid],
    queryFn: async () => (pid ? (await nestClient.get(`/patients/${pid}/medications`)).data : []),
    enabled: !!pid,
  });
  const { data: allergies = [] } = useQuery({
    queryKey: ['allergies', pid],
    queryFn: async () => (pid ? (await nestClient.get(`/patients/${pid}/allergies`)).data : []),
    enabled: !!pid,
  });
  const { data: carePlan = [] } = useQuery({
    queryKey: ['care-plan', pid],
    queryFn: async () => (pid ? (await nestClient.get(`/patients/${pid}/care-plan`)).data : []),
    enabled: !!pid,
  });
  const { data: notes = [] } = useQuery({
    queryKey: ['patient', pid, 'notes'],
    queryFn: async () => (pid ? (await nestClient.get(`/patients/${pid}/notes`)).data : []),
    enabled: !!pid,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['nurse-dashboard'] });
    qc.invalidateQueries({ queryKey: ['vitals', pid] });
    qc.invalidateQueries({ queryKey: ['medications', pid] });
    qc.invalidateQueries({ queryKey: ['allergies', pid] });
    qc.invalidateQueries({ queryKey: ['care-plan', pid] });
    qc.invalidateQueries({ queryKey: ['patient', pid, 'notes'] });
  };

  // ── Mutations ──────────────────────────────────────────────────────────
  const addCarePlan = useMutation({
    mutationFn: (d: any) => nestClient.post(`/patients/${pid}/care-plan`, d),
    onSuccess: () => { invalidate(); setPlanForm({ description: '', care_plan_type: 'nursing' }); },
  });
  const addNote = useMutation({
    mutationFn: (d: any) => nestClient.post(`/patients/${pid}/notes`, { title: d.title || 'RN Note', note: d.note, noteType: 'nurse', shareWithNursing: true }),
    onSuccess: () => { invalidate(); setNoteForm({ title: '', note: '' }); },
  });
  const markAllRead = useMutation({
    mutationFn: () => nestClient.post('/nurse/notes/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nurse-dashboard'] }),
  });

  // ── Medication administration (MAR) ────────────────────────────────────
  // Delivered in the same /nurse/dashboard payload the ward view already polls.
  const mar: any = nurseData?.medicationAdministration;
  const [giveOrder, setGiveOrder] = useState<any>(null);
  const [giveForm, setGiveForm] = useState({ overrideReason: '', witnessBy: '', notes: '', patientBarcode: '', drugBarcode: '' });
  const [giveIssues, setGiveIssues] = useState<any[]>([]);

  const giveMed = useMutation({
    mutationFn: (o: any) =>
      administerMedicationOrder(o.order_id, {
        patientId: o.pid,
        overrideReason: giveForm.overrideReason.trim() || undefined,
        witnessBy: giveForm.witnessBy ? Number(giveForm.witnessBy) : undefined,
        notes: giveForm.notes.trim() || undefined,
        patientBarcode: giveForm.patientBarcode.trim() || undefined,
        drugBarcode: giveForm.drugBarcode.trim() || undefined,
      }),
    onSuccess: () => {
      setGiveOrder(null);
      setGiveIssues([]);
      setGiveForm({ overrideReason: '', witnessBy: '', notes: '', patientBarcode: '', drugBarcode: '' });
      invalidate();
    },
    onError: (e: any) => {
      const data = e?.response?.data;
      setGiveIssues(
        Array.isArray(data?.issues)
          ? data.issues
          : [{ code: 'error', severity: 'critical', message: data?.message || 'Administration failed.' }],
      );
    },
  });

  const ackAlert = useMutation({
    mutationFn: (id: number) => ackMedicationAlert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nurse-dashboard'] }),
  });

  const admit = useMutation({
    mutationFn: ({ pid: p, room }: any) => hospitalizePatient(p, room),
    onSuccess: () => invalidate(),
  });

  // ── Safety & workflow workbench ────────────────────────────────────────
  const wb: any = nurseData?.workbench;
  const [ioForm, setIoForm] = useState({ kind: 'intake', category: '', volumeMl: '', note: '' });
  const [escalateReason, setEscalateReason] = useState('');
  const [handover, setHandover] = useState<any>(null);
  const [fallForm, setFallForm] = useState<any>({ historyOfFalling: false, secondaryDiagnosis: false, ambulatoryAid: 0, ivLine: false, gait: 0, impairedJudgement: false });
  const [bradenForm, setBradenForm] = useState<any>({ sensoryPerception: 4, moisture: 4, activity: 4, mobility: 4, nutrition: 4, frictionShear: 4 });
  const [flagsForm, setFlagsForm] = useState({ codeStatus: '', isolation: '' });

  const patientSafety = useQuery({ queryKey: ['safety', pid], enabled: !!pid, queryFn: async () => getSafety(pid as any) });
  const patientIO = useQuery({ queryKey: ['io', pid], enabled: !!pid, queryFn: async () => getIO(pid as any) });
  const patientFlags = useQuery({ queryKey: ['flags', pid], enabled: !!pid, queryFn: async () => getFlags(pid as any) });
  const patient360 = useQuery({ queryKey: ['360', pid], enabled: !!pid, queryFn: async () => getPatient360(pid as any) });
  const admissionList = useQuery({ queryKey: ['checklist', pid, 'admission'], enabled: !!pid, queryFn: async () => getChecklist(pid as any, 'admission') });
  const dischargeList = useQuery({ queryKey: ['checklist', pid, 'discharge'], enabled: !!pid, queryFn: async () => getChecklist(pid as any, 'discharge') });

  useEffect(() => {
    const f = patientFlags.data;
    setFlagsForm({ codeStatus: f?.code_status || '', isolation: f?.isolation || '' });
  }, [patientFlags.data]);

  const doneTask = useMutation({ mutationFn: (id: number) => completeTask(id), onSuccess: () => invalidate() });
  const escalatePt = useMutation({ mutationFn: (reason: string) => escalate(pid as any, reason), onSuccess: () => { setEscalateReason(''); invalidate(); } });
  const addIo = useMutation({ mutationFn: (d: any) => addIO(pid as any, d), onSuccess: () => { setIoForm({ kind: 'intake', category: '', volumeMl: '', note: '' }); qc.invalidateQueries({ queryKey: ['io', pid] }); } });
  const saveFall = useMutation({ mutationFn: (d: any) => saveSafety(pid as any, 'fall', d), onSuccess: () => qc.invalidateQueries({ queryKey: ['safety', pid] }) });
  const saveBraden = useMutation({ mutationFn: (d: any) => saveSafety(pid as any, 'braden', d), onSuccess: () => qc.invalidateQueries({ queryKey: ['safety', pid] }) });
  const loadHandover = useMutation({ mutationFn: () => getHandover(pid as any), onSuccess: (h: any) => setHandover(h) });
  const saveFlags = useMutation({ mutationFn: (d: any) => setFlags(pid as any, d), onSuccess: () => qc.invalidateQueries({ queryKey: ['flags', pid] }) });

  const openGive = (o: any) => {
    setGiveOrder(o);
    setGiveIssues([]);
    setGiveForm({ overrideReason: '', witnessBy: '', notes: '', patientBarcode: '', drugBarcode: '' });
  };

  const statusBadge = (s: string) =>
    s === 'overdue' ? 'bg-danger' : s === 'due' ? 'bg-warning text-dark' : 'bg-secondary';

  const fmtDate = (d: string | null | undefined) => formatDateTime(d);

  return (
    <div className="glass-page position-relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #dbeafe 0%, #f5faff 45%, #d1fae5 100%)', borderRadius: '20px', minHeight: '100vh', padding: '16px' }}>
      <div className="position-absolute rounded-circle" style={{ width: '340px', height: '340px', top: '-80px', right: '-60px', background: 'radial-gradient(circle, rgba(13,110,253,0.30), transparent 70%)', filter: 'blur(20px)', zIndex: 0 }}></div>
      <div className="position-absolute rounded-circle" style={{ width: '400px', height: '400px', bottom: '8%', left: '-120px', background: 'radial-gradient(circle, rgba(0,201,167,0.30), transparent 70%)', filter: 'blur(20px)', zIndex: 0 }}></div>
      <style>{`
        .glass-page .card {
          position: relative;
          z-index: 1;
          background: rgba(255,255,255,0.60) !important;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255,255,255,0.9) !important;
          box-shadow: 0 22px 45px rgba(10,37,64,0.20), 0 6px 14px rgba(10,37,64,0.10) !important;
          transition: transform .25s ease, box-shadow .25s ease, background .25s ease;
        }
        .glass-page .card:hover {
          transform: translateY(-5px);
          background: rgba(255,255,255,0.70) !important;
          box-shadow: 0 30px 60px rgba(10,37,64,0.28), 0 10px 20px rgba(10,37,64,0.14) !important;
        }
        .glass-page .card .card-header,
        .glass-page .card-header {
          background: rgba(255,255,255,0.35) !important;
          border-bottom: 1px solid rgba(255,255,255,0.6) !important;
        }
        .glass-page .table thead.table-light {
          background: rgba(255,255,255,0.35) !important;
        }
      `}</style>

      {/* Header */}
      <div className="rounded-4 p-4 mb-4 text-white" style={{ background: 'linear-gradient(135deg, #6f42c1 0%, #0d6efd 55%, #20c997 100%)' }}>
        <div className="d-flex justify-content-between align-items-start flex-wrap gap-3">
          <div>
            <h2 className="mb-1 fw-bold"><i className="bi bi-clipboard2-pulse me-2"></i>Registered Nurse (RN) Dashboard</h2>
            <p className="mb-0 text-white text-opacity-75 small">
              Welcome, {user?.displayName || 'RN'} — Assessments, medication administration & care coordination
            </p>
          </div>
          <div className="d-flex gap-2">
            {unreadCount > 0 && (
              <button className="btn btn-light btn-sm rounded-pill" onClick={() => markAllRead.mutate()}>
                <i className="bi bi-envelope-open me-1"></i>Mark {unreadCount} note{unreadCount !== 1 ? 's' : ''} read
              </button>
            )}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="row g-3 mb-4">
        {[
          { label: 'Patients on Dashboard', value: patients.length, icon: 'bi-people-fill', color: '#0d6efd' },
          { label: 'Critical', value: criticalCount, icon: 'bi-exclamation-octagon-fill', color: '#dc3545' },
          { label: 'High Risk', value: highCount, icon: 'bi-exclamation-triangle-fill', color: '#fd7e14' },
          { label: 'Unread Notes', value: unreadCount, icon: 'bi-envelope-fill', color: '#6f42c1' },
          { label: 'Hospitalized', value: mar?.summary?.hospitalized ?? 0, icon: 'bi-hospital-fill', color: '#0dcaf0' },
          { label: 'Medications Due', value: mar?.summary?.dueNow ?? 0, icon: 'bi-alarm-fill', color: '#fd7e14' },
          { label: 'Overdue Doses', value: mar?.summary?.overdue ?? 0, icon: 'bi-exclamation-circle-fill', color: '#d63384' },
          { label: 'High-alert Meds', value: mar?.summary?.highAlert ?? 0, icon: 'bi-shield-exclamation', color: '#6f42c1' },
        ].map((k, i) => (
          <div className="col-md-3" key={i}>
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: '16px' }}>
              <div className="card-body d-flex align-items-center gap-3">
                <div className="rounded-circle d-flex align-items-center justify-content-center" style={{ width: '46px', height: '46px', backgroundColor: k.color + '18' }}>
                  <i className={`bi ${k.icon} fs-5`} style={{ color: k.color }}></i>
                </div>
                <div><div className="fw-bold fs-5" style={{ color: k.color }}>{k.value}</div><small className="text-muted">{k.label}</small></div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Medication Administration board — hospitalized patients, due/overdue/high-alert + alerts */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: '16px' }}>
        <div className="card-header bg-white py-2 d-flex align-items-center justify-content-between">
          <h6 className="mb-0 fw-bold small"><i className="bi bi-capsule-pill me-1"></i>Medication Administration</h6>
          <span className="badge bg-light text-dark border small">
            {mar?.summary?.scheduled ?? 0} scheduled · {mar?.summary?.unreadAlerts ?? 0} unread alert{(mar?.summary?.unreadAlerts ?? 0) === 1 ? '' : 's'}
          </span>
        </div>
        <div className="card-body">
          {!mar ? (
            <div className="text-center text-muted py-4 small">No medication-administration data.</div>
          ) : (
            <div className="row g-3">
              <div className="col-md-8">
                {(!mar.due || mar.due.length === 0) ? (
                  <div className="text-center text-muted py-4 small">
                    No doses due or overdue. Admit a patient (below) to build their medication administration record.
                  </div>
                ) : (
                  <div className="table-responsive">
                    <table className="table table-sm table-hover align-middle mb-0 small">
                      <thead className="table-light">
                        <tr>
                          <th>Patient</th><th>Room</th><th>Medicine</th><th>Dose</th><th>Route</th><th>Scheduled</th><th>Status</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {mar.due.map((o: any) => (
                          <tr key={o.order_id} className={o.high_alert ? 'table-warning' : ''}>
                            <td>{o.patient_name}</td>
                            <td>{o.room || '—'}</td>
                            <td className="fw-semibold">
                              {o.drug}
                              {o.high_alert && <span className="badge bg-danger ms-1" title="High-alert medicine">H</span>}
                            </td>
                            <td>{o.dose || '—'}</td>
                            <td>{o.route || '—'}</td>
                            <td>{fmtDate(o.scheduled_at)}</td>
                            <td><span className={`badge rounded-pill ${statusBadge(o.status)}`}>{o.status}</span></td>
                            <td>
                              <button className="btn btn-sm btn-primary rounded-pill" onClick={() => openGive(o)}>
                                <i className="bi bi-check2-circle me-1"></i>Give
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="col-md-4">
                <h6 className="fw-bold small text-muted text-uppercase mb-2">Notifications</h6>
                {(!mar.alerts || mar.alerts.length === 0) ? (
                  <div className="text-center text-muted py-3 small">No medication notifications.</div>
                ) : (
                  <div className="list-group list-group-flush" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                    {mar.alerts.map((a: any) => (
                      <div className="list-group-item px-0" key={a.id}>
                        <div className="d-flex justify-content-between align-items-start gap-2">
                          <span className={`badge ${a.severity === 'critical' ? 'bg-danger' : a.severity === 'warning' ? 'bg-warning text-dark' : 'bg-info text-dark'}`}>{a.kind}</span>
                          {a.status === 'New' && (
                            <button className="btn btn-sm btn-outline-secondary rounded-pill py-0" onClick={() => ackAlert.mutate(a.id)}>Ack</button>
                          )}
                        </div>
                        <div className="small fw-semibold mt-1">{a.title}</div>
                        {a.detail && <div className="text-muted" style={{ fontSize: '0.72rem' }}>{a.detail}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Safety & workflow board */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: '16px' }}>
        <div className="card-header bg-white py-2 d-flex align-items-center justify-content-between">
          <h6 className="mb-0 fw-bold small"><i className="bi bi-shield-check me-1"></i>Safety &amp; Workflow</h6>
          <span className="badge bg-light text-dark border small">{wb?.tasks?.length || 0} open task(s)</span>
        </div>
        <div className="card-body">
          {!wb ? (
            <div className="text-center text-muted py-3 small">No workbench data.</div>
          ) : (
            <div className="row g-3">
              <div className="col-md-4">
                <h6 className="fw-bold small text-muted text-uppercase mb-2">My tasks</h6>
                {(!wb.tasks || wb.tasks.length === 0) ? (
                  <div className="text-muted small">No open tasks.</div>
                ) : (
                  <div className="list-group list-group-flush" style={{ maxHeight: '260px', overflowY: 'auto' }}>
                    {wb.tasks.map((t: any) => (
                      <div className="list-group-item px-0 d-flex justify-content-between align-items-start gap-2" key={t.id}>
                        <div>
                          <span className={`badge me-1 ${t.kind === 'escalation' ? 'bg-danger' : 'bg-secondary'}`}>{t.kind}</span>
                          <span className="small">{t.title}</span>
                          {t.row?.detail && <div className="text-muted" style={{ fontSize: '0.72rem' }}>{t.row.detail}</div>}
                        </div>
                        <button className="btn btn-sm btn-outline-success rounded-pill py-0" onClick={() => doneTask.mutate(t.id)}>Done</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="col-md-4">
                <h6 className="fw-bold small text-muted text-uppercase mb-2">Signals</h6>
                <div className="small mb-1">
                  <span className="badge bg-warning text-dark me-1">obs</span>{wb.vitalsDue?.length || 0} due/overdue
                  <span className="badge bg-danger ms-2 me-1">NEWS2</span>{wb.deterioration?.length || 0} worsening
                  <span className="badge bg-danger ms-2 me-1">sepsis</span>{wb.sepsis?.length || 0} screen positive
                </div>
                <div className="list-group list-group-flush" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                  {[
                    ...(wb.deterioration || []).map((d: any) => ({ ...d, label: 'NEWS2 ↑' })),
                    ...(wb.sepsis || []).map((s: any) => ({ ...s, label: 'Sepsis' })),
                    ...(wb.vitalsDue || []).map((v: any) => ({ ...v, label: 'Obs' })),
                  ].slice(0, 12).map((x: any, i: number) => (
                    <div className="list-group-item px-0 py-1" key={i} style={{ fontSize: '0.75rem' }}>
                      <span className="fw-semibold">{x.label}</span> {x.patient_name}
                      {x.room ? ` · Rm ${x.room}` : ''}
                      {x.flags?.length ? <span className="text-muted"> — {x.flags.join(', ')}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
              <div className="col-md-4">
                <h6 className="fw-bold small text-muted text-uppercase mb-2">Workload</h6>
                <table className="table table-sm mb-0 small">
                  <thead><tr><th>RN</th><th>Pts</th><th>Tasks</th></tr></thead>
                  <tbody>
                    {(wb.workload || []).map((w: any) => (
                      <tr key={w.id}><td>{w.name}</td><td>{w.patients}</td><td>{w.tasks}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="row g-3">
        {/* Patient list */}
        <div className="col-md-4">
          <div className="card border-0 shadow-sm h-100" style={{ borderRadius: '16px' }}>
            <div className="card-header bg-white py-2 d-flex align-items-center justify-content-between">
              <h6 className="mb-0 fw-bold small">Patients</h6>
              <span className="badge bg-primary rounded-pill">{patients.length}</span>
            </div>
            <div className="card-body p-2">
              <input className="form-control form-control-sm mb-2" placeholder="Search patients…" value={search} onChange={e => setSearch(e.target.value)} />
              <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                {patients.length === 0 ? (
                  <div className="text-center text-muted py-4 small">No patients.</div>
                ) : (
                  patients.map((p: any) => (
                    <button key={p.pid}
                      className={`btn w-100 text-start mb-1 rounded-3 ${selectedPatient?.pid === p.pid ? 'btn-primary' : 'btn-light border'}`}
                      onClick={() => setSelectedPatient(p)}>
                      <div className="d-flex justify-content-between align-items-center">
                        <span className="fw-semibold small">{formatPatientName(p)}</span>
                        <span className={`badge rounded-pill ${riskBadge(p.risk.level)}`}>{p.risk.level}</span>
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>Room {p.room || '—'} · NEWS2 {p.risk.total ?? '—'}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Detail */}
        <div className="col-md-8">
          {!selectedPatient ? (
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: '16px' }}>
              <div className="card-body d-flex align-items-center justify-content-center text-muted" style={{ minHeight: '300px' }}>
                <div className="text-center"><i className="bi bi-person-badge fs-1 d-block mb-2"></i>Select a patient to view assessments and documentation.</div>
              </div>
            </div>
          ) : (
            <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
              <div className="card-header bg-white py-2">
                <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
                  <h6 className="mb-0 fw-bold">{formatPatientName(selectedPatient)}</h6>
                  <div className="d-flex gap-1 align-items-center">
                    <button
                      className="btn btn-sm btn-outline-primary rounded-pill"
                      title="Hospitalize this patient and build their medication administration record"
                      onClick={() => {
                        const room = window.prompt(
                          `Room / bed for ${formatPatientName(selectedPatient)}?`,
                          selectedPatient.room || '',
                        );
                        if (room && room.trim()) admit.mutate({ pid: selectedPatient.pid, room: room.trim() });
                      }}
                    >
                      <i className="bi bi-hospital me-1"></i>Admit
                    </button>
                    {[
                      ['vitals', 'Vitals', 'bi-heart-pulse'],
                      ['meds', 'Medications', 'bi-capsule'],
                      ['plan', 'Care Plan', 'bi-clipboard-check'],
                      ['notes', 'Notes', 'bi-journal-text'],
                      ['safety', 'Safety', 'bi-shield-check'],
                      ['chart', 'Chart 360', 'bi-person-vcard'],
                    ].map(([id, label, icon]) => (
                      <button key={id} className={`btn btn-sm rounded-pill ${tab === id ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setTab(id)}>
                        <i className={`bi ${icon} me-1`}></i>{label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="card-body">
                {/* Vitals (read-only — patient vitals are recorded on the Nurse Aide dashboard) */}
                {tab === 'vitals' && (
                  <div className="card border-0 shadow-sm" style={{ borderRadius: '16px', maxHeight: '520px', overflowY: 'auto' }}>
                    <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Vital History</h6></div>
                    <div className="card-body p-0">
                      {vitalsHistory.length === 0 ? (
                        <div className="text-center text-muted py-4 small">No vitals recorded.</div>
                      ) : (
                        <table className="table table-sm table-hover mb-0 small">
                          <thead className="table-light"><tr><th>Time</th><th>BP</th><th>Pulse</th><th>Temp</th><th>SpO₂</th><th>NEWS2</th></tr></thead>
                          <tbody>
                            {vitalsHistory.map((v: any) => (
                              <tr key={v.id}>
                                <td>{fmtDate(v.date)}</td>
                                <td>
                                  {formatBP(v.bps, v.bpd)}{' '}
                                  {(() => {
                                    const bp = classifyBP(v.bps, v.bpd);
                                    return bp.category !== 'Normal' && bp.category !== '—'
                                      ? <span className="badge" style={{ backgroundColor: bp.color, color: '#fff' }}>{bp.category}</span>
                                      : null;
                                  })()}
                                </td>
                                <td>{formatVital(v.pulse)}</td>
                                <td>{formatVital(v.temperature, 1)}</td>
                                <td>{formatVital(v.oxygen_saturation)}</td>
                                <td>{computeNEWS2(toSnapshot(v)).total}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )}

                {/* Medications */}
                {tab === 'meds' && (
                  <div className="row g-3">
                    <div className="col-md-7">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Medication Administration Record (MAR)</h6></div>
                        <div className="card-body p-0">
                          {medications.length === 0 ? (
                            <div className="text-center text-muted py-4 small">No medications recorded.</div>
                          ) : (
                            <table className="table table-sm table-hover mb-0 small">
                              <thead className="table-light"><tr><th>Drug</th><th>Dosage</th><th>Route</th><th>Note</th></tr></thead>
                              <tbody>
                                {medications.map((m: any) => (
                                  <tr key={m.id}><td>{m.drug}</td><td>{m.dosage || '—'}</td><td>{m.route || '—'}</td><td>{m.note || '—'}</td></tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="col-md-5">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Allergies</h6></div>
                        <div className="card-body">
                          {allergies.length === 0 ? (
                            <div className="text-muted small">No known allergies.</div>
                          ) : (
                            allergies.map((a: any) => (
                              <span key={a.id} className="badge bg-danger bg-opacity-10 text-danger border me-1 mb-1">{a.allergen || a.title}</span>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Care Plan */}
                {tab === 'plan' && (
                  <div className="row g-3">
                    <div className="col-md-5">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Add Care Plan Entry</h6></div>
                        <div className="card-body">
                          <label className="form-label small mb-0">Plan</label>
                          <textarea className="form-control form-control-sm" rows={3} placeholder="e.g., Monitor SpO₂ every 2 hours…" value={planForm.description} onChange={e => setPlanForm({ ...planForm, description: e.target.value })} />
                          <label className="form-label small mt-2 mb-0">Type</label>
                          <select className="form-select form-select-sm" value={planForm.care_plan_type} onChange={e => setPlanForm({ ...planForm, care_plan_type: e.target.value })}>
                            <option value="nursing">Nursing</option><option value="dietary">Dietary</option><option value="mobility">Mobility</option><option value="discharge">Discharge</option>
                          </select>
                          <button className="btn btn-primary btn-sm rounded-pill w-100 mt-3" onClick={() => addCarePlan.mutate(planForm)} disabled={!planForm.description || addCarePlan.isPending}>
                            {addCarePlan.isPending ? 'Adding…' : <><i className="bi bi-plus-lg me-1"></i>Add to Plan</>}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="col-md-7">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Care Plan</h6></div>
                        <div className="card-body p-0">
                          {carePlan.length === 0 ? (
                            <div className="text-center text-muted py-4 small">No care plan entries.</div>
                          ) : (
                            <div className="list-group list-group-flush">
                              {carePlan.map((c: any) => (
                                <div className="list-group-item" key={c.id}>
                                  <div className="d-flex justify-content-between">
                                    <span className="fw-semibold small">{c.description}</span>
                                    <span className="badge bg-light text-dark border small">{c.care_plan_type}</span>
                                  </div>
                                  <div className="text-muted" style={{ fontSize: '0.72rem' }}>{fmtDate(c.date)} · {c.plan_status}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Patient 360 & checklists */}
                {tab === 'chart' && (
                  <div className="row g-3">
                    <div className="col-md-6">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Patient 360</h6></div>
                        <div className="card-body small">
                          {!patient360.data ? <div className="text-muted">Loading…</div> : (
                            <>
                              <div className="mb-1">
                                <span className="badge bg-secondary me-1">Room</span>{patient360.data.patient?.room || '—'}
                                <span className="badge bg-secondary ms-2 me-1">LOS</span>{patient360.data.patient?.los_days ?? '—'}d
                                <span className="badge bg-secondary ms-2 me-1">NEWS2</span>{patient360.data.news2 ?? '—'}
                              </div>
                              <div className="mb-1"><span className="badge bg-secondary me-1">Provider</span>{patient360.data.patient?.provider_name || '—'}</div>
                              <div className="mb-1"><span className="badge bg-danger me-1">Allergies</span>{patient360.data.allergies?.length ? patient360.data.allergies.join(', ') : 'None recorded'}</div>
                              <div className="mb-1"><span className="badge bg-info text-dark me-1">Problems</span>{patient360.data.problems?.length ? patient360.data.problems.join(', ') : 'None recorded'}</div>
                              <div className="text-muted">Active meds: {patient360.data.counts?.meds ?? 0}</div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Admission checklist</h6></div>
                        <div className="card-body small">
                          {(admissionList.data?.items || []).map((i: any) => (
                            <div key={i.key} className="d-flex align-items-center gap-2">
                              <i className={`bi ${i.done ? 'bi-check-circle-fill text-success' : 'bi-circle text-muted'}`}></i>
                              <span className={i.done ? '' : 'text-muted'}>{i.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Discharge checklist</h6></div>
                        <div className="card-body small">
                          {(dischargeList.data?.items || []).map((i: any) => (
                            <div key={i.key} className="d-flex align-items-center gap-2">
                              <i className={`bi ${i.done ? 'bi-check-circle-fill text-success' : 'bi-circle text-muted'}`}></i>
                              <span className={i.done ? '' : 'text-muted'}>{i.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Safety & workflow */}
                {tab === 'safety' && (
                  <div className="row g-3">
                    <div className="col-md-6">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Code status &amp; isolation</h6></div>
                        <div className="card-body">
                          <label className="form-label small mb-1">Code status</label>
                          <input className="form-control form-control-sm mb-2" value={flagsForm.codeStatus} onChange={e => setFlagsForm({ ...flagsForm, codeStatus: e.target.value })} placeholder="Full / DNAR / …" />
                          <label className="form-label small mb-1">Isolation</label>
                          <input className="form-control form-control-sm mb-2" value={flagsForm.isolation} onChange={e => setFlagsForm({ ...flagsForm, isolation: e.target.value })} placeholder="None / contact / droplet…" />
                          <button className="btn btn-sm btn-primary rounded-pill" onClick={() => saveFlags.mutate(flagsForm)}>Save flags</button>
                          <div className="small mt-2">
                            <span className="badge bg-secondary me-1">Fall</span>{patientSafety.data?.fall ? `${patientSafety.data.fall.level} (${patientSafety.data.fall.score})` : 'not assessed'}
                            <span className="badge bg-secondary ms-2 me-1">Braden</span>{patientSafety.data?.braden ? `${patientSafety.data.braden.level} (${patientSafety.data.braden.score})` : 'not assessed'}
                          </div>
                        </div>
                      </div>
                      <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Risk assessments</h6></div>
                        <div className="card-body small">
                          <div className="fw-semibold mb-1">Fall risk (Morse)</div>
                          <div className="d-flex flex-wrap gap-3 mb-2">
                            <label className="form-check"><input className="form-check-input" type="checkbox" checked={fallForm.historyOfFalling} onChange={e => setFallForm({ ...fallForm, historyOfFalling: e.target.checked })} /><span className="form-check-label">Fell before</span></label>
                            <label className="form-check"><input className="form-check-input" type="checkbox" checked={fallForm.ivLine} onChange={e => setFallForm({ ...fallForm, ivLine: e.target.checked })} /><span className="form-check-label">IV line</span></label>
                            <label className="form-check"><input className="form-check-input" type="checkbox" checked={fallForm.impairedJudgement} onChange={e => setFallForm({ ...fallForm, impairedJudgement: e.target.checked })} /><span className="form-check-label">Impaired judgement</span></label>
                          </div>
                          <div className="d-flex gap-1 mb-3">
                            <select className="form-select form-select-sm" value={fallForm.gait} onChange={e => setFallForm({ ...fallForm, gait: Number(e.target.value) })}>
                              <option value={0}>Gait: normal</option><option value={10}>Gait: weak</option><option value={20}>Gait: impaired</option>
                            </select>
                            <select className="form-select form-select-sm" value={fallForm.ambulatoryAid} onChange={e => setFallForm({ ...fallForm, ambulatoryAid: Number(e.target.value) })}>
                              <option value={0}>Aid: none</option><option value={15}>Aid: cane/walker</option><option value={30}>Aid: furniture</option>
                            </select>
                            <button className="btn btn-sm btn-outline-primary rounded-pill" onClick={() => saveFall.mutate(fallForm)}>Score</button>
                          </div>
                          <div className="fw-semibold mb-1">Pressure injury (Braden)</div>
                          <div className="d-flex flex-wrap gap-1 align-items-center">
                            {['sensoryPerception', 'moisture', 'activity', 'mobility', 'nutrition', 'frictionShear'].map((k) => (
                              <select key={k} className="form-select form-select-sm" style={{ maxWidth: '110px' }} value={bradenForm[k]} onChange={e => setBradenForm({ ...bradenForm, [k]: Number(e.target.value) })}>
                                <option value={4}>4</option><option value={3}>3</option><option value={2}>2</option><option value={1}>1</option>
                              </select>
                            ))}
                            <button className="btn btn-sm btn-outline-primary rounded-pill" onClick={() => saveBraden.mutate(bradenForm)}>Score</button>
                          </div>
                        </div>
                      </div>
                      <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Escalate</h6></div>
                        <div className="card-body">
                          <textarea className="form-control form-control-sm mb-2" rows={2} placeholder="Reason for escalation…" value={escalateReason} onChange={e => setEscalateReason(e.target.value)} />
                          <button className="btn btn-sm btn-danger rounded-pill w-100" disabled={!escalateReason.trim() || escalatePt.isPending} onClick={() => escalatePt.mutate(escalateReason)}>
                            <i className="bi bi-exclamation-octagon me-1"></i>Escalate patient
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2 d-flex justify-content-between align-items-center">
                          <h6 className="mb-0 fw-bold small">Fluid balance (24h)</h6>
                          <span className="badge bg-light text-dark border small">{patientIO.data?.balance ? `net ${patientIO.data.balance.netMl} ml` : '—'}</span>
                        </div>
                        <div className="card-body">
                          <div className="d-flex gap-1 mb-2">
                            <select className="form-select form-select-sm" value={ioForm.kind} onChange={e => setIoForm({ ...ioForm, kind: e.target.value })}>
                              <option value="intake">Intake</option><option value="output">Output</option>
                            </select>
                            <input className="form-control form-control-sm" style={{ maxWidth: '90px' }} placeholder="ml" value={ioForm.volumeMl} onChange={e => setIoForm({ ...ioForm, volumeMl: e.target.value })} />
                            <input className="form-control form-control-sm" placeholder="category" value={ioForm.category} onChange={e => setIoForm({ ...ioForm, category: e.target.value })} />
                            <button className="btn btn-sm btn-primary rounded-pill" disabled={!ioForm.volumeMl || addIo.isPending} onClick={() => addIo.mutate({ kind: ioForm.kind, volumeMl: Number(ioForm.volumeMl), category: ioForm.category, note: ioForm.note })}>Add</button>
                          </div>
                          <div style={{ maxHeight: '140px', overflowY: 'auto' }} className="small">
                            {(patientIO.data?.entries || []).map((e: any) => (
                              <div key={e.id} className="d-flex justify-content-between">
                                <span>{e.kind} {e.category || ''} {e.volume_ml} ml</span>
                                <span className="text-muted">{e.recorded_at}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2 d-flex justify-content-between align-items-center">
                          <h6 className="mb-0 fw-bold small">Handover (SBAR)</h6>
                          <button className="btn btn-sm btn-outline-primary rounded-pill" onClick={() => loadHandover.mutate()} disabled={loadHandover.isPending}>Generate</button>
                        </div>
                        <div className="card-body">
                          <pre className="small mb-0" style={{ whiteSpace: 'pre-wrap' }}>{handover?.text || 'Click Generate to build an SBAR from the chart.'}</pre>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Notes */}
                {tab === 'notes' && (
                  <div className="row g-3">
                    <div className="col-md-5">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Add RN Note</h6></div>
                        <div className="card-body">
                          <input className="form-control form-control-sm mb-2" placeholder="Title" value={noteForm.title} onChange={e => setNoteForm({ ...noteForm, title: e.target.value })} />
                          <textarea className="form-control form-control-sm" rows={4} placeholder="RN assessment…" value={noteForm.note} onChange={e => setNoteForm({ ...noteForm, note: e.target.value })} />
                          <button className="btn btn-primary btn-sm rounded-pill w-100 mt-2" onClick={() => addNote.mutate(noteForm)} disabled={!noteForm.note || addNote.isPending}>
                            {addNote.isPending ? 'Saving…' : <><i className="bi bi-journal-plus me-1"></i>Add RN Note</>}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="col-md-7">
                      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px', maxHeight: '480px', overflowY: 'auto' }}>
                        <div className="card-header bg-white py-2"><h6 className="mb-0 fw-bold small">Clinical Notes</h6></div>
                        <div className="card-body p-0">
                          {notes.length === 0 ? (
                            <div className="text-center text-muted py-4 small">No notes.</div>
                          ) : (
                            <div className="list-group list-group-flush">
                              {notes.map((n: any) => (
                                <div className="list-group-item" key={n.id}>
                                  <div className="d-flex justify-content-between">
                                    <span className="fw-semibold small">{n.title || 'Note'}</span>
                                    <span className="text-muted" style={{ fontSize: '0.7rem' }}>{fmtDate(n.date)}</span>
                                  </div>
                                  <div className="small text-muted">{n.body}</div>
                                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>By {n.author_name || n.user || '—'}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bedside administration modal — the smart safety check runs server-side */}
      {giveOrder && (
        <div className="modal fade show d-block" tabIndex={-1} role="dialog" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="modal-dialog modal-dialog-centered" role="document">
            <div className="modal-content" style={{ borderRadius: '16px' }}>
              <div className="modal-header">
                <h6 className="modal-title fw-bold">
                  Administer — {giveOrder.drug}
                  {giveOrder.high_alert && <span className="badge bg-danger ms-2">High-alert</span>}
                </h6>
                <button type="button" className="btn-close" onClick={() => { setGiveOrder(null); setGiveIssues([]); }}></button>
              </div>
              <div className="modal-body">
                <div className="small text-muted mb-2">
                  {giveOrder.patient_name} · Room {giveOrder.room || '—'} · {giveOrder.dose || '—'} · {giveOrder.route || '—'}
                </div>

                {giveIssues.length > 0 && (
                  <div className="alert alert-danger py-2 small mb-2">
                    <div className="fw-semibold mb-1">Safety check requires attention:</div>
                    <ul className="mb-0 ps-3">
                      {giveIssues.map((i: any, idx: number) => (<li key={idx}>{i.message}</li>))}
                    </ul>
                  </div>
                )}

                <label className="form-label small mb-1">
                  Override reason {giveIssues.length > 0 ? '(required to proceed)' : '(optional)'}
                </label>
                <input className="form-control form-control-sm mb-2" value={giveForm.overrideReason}
                  onChange={e => setGiveForm({ ...giveForm, overrideReason: e.target.value })}
                  placeholder="Clinical justification if overriding a hard stop" />

                <div className="row g-2 mb-2">
                  <div className="col-6">
                    <label className="form-label small mb-1">Scan wristband</label>
                    <input className="form-control form-control-sm" value={giveForm.patientBarcode}
                      onChange={e => setGiveForm({ ...giveForm, patientBarcode: e.target.value })} placeholder="Two-identifier check" />
                  </div>
                  <div className="col-6">
                    <label className="form-label small mb-1">Scan drug</label>
                    <input className="form-control form-control-sm" value={giveForm.drugBarcode}
                      onChange={e => setGiveForm({ ...giveForm, drugBarcode: e.target.value })} placeholder="Drug barcode" />
                  </div>
                </div>

                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label small mb-1">Witness (staff id)</label>
                    <input className="form-control form-control-sm" value={giveForm.witnessBy}
                      onChange={e => setGiveForm({ ...giveForm, witnessBy: e.target.value })} placeholder="For high-alert meds" />
                  </div>
                  <div className="col-6">
                    <label className="form-label small mb-1">Note</label>
                    <input className="form-control form-control-sm" value={giveForm.notes}
                      onChange={e => setGiveForm({ ...giveForm, notes: e.target.value })} placeholder="Site, reaction…" />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-sm btn-outline-secondary rounded-pill" onClick={() => { setGiveOrder(null); setGiveIssues([]); }}>Cancel</button>
                <button className="btn btn-sm btn-primary rounded-pill" disabled={giveMed.isPending} onClick={() => giveMed.mutate(giveOrder)}>
                  {giveMed.isPending ? 'Recording…' : <><i className="bi bi-check2-circle me-1"></i>Confirm administration</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
