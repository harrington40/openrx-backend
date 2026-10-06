import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { criticalFlags } from '../../utils/nursingSafety';
import { getPatient } from '../../api/endpoints/patients';
import { getPatientAllergies } from '../../api/endpoints/allergies';
import { getPatientMedications } from '../../api/endpoints/medications';
import { getPatientInsurance } from '../../api/endpoints/insurance';
import { getPatientConditions } from '../../api/endpoints/conditions';
import { getPatientImmunizations } from '../../api/endpoints/immunizations';
import SummaryTab from './tabs/SummaryTab';
import DemographicsTab from './tabs/DemographicsTab';
import InsuranceTab from './tabs/InsuranceTab';
import AllergiesTab from './tabs/AllergiesTab';
import MedicationsTab from './tabs/MedicationsTab';
import ConditionsTab from './tabs/ConditionsTab';
import ImmunizationsTab from './tabs/ImmunizationsTab';
import VitalsTab from './tabs/VitalsTab';
import MaternityTab from './tabs/MaternityTab';
import QuickAssign from './components/QuickAssign';
import NotesTab from './tabs/NotesTab';
import ObservationsTab from './tabs/ObservationsTab';
import nestClient from '../../api/nest-client';
import { formatPatientName, formatPatientNameLastFirst } from '../../utils/patientName';
import { formatDateOnly } from '../../utils/date';
import Barcode from '../../components/shared/Barcode';
import EmergencyTab from './tabs/EmergencyTab';
import { emergencyBanner } from '../../utils/triage';

type TabId = 'summary' | 'observations' | 'notes' | 'vitals' | 'allergies' | 'medications' | 'conditions' | 'immunizations' | 'demographics' | 'insurance' | 'maternity' | 'triage';

const tabs: { id: TabId; label: string; icon: string; color: string }[] = [
  { id: 'summary', label: 'Overview', icon: 'bi-person-vcard', color: '#0d6efd' },
  { id: 'observations', label: 'Observations', icon: 'bi-journal-check', color: '#198754' },
  { id: 'notes', label: 'Notes', icon: 'bi-pencil-square', color: '#e83e8c' },
  { id: 'vitals', label: 'Vitals', icon: 'bi-heart-pulse', color: '#dc3545' },
  { id: 'maternity', label: 'Maternity', icon: 'bi-clipboard-heart', color: '#d63384' },
  { id: 'triage', label: 'Emergency', icon: 'bi-clipboard2-pulse', color: '#fd7e14' },
  { id: 'allergies', label: 'Allergies', icon: 'bi-exclamation-triangle', color: '#fd7e14' },
  { id: 'medications', label: 'Medications', icon: 'bi-capsule', color: '#6f42c1' },
  { id: 'conditions', label: 'Diagnoses', icon: 'bi-clipboard2-pulse', color: '#0dcaf0' },
  { id: 'immunizations', label: 'Immunizations', icon: 'bi-syringe', color: '#198754' },
  { id: 'demographics', label: 'Demographics', icon: 'bi-person-lines-fill', color: '#6c757d' },
  { id: 'insurance', label: 'Insurance', icon: 'bi-shield-check', color: '#20c997' },
];

export default function PatientDetailPage() {
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabId>('summary');
  const queryClient = useQueryClient();

  // Access control: registrar and billing need admin-granted privilege
  const canViewChart = user?.role === 'admin' || user?.role === 'physician' || user?.role === 'nurse' ||
    (user?.role === 'billing' && user?.can_view_charts === true) ||
    (user?.role === 'front_desk' && user?.can_view_charts === true) ||
    (user?.role === 'midwife') || (user?.role === 'lab_tech');

  // Registered nurses have read-only chart access (notes excluded).
  const isNurse = user?.role === 'nurse';

  // Doctor / registered nurse / admin can share (or unshare) the chart with nursing.
  const shareChart = useMutation({
    mutationFn: async (shared: boolean) => nestClient.post(`/patients/${id}/share-chart`, { shared }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patient', id] }),
  });

  if (!canViewChart) {
    return (
      <div className="d-flex align-items-center justify-content-center" style={{ minHeight: '60vh' }}>
        <div className="text-center">
          <i className="bi bi-shield-lock fs-1 d-block mb-3 text-danger opacity-50"></i>
          <h5 className="fw-bold">Access Restricted</h5>
          <p className="text-muted">
            {user?.role === 'front_desk'
              ? 'Registrars do not have access to patient charts.'
              : 'You do not have permission to view patient charts. Please contact an administrator.'}
          </p>
          <button className="btn btn-primary rounded-pill" onClick={() => navigate(-1)}>
            <i className="bi bi-arrow-left me-1"></i>Go Back
          </button>
        </div>
      </div>
    );
  }

  const { data: patient, isLoading, error } = useQuery({ queryKey: ['patient', id], queryFn: () => getPatient(id!), enabled: !!id });
  const { data: allergies } = useQuery({ queryKey: ['patient', id, 'allergies'], queryFn: () => getPatientAllergies(String(patient?.pid ?? id)), enabled: !!patient?.pid });
  const { data: enrichedAllergies } = useQuery({
    queryKey: ['patient', id, 'allergies-enriched'],
    queryFn: async () => { const r = await nestClient.get(`/patients/${patient?.pid ?? id}/allergies/enriched`); return r.data; },
    enabled: !!patient?.pid,
  });
  const { data: medications } = useQuery({ queryKey: ['patient', id, 'medications'], queryFn: () => getPatientMedications(String(patient?.pid ?? id)), enabled: !!patient?.pid });
  const { data: insurance } = useQuery({ queryKey: ['patient', id, 'insurance'], queryFn: () => getPatientInsurance(String(patient?.pid ?? id)), enabled: !!patient?.pid && activeTab === 'insurance' });
  const { data: conditions } = useQuery({ queryKey: ['patient', id, 'conditions'], queryFn: () => getPatientConditions(String(patient?.pid ?? id)), enabled: !!patient?.pid });
  const { data: immunizations } = useQuery({ queryKey: ['patient', id, 'immunizations'], queryFn: () => getPatientImmunizations(String(patient?.pid ?? id)), enabled: !!patient?.pid && activeTab === 'immunizations' });
  const { data: vitals } = useQuery({ queryKey: ['patient', id, 'vitals'], queryFn: async () => { const r = await nestClient.get(`/patients/${patient?.pid ?? id}/vitals`); return r.data; }, enabled: !!patient?.pid });
  const { data: notes } = useQuery({ queryKey: ['patient', id, 'notes'], queryFn: async () => { const r = await nestClient.get(`/patients/${patient?.pid ?? id}/notes`); return r.data; }, enabled: !!patient?.pid });
  const { data: labOrders } = useQuery({ queryKey: ['patient', id, 'procedures'], queryFn: async () => { const r = await nestClient.get(`/patients/${patient?.pid ?? id}/procedures`); return r.data; }, enabled: !!patient?.pid });
  // Patient-scoped lab results — this is the chart source, so validated results
  // released by the lab appear here immediately.
  const { data: labResults } = useQuery({
    queryKey: ['patient', id, 'lab-results'],
    queryFn: async () => {
      const r = await nestClient.get(`/lab/patients/${patient?.pid ?? id}/results`, { params: { limit: 100 } });
      return r.data;
    },
    enabled: !!patient?.pid,
  });

  if (isLoading) return <div className="text-center py-5"><div className="spinner-grow text-primary" style={{ width: '3rem', height: '3rem' }} /><p className="text-muted mt-2">Loading chart...</p></div>;
  if (error || !patient) {
    // Distinguish "no patient reference at all" from "that patient is gone" so a
    // broken link (e.g. /patients/0) reads clearly instead of a bare failure.
    const numericId = Number(id);
    const invalidId = !id || !Number.isFinite(numericId) || numericId <= 0;
    return (
      <div className="text-center py-5">
        <i className="bi bi-exclamation-triangle fs-1 text-danger"></i>
        <h5>{invalidId ? 'No patient selected' : 'Patient not found'}</h5>
        <p className="text-muted small mb-0">
          {invalidId
            ? 'This link did not contain a valid patient reference.'
            : `The chart for patient #${id} could not be loaded.`}
        </p>
        <button className="btn btn-outline-primary rounded-pill mt-3" onClick={() => navigate('/patients')}>
          <i className="bi bi-arrow-left me-1"></i>Back to patients
        </button>
      </div>
    );
  }

  const initials = `${patient.fname?.[0] || ''}${patient.lname?.[0] || ''}`;
  const age = patient.dob ? Math.floor((Date.now() - new Date(patient.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null;

  // Emergency: surface the tab (and the in-department banner) only when the
  // chart actually has triage history — an always-present empty tab is clutter.
  const emergency = (patient as any)?.emergency as { total?: number } | undefined;
  const hasEmergency = (emergency?.total || 0) > 0;
  const banner = emergencyBanner(emergency);
  const visibleTabs = tabs.filter((t) => (t.id === 'triage' ? hasEmergency : true));

  // ── Clinical safety algorithm (error prevention) ─────────────────────────
  const latestVital = (vitals || [])[0];
  const vitalFlags = (() => {
    if (!latestVital) return [];
    const t = Number(latestVital.temperature);
    const tempC = Number.isFinite(t) && t > 45 ? Math.round(((t - 32) * 5 / 9) * 10) / 10 : (Number.isFinite(t) ? t : null);
    return criticalFlags({
      bps: latestVital.bps, bpd: latestVital.bpd, pulse: latestVital.pulse,
      temperature: tempC, respiration: latestVital.respiration,
      oxygen_saturation: latestVital.oxygen_saturation,
    });
  })();

  const allergyList = (enrichedAllergies && enrichedAllergies.length) ? enrichedAllergies : (allergies || []);
  const allergyNames = (allergyList as any[]).map((a: any) => String(a.allergen || a.title || '').toLowerCase()).filter(Boolean);
  const drugAllergyWarnings = (medications || []).filter((m: any) => {
    const drug = String(m.drug || '').toLowerCase();
    return allergyNames.some(a => drug.includes(a));
  });
  const polypharmacy = (medications || []).length >= 5;
  const safetyAlerts = [
    ...(allergyList as any[]).map((a: any) => ({ severity: 'danger', icon: 'bi-exclamation-triangle', text: `Allergy: ${a.allergen || a.title}` })),
    ...drugAllergyWarnings.map((m: any) => ({ severity: 'danger', icon: 'bi-capsule', text: `Drug-allergy interaction: ${m.drug}` })),
    ...vitalFlags.map((f: any) => ({ severity: f.severity === 'critical' ? 'danger' : 'warning', icon: 'bi-heart-pulse', text: `${f.label} — ${f.action}` })),
    ...(polypharmacy ? [{ severity: 'warning', icon: 'bi-capsule-pill', text: `Polypharmacy: ${(medications || []).length} active medications` }] : []),
  ];

  // Theme color of the currently-selected chart tab.
  const activeColor = (tabs.find((t) => t.id === activeTab) || tabs[0]).color;

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
        .glass-page .list-group-item {
          background: transparent !important;
        }
        .glass-page .table thead.table-light {
          background: rgba(255,255,255,0.35) !important;
        }
      `}</style>
      <div className="rounded-4 p-4 mb-4 text-white position-relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #0d6efd 0%, #4b2d8e 40%, #6f42c1 70%, #e83e8c 100%)', zIndex: 1 }}>
        <div className="position-absolute end-0 top-0 opacity-10" style={{ fontSize: '8rem', transform: 'rotate(10deg) translate(30px,-10px)' }}><i className="bi bi-clipboard2-pulse"></i></div>
        <div className="position-relative">
          <div className="d-flex align-items-start gap-4 flex-wrap">
            <div className="flex-shrink-0">
              {/* Initials only. The avatars table is keyed by users.id, so asking
                  it for a patient returned whichever staff member happened to
                  share that id — patient 8 was showing the registrar's photo. */}
              <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold shadow" style={{ width: '88px', height: '88px', fontSize: '2rem', background: 'rgba(255,255,255,0.2)', border: '3px solid rgba(255,255,255,0.4)' }}>{initials}</div>
            </div>
            <div className="flex-grow-1">
              <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                <div>
                  <h3 className="mb-1 fw-bold">{formatPatientNameLastFirst(patient)}</h3>
                  <div className="d-flex flex-wrap gap-2 align-items-center">
                    <span className="badge bg-white bg-opacity-25 rounded-pill"><i className="bi bi-cake2 me-1"></i>{formatDateOnly((patient as any).DOB || patient.dob)} {age != null && `(${age}y)`}</span>
                    <span className="badge bg-white bg-opacity-25 rounded-pill"><i className="bi bi-gender-ambiguous me-1"></i>{patient.sex || '—'}</span>
                    <span className="badge bg-white bg-opacity-25 rounded-pill"><i className="bi bi-upc me-1"></i>PID: {patient.pid ?? patient.uuid?.substring(0, 8)}</span>
                    {patient.public_id && <span className="badge bg-white bg-opacity-25 rounded-pill"><i className="bi bi-person-badge me-1"></i>Chart #: {patient.public_id}</span>}
                    {((patient as any).providerName || patient.provider_name) && <span className="badge bg-white bg-opacity-25 rounded-pill"><i className="bi bi-person-check me-1"></i>{(patient as any).providerName || patient.provider_name}</span>}
                  </div>
                </div>
                <div className="d-flex gap-2 flex-wrap">
                  <button className="btn btn-light btn-sm rounded-pill" onClick={() => navigate(`/patients/${id}/screening`)}><i className="bi bi-clipboard2-pulse me-1"></i>Screening</button>
                  <button className="btn btn-light btn-sm rounded-pill" onClick={() => navigate(`/patients/${id}/encounters`)}><i className="bi bi-file-medical me-1"></i>Encounters</button>
                  {(user?.role === 'physician' || user?.role === 'admin' || user?.role === 'nurse') && (
                    <button className={`btn btn-sm rounded-pill ${patient.chart_shared ? 'btn-warning' : 'btn-outline-warning'}`}
                      onClick={() => shareChart.mutate(!patient.chart_shared)}>
                      <i className="bi bi-share me-1"></i>{patient.chart_shared ? 'Unshare Chart' : 'Share with Nursing'}
                    </button>
                  )}
                  <button className="btn btn-warning btn-sm rounded-pill fw-semibold" onClick={() => navigate(user?.role === 'nurse' ? '/nurse-dashboard' : '/provider-dashboard')}><i className="bi bi-check-lg me-1"></i>Done</button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 p-2 rounded-3 d-inline-block" style={{ background: 'rgba(255,255,255,0.92)' }}>
            <Barcode seed={patient.public_id || `PID-${patient.pid ?? id}`} width={150} />
            <div className="text-dark text-center" style={{ fontSize: '0.65rem', letterSpacing: 1 }}>
              {patient.public_id || `PID-${patient.pid ?? id}`}
            </div>
          </div>
        </div>
      </div>

      {/* Registration completeness — a yellow flag until the registrar has the
          full demographics and the patient is assigned to a provider. */}
      {patient.chart_complete === false && (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: '16px', borderLeft: '4px solid #ffc107', background: 'rgba(255, 193, 7, 0.12)' }}>
          <div className="card-body py-2 px-3">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <i className="bi bi-exclamation-triangle-fill text-warning fs-5"></i>
              <strong className="small">Chart incomplete</strong>
              {(() => {
                // Distinguish "not approved yet" from "approved but a registration
                // detail is still blank" — reporting the latter as "No provider
                // assigned" would be wrong once a provider is on the chart.
                const missingProvider = (patient.missing_fields || []).includes('Assigned provider');
                if (patient.status === 'pending') {
                  return <span className="badge bg-warning text-dark rounded-pill" style={{ fontSize: '0.7rem' }}>Awaiting registrar approval</span>;
                }
                if (missingProvider) {
                  return <span className="badge bg-warning text-dark rounded-pill" style={{ fontSize: '0.7rem' }}>No provider assigned</span>;
                }
                return <span className="badge bg-warning text-dark rounded-pill" style={{ fontSize: '0.7rem' }}>Registration details outstanding</span>;
              })()}
              {(patient.missing_fields?.length ?? 0) > 0 && (
                <span className="small text-dark">
                  Still needed: <strong>{patient.missing_fields!.join(', ')}</strong>
                </span>
              )}
              <button className="btn btn-warning btn-sm rounded-pill ms-auto"
                onClick={() => setActiveTab('demographics')}>
                <i className="bi bi-pencil-square me-1"></i>Complete Chart
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clinical safety alerts — error prevention */}
      {safetyAlerts.length > 0 && (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: '16px', borderLeft: '4px solid #dc3545' }}>
          <div className="card-body py-2 px-3">
            <div className="d-flex align-items-center gap-2 mb-1">
              <i className="bi bi-shield-exclamation text-danger"></i>
              <strong className="small">Clinical Safety Alerts</strong>
              <span className="badge bg-danger rounded-pill">{safetyAlerts.length}</span>
            </div>
            <div className="d-flex flex-wrap gap-2">
              {safetyAlerts.map((a: any, i: number) => (
                <span key={i} className={`badge ${a.severity === 'danger' ? 'bg-danger bg-opacity-10 text-danger' : 'bg-warning bg-opacity-10 text-dark'} border`}
                  style={{ fontSize: '0.72rem', fontWeight: 500 }}>
                  <i className={`bi ${a.icon} me-1`}></i>{a.text}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <QuickAssign patientId={id!} currentProviderId={patient.provider != null ? String(patient.provider) : undefined} currentProviderName={patient.provider_name || patient.providerName} />

      {/* Emergency banner: shown only while the patient is actually in the
          department. Silence for past attendances — those live in the tab. */}
      {banner && (
        <div className="alert mb-3 d-flex flex-wrap align-items-center gap-2"
          style={{ borderLeft: `8px solid ${banner.color}`, background: `${banner.color}18` }} role="status">
          <i className="bi bi-heart-pulse-fill" style={{ color: banner.color, fontSize: '1.3rem' }}></i>
          <div className="flex-grow-1">
            <div className="fw-bold">{banner.headline}</div>
            <div className="small text-muted">{banner.detail}</div>
            <div className="small fw-semibold mt-1">{banner.action}</div>
          </div>
          <button className="btn btn-sm btn-outline-secondary rounded-pill" onClick={() => setActiveTab('triage')}>
            <i className="bi bi-clock-history me-1"></i>Triage history
          </button>
          <button className="btn btn-sm btn-outline-danger rounded-pill" onClick={() => navigate('/emergency')}>
            <i className="bi bi-box-arrow-up-right me-1"></i>Open the board
          </button>
        </div>
      )}

      <div className="row g-3">
        <div className="col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: '20px', overflow: 'hidden' }}>
            <div className="card-header bg-white py-3" style={{ borderRadius: '20px 20px 0 0', borderBottom: `2px solid ${activeColor}40` }}>
              <h6 className="mb-0 fw-bold"><i className="bi bi-journal-medical me-2" style={{ color: activeColor }}></i>Medical Chart</h6>
            </div>
            <div className="list-group list-group-flush" style={{ boxShadow: `inset 0 0 0 2px ${activeColor}26` }}>
              {visibleTabs.map((tab) => (
                <button key={tab.id} className={`list-group-item list-group-item-action border-0 d-flex align-items-center gap-3 py-3 px-3 ${activeTab === tab.id ? 'active' : ''}`}
                  style={{
                    borderLeft: `4px solid ${activeTab === tab.id ? tab.color : 'transparent'}`,
                    background: activeTab === tab.id ? `${tab.color}33` : 'transparent',
                    boxShadow: activeTab === tab.id ? `inset 0 0 0 1px ${tab.color}40` : 'none',
                    transition: 'all 0.15s',
                  }}
                  onClick={() => setActiveTab(tab.id)}>
                  <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0"
                    style={{ width: '36px', height: '36px', backgroundColor: activeTab === tab.id ? tab.color : `${tab.color}18` }}>
                    <i className={`bi ${tab.icon}`} style={{ color: activeTab === tab.id ? '#fff' : tab.color, fontSize: '0.9rem' }}></i>
                  </div>
                  <span className="small" style={{ color: activeTab === tab.id ? tab.color : '#212529', fontWeight: activeTab === tab.id ? 700 : 600 }}>{tab.label}</span>
                  {activeTab === tab.id && <i className="bi bi-chevron-right ms-auto" style={{ color: tab.color }}></i>}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="col-lg-9">
          <div className="card border-0 shadow-sm" style={{ borderRadius: '20px', minHeight: '500px', overflow: 'hidden' }}>
            <div style={{ height: '6px', background: `linear-gradient(90deg, ${activeColor}, ${activeColor}55)` }} />
            <div className="card-body p-4" style={{ boxShadow: `inset 0 0 0 1px ${activeColor}33` }}>
              {activeTab === 'summary' && <SummaryTab patient={patient} patientId={String(patient.pid)} patientName={formatPatientName(patient)} allergies={allergies || []} allergiesEnriched={enrichedAllergies || []} medications={medications || []} conditions={conditions || []} vitals={vitals || []} notes={notes || []} labOrders={labOrders || []} labResults={labResults || []} onViewTrend={() => setActiveTab('vitals')} />}
              {activeTab === 'observations' && <ObservationsTab patientId={String(patient.pid)} patientName={formatPatientName(patient)} readOnly={isNurse} />}
              {activeTab === 'notes' && <NotesTab patientId={String(patient.pid)} patientName={formatPatientName(patient)} patientAge={age} conditions={conditions || []} medications={medications || []} allergies={allergies || []} />}
              {activeTab === 'demographics' && <DemographicsTab patient={patient} />}
              {activeTab === 'vitals' && <VitalsTab vitals={vitals || []} patientId={String(patient.pid)} />}
              {activeTab === 'maternity' && <MaternityTab pid={String(patient.pid)} />}
              {activeTab === 'triage' && <EmergencyTab pid={String(patient.pid)} />}
              {activeTab === 'allergies' && <AllergiesTab patientId={String(patient.pid)} allergies={allergies || []} enriched={enrichedAllergies || []} readOnly={isNurse} />}
              {activeTab === 'medications' && <MedicationsTab patientId={String(patient.pid)} medications={medications || []} allergies={allergies || []} conditions={conditions || []} readOnly={isNurse} />}
              {activeTab === 'conditions' && <ConditionsTab patientId={String(patient.pid)} conditions={conditions || []} readOnly={isNurse} />}
              {activeTab === 'immunizations' && <ImmunizationsTab patientId={String(patient.pid)} immunizations={immunizations || []} readOnly={isNurse} />}
              {activeTab === 'insurance' && <InsuranceTab insurance={insurance || []} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
