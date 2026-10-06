import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDebounce } from '../../hooks/useDebounce';
import { searchPatients, createPatient } from '../../api/endpoints/patients';
import nestClient from '../../api/nest-client';
import PhoneInput from '../../components/shared/PhoneInput';
import CitySelect from '../../components/shared/CitySelect';
import { isInvalidLiberiaNationalNumber } from '../../utils/liberia';
import type { Patient } from '../../types/patient';
import { formatPatientName, formatPatientNameLastFirst } from '../../utils/patientName';
import { formatDateOnly } from '../../utils/date';
import { chartPatientId } from '../../utils/patientChart';

const emptyForm = { fname: '', lname: '', mname: '', DOB: '', sex: '', email: '', phone_contact: '', street: '', city: '', providerID: '' };

export default function PatientSearchPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [step, setStep] = useState(1);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  /**
   * Registering a second record for someone who already exists is blocked by
   * default; this has to be switched on deliberately on the form.
   */
  const [overrideDuplicate, setOverrideDuplicate] = useState(false);
  const [checkingDup, setCheckingDup] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  const { data: providers = [] } = useQuery({
    queryKey: ['providers-list'],
    queryFn: async () => { const r = await nestClient.get('/admin/users'); return r.data; },
    enabled: showModal,
  });

  const { data: patients, isLoading } = useQuery({
    queryKey: ['patients', 'search', debouncedSearch],
    queryFn: () => searchPatients({ search: debouncedSearch, limit: 50 }),
    enabled: debouncedSearch.length >= 2,
  });

  const handleSelectPatient = useCallback((patient: Patient) => {
    const cid = chartPatientId((patient as any).id, (patient as any).pid, patient.uuid);
    if (cid) navigate(`/patients/${cid}`);
  }, [navigate]);

  const newPatient = useMutation({
    mutationFn: (data: any) => createPatient(data),
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      setShowModal(false); setForm(emptyForm); setStep(1);
      const cid = chartPatientId(result.id, result.pid);
      if (cid) navigate(`/patients/${cid}`);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || err?.message || 'Unknown error';
      console.error('Patient registration failed:', msg, err);
    },
  });

  const openModal = () => { setShowModal(true); setStep(1); setForm(emptyForm); setDuplicates([]); setOverrideDuplicate(false); setTimeout(() => firstRef.current?.focus(), 100); };
  const nextStep = () => { if (form.fname && form.lname) setStep(2); };
  const prevStep = () => setStep(1);

  const checkDuplicates = async () => {
    setCheckingDup(true);
    setDuplicates([]);
    try {
      const r = await nestClient.get('/patients/check-duplicate', {
        params: { fname: form.fname, lname: form.lname, DOB: form.DOB, phone: form.phone_contact },
      });
      const hits = Array.isArray(r.data) ? r.data : [];
      setDuplicates(hits);
      if (!hits.length) newPatient.mutate(form);
    } catch {
      newPatient.mutate(form);
    } finally {
      setCheckingDup(false);
    }
  };

  const handleSubmit = () => {
    if (!form.fname || !form.lname) return;
    if (isInvalidLiberiaNationalNumber(form.phone_contact)) return;
    // Blocked unless the registrar has explicitly switched the override on.
    if (overrideDuplicate) { newPatient.mutate(form); return; }
    checkDuplicates();
  };
  const update = (k: string, v: string) => setForm(f => ({...f, [k]: v}));

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false); };
    if (showModal) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showModal]);

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
      <div className="rounded-4 p-4 mb-4 text-white" style={{background:'linear-gradient(135deg, #198754 0%, #0d6efd 50%, #6610f2 100%)'}}>
        <div className="d-flex justify-content-between align-items-start">
          <div>
            <h2 className="mb-1 fw-bold"><i className="bi bi-people me-2"></i>Patient Management</h2>
            <p className="mb-0 text-white text-opacity-75 small">Search, register, and manage patient records</p>
          </div>
          <button className="btn btn-light rounded-pill" onClick={openModal}>
            <i className="bi bi-person-plus me-1"></i>Add Patient
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="card border-0 shadow-sm mb-4" style={{borderRadius:'16px'}}>
        <div className="card-body py-3">
          <div className="input-group">
            <span className="input-group-text bg-white border-end-0 rounded-pill-start"><i className="bi bi-search text-muted"></i></span>
            <input type="text" className="form-control border-start-0 rounded-pill-end" placeholder="Search by name, phone, or date of birth..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} autoFocus />
            {searchTerm && <button className="btn btn-outline-secondary border-start-0" onClick={() => setSearchTerm('')}><i className="bi bi-x-lg"></i></button>}
          </div>
        </div>
      </div>

      {/* Results */}
      {debouncedSearch.length >= 2 && (
        <div className="card shadow-sm border-0">
          <div className="card-header bg-white d-flex justify-content-between align-items-center py-3">
            <span className="fw-semibold">Search Results</span>
            {patients && <span className="badge bg-primary rounded-pill px-3">{patients.length} patient{patients.length !== 1 ? 's' : ''}</span>}
          </div>
          <div className="card-body p-0">
            {isLoading ? (
              <div className="text-center py-5"><div className="spinner-border text-primary"/></div>
            ) : patients && patients.length > 0 ? (
              <div className="table-responsive">
                <table className="table table-hover align-middle mb-0">
                  <thead className="table-light"><tr><th>Name</th><th>DOB</th><th>Sex</th><th>Phone</th><th>ID</th><th></th></tr></thead>
                  <tbody>
                    {patients.map((patient) => (
                      <tr key={(patient as any).id || patient.uuid} onClick={() => handleSelectPatient(patient)} style={{ cursor: 'pointer' }}>
                        <td><strong>{formatPatientNameLastFirst(patient)}</strong></td>
                        <td>{formatDateOnly(patient.dob)}</td><td>{patient.sex || '—'}</td><td>{patient.phone || '—'}</td><td><code className="bg-light px-2 py-1 rounded">{patient.public_id || patient.pubpid || '—'}</code></td>
                        <td><button className="btn btn-sm btn-outline-primary rounded-pill px-3" onClick={(e) => { e.stopPropagation(); handleSelectPatient(patient); }}>Open <i className="bi bi-arrow-right ms-1"></i></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="text-center py-5 text-muted">No patients found.</div>}
          </div>
        </div>
      )}

      {debouncedSearch.length < 2 && (
        <div className="text-center py-5">
          <div className="bg-light rounded-circle d-inline-flex align-items-center justify-content-center mb-3" style={{ width: '80px', height: '80px' }}>
            <i className="bi bi-search text-muted" style={{ fontSize: '2rem' }}></i>
          </div>
          <h5 className="text-muted">Search for a Patient</h5>
          <p className="text-muted small">Type a name, phone number, or date of birth above</p>
        </div>
      )}

      {/* Registration Modal */}
      {showModal && (
        <div className="modal-backdrop fade show" style={{ zIndex: 1055 }} onClick={() => setShowModal(false)} />
      )}
      <div className={`modal fade ${showModal ? 'show d-block' : ''}`} tabIndex={-1} style={{ zIndex: 1056 }} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
        <div className="modal-dialog modal-lg modal-dialog-centered">
          <div className="modal-content shadow-lg border-0 rounded-4">
            <div className="modal-header border-0 pb-0">
              <div>
                <h4 className="modal-title"><i className="bi bi-person-plus me-2 text-success"></i>Register New Patient</h4>
                <p className="text-muted small mb-0 mt-1">Step {step} of 2 — {step === 1 ? 'Personal Information' : 'Contact & Address'}</p>
              </div>
              <button className="btn-close" onClick={() => setShowModal(false)}></button>
            </div>

            <div className="modal-body py-4">
              {/* Progress */}
              <div className="d-flex justify-content-center mb-4">
                <div className="d-flex align-items-center gap-2" style={{ width: '200px' }}>
                  <div className={`rounded-circle d-flex align-items-center justify-content-center ${step >= 1 ? 'bg-success text-white' : 'bg-light'}`} style={{ width: '32px', height: '32px', fontSize: '0.8rem' }}>1</div>
                  <div className={`flex-grow-1 ${step >= 2 ? 'bg-success' : 'bg-light'}`} style={{ height: '3px' }}></div>
                  <div className={`rounded-circle d-flex align-items-center justify-content-center ${step >= 2 ? 'bg-success text-white' : 'bg-light'}`} style={{ width: '32px', height: '32px', fontSize: '0.8rem' }}>2</div>
                </div>
              </div>

              {step === 1 && (
                <div onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nextStep(); } }}>
                  <h6 className="text-muted text-uppercase small mb-3">Personal Information</h6>
                  <div className="row g-3">
                    <div className="col-md-4"><label className="form-label small fw-semibold">First Name *</label><input ref={firstRef} className="form-control" value={form.fname} onChange={e => update('fname', e.target.value)} placeholder="John" /></div>
                    <div className="col-md-4"><label className="form-label small fw-semibold">Last Name *</label><input className="form-control" value={form.lname} onChange={e => update('lname', e.target.value)} placeholder="Doe" /></div>
                    <div className="col-md-4"><label className="form-label small fw-semibold">Middle Name</label><input className="form-control" value={form.mname} onChange={e => update('mname', e.target.value)} placeholder="A." /></div>
                    <div className="col-md-4"><label className="form-label small fw-semibold">Date of Birth</label><input className="form-control" type="date" value={form.DOB} onChange={e => update('DOB', e.target.value)} /></div>
                    <div className="col-md-4"><label className="form-label small fw-semibold">Sex</label><select className="form-select" value={form.sex} onChange={e => update('sex', e.target.value)}><option value="">— Select —</option><option>Male</option><option>Female</option></select></div>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <h6 className="text-muted text-uppercase small mb-3">Contact Information</h6>
                  <div className="row g-3 mb-4">
                    <div className="col-md-6"><label className="form-label small fw-semibold">Email</label><input className="form-control" type="email" value={form.email} onChange={e => update('email', e.target.value)} placeholder="patient@email.com" /></div>
                    <div className="col-md-6"><label className="form-label small fw-semibold">Phone</label><PhoneInput value={form.phone_contact} onChange={(v) => update('phone_contact', v)} /></div>
                  </div>
                  <h6 className="text-muted text-uppercase small mb-3">Provider Assignment</h6>
                  <div className="row g-3 mb-4">
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold">Primary Care Provider</label>
                      <select className="form-select" value={form.providerID} onChange={e => update('providerID', e.target.value)}>
                        <option value="">— Select Provider —</option>
                        {providers.filter((p: any) => p.active).map((p: any) => (
                          <option key={p.id} value={p.id}>{p.title ? `${p.title} ` : ''}{p.fname} {p.lname}{p.specialty ? ` (${p.specialty})` : ''}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <h6 className="text-muted text-uppercase small mb-3">Address</h6>
                  <div className="row g-3">
                    <div className="col-12"><label className="form-label small fw-semibold">Street</label><input className="form-control" value={form.street} onChange={e => update('street', e.target.value)} placeholder="123 Main Street" /></div>
                    <div className="col-md-12"><label className="form-label small fw-semibold">City</label><CitySelect value={form.city} onChange={(v) => update('city', v)} /></div>
                  </div>
                </div>
              )}

              {checkingDup && (
                <div className="alert alert-light border d-flex align-items-center gap-2 small">
                  <span className="spinner-border spinner-border-sm text-primary"></span>
                  Checking for an existing patient record…
                </div>
              )}

              {duplicates.length > 0 && (
                <div className="alert alert-warning p-3 rounded-3">
                  <div className="fw-semibold mb-2">
                    <i className="bi bi-shield-exclamation me-1"></i>
                    Registration blocked — this patient may already be on file
                  </div>
                  {duplicates.map((d: any) => (
                    <div key={d.id} className="d-flex align-items-center justify-content-between border-bottom py-2 small">
                      <div>
                        <strong>{formatPatientName(d)}</strong>
                        <div className="text-muted">DOB: {d.DOB || '—'} · Phone: {d.phone_contact || '—'}</div>
                      </div>
                      <button className="btn btn-sm btn-outline-primary rounded-pill px-3"
                        onClick={() => { setShowModal(false); setDuplicates([]); const cid = chartPatientId(d.id, d.pid); if (cid) navigate(`/patients/${cid}`); }}>
                        Use Existing <i className="bi bi-arrow-right ms-1"></i>
                      </button>
                    </div>
                  ))}
                  <div className="form-check form-switch mt-3 mb-1">
                    <input className="form-check-input" type="checkbox" role="switch"
                      id="override-duplicate" checked={overrideDuplicate}
                      onChange={(e) => setOverrideDuplicate(e.target.checked)} />
                    <label className="form-check-label small fw-semibold" htmlFor="override-duplicate">
                      Override — register as a new patient anyway
                    </label>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                    Only use the override when you are sure this is a different person
                    (for example a shared phone number or a common name). Leave it off to
                    open the existing chart instead of creating a duplicate.
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer border-0 pt-0">
              {step === 2 && <button className="btn btn-outline-secondary" onClick={prevStep}><i className="bi bi-arrow-left me-1"></i>Back</button>}
              <div className="flex-grow-1"></div>
              {step === 1 && <button className="btn btn-primary px-4" onClick={nextStep} disabled={!form.fname || !form.lname}>Next <i className="bi bi-arrow-right ms-1"></i></button>}
              {step === 2 && (
                <button className="btn btn-success px-4" onClick={handleSubmit} disabled={newPatient.isPending || checkingDup}>
                  {newPatient.isPending ? <><span className="spinner-border spinner-border-sm me-2"/>Registering...</> : <><i className="bi bi-check-lg me-1"></i>Register New Patient</>}
                </button>
              )}
              {newPatient.isError && <small className="text-danger">Registration failed. Please try again.</small>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
