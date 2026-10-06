import { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { patientChartPath } from '../../utils/patientChart';
import nestClient from '../../api/nest-client';
import { useMessagingSocket, MessagingEvent } from '../../hooks/useMessagingSocket';
import { useAuth } from '../../hooks/useAuth';
import { formatPatientName } from '../../utils/patientName';
import { formatDateTime } from '../../utils/date';
import { NotificationFeedCard, NotificationFeedModal, FeedItem } from '../../components/notifications/NotificationFeed';

interface Toast { id: number; type: 'success'|'warning'|'info'|'danger'; title: string; body: string; priority: string; }

const PRIORITY_ORDER: Record<string, number> = { STAT: 4, URGENT: 3, HIGH: 2, NORMAL: 1, LOW: 0 };
const PRIORITY_BADGE: Record<string, string> = { STAT: 'bg-danger', URGENT: 'bg-warning text-dark', HIGH: 'bg-info text-dark', NORMAL: 'bg-light text-dark', LOW: 'bg-secondary' };
const KIND_ICON: Record<string, string> = { CLINIC: 'bi-hospital', PATIENT: 'bi-person', DIRECT: 'bi-envelope-arrow-up', EVENT: 'bi-broadcast', EVENTS: 'bi-broadcast' };

/** Parse a persisted title like "[STAT] [CLINIC] Subject" into its parts. */
function parseTitle(title?: string): { priority: string; kind: string; subject: string } {
  const t = title || '';
  const pri = ['STAT', 'URGENT', 'HIGH', 'NORMAL', 'LOW'].find(p => t.startsWith(`[${p}] `));
  let priority = 'NORMAL';
  let rest = t;
  if (pri) { priority = pri; rest = t.slice(pri.length + 3); }
  const km = rest.match(/^\[(CLINIC|PATIENT|DIRECT|EVENT|EVENTS)\]\s*/);
  const kind = km ? km[1] : 'CLINIC';
  const subject = km ? rest.slice(km[0].length) : rest;
  return { priority, kind, subject };
}

type Filter = 'all' | 'unread' | 'priority' | 'read';

export default function MessagesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canWrite = user?.role === 'physician' || user?.role === 'admin';
  const [form, setForm] = useState({ title: '', body: '', pid: '', recipientId: '', messageType: 'clinic', priority: 'NORMAL' });
  const [showCompose, setShowCompose] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [openFeed, setOpenFeed] = useState<FeedItem | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, setNewCount] = useState(0);
  const tid = useRef(0);

  const addToast = useCallback((t: Omit<Toast,'id'>) => {
    const id = ++tid.current;
    setToasts(p => [...p.slice(-4), {...t,id}]);
    setTimeout(() => setToasts(p => p.filter(x=>x.id!==id)), 5000);
  }, []);

  const { data: allUsers = [] } = useQuery({
    queryKey: ['all-users'],
    queryFn: async () => { const r = await nestClient.get('/admin/users'); return r.data; },
  });

  const { data: allPatients = [] } = useQuery({
    queryKey: ['all-patients'],
    queryFn: async () => { const r = await nestClient.get('/patients'); return r.data; },
    enabled: form.messageType === 'patient',
  });

  const selectedPatient = allPatients.find((p: any) => String(p.pid) === String(form.pid));
  const patientProviderId = selectedPatient?.providerID;

  const { data: messages = [] } = useQuery({
    queryKey: ['messages'],
    queryFn: async () => { const r = await nestClient.get('/messages'); return r.data; },
  });

  useMessagingSocket({
    topics: ['openrx.messages.clinic', 'openrx.messages.patient'],
    onNewMessage: (event: MessagingEvent) => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      setNewCount(c => c + 1);
      addToast({ type: 'info', title: 'New Message', body: event.payload.title || 'You have a new message', priority: event.priority || 'NORMAL' });
    },
    onNotification: (event: MessagingEvent) => {
      addToast({ type: 'warning', title: 'Notification', body: event.payload.title || 'System notification', priority: event.priority || 'NORMAL' });
    },
  });

  const enriched = useMemo(() => {
    return messages
      .map((m: any) => ({ ...m, ...parseTitle(m.title) }))
      .sort((a: any, b: any) => {
        const pr = (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0);
        if (pr !== 0) return pr;
        const unread = (b.message_status === 'New' ? 1 : 0) - (a.message_status === 'New' ? 1 : 0);
        if (unread !== 0) return unread;
        return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
      });
  }, [messages]);

  /**
   * The same messages folded into the shared notification shape, so a card can
   * be opened into a modal that shows every specific that belongs to a message.
   */
  const feedItems: FeedItem[] = useMemo(
    () =>
      enriched.slice(0, 12).map((m: any): FeedItem => {
        const isNew = m.message_status === 'New';
        const tone = m.priority === 'STAT' ? '#dc3545' : m.priority === 'URGENT' ? '#fd7e14' : '#0d6efd';
        return {
          id: m.id,
          title: m.subject || '(no subject)',
          subtitle: m.patientName && String(m.patientName).trim()
            ? `${String(m.patientName).trim()} · PID ${m.pid}`
            : m.groupname === 'events' ? 'Clinic broadcast' : 'Clinic message',
          summary: String(m.body || '').replace(/\s+/g, ' ').slice(0, 90),
          at: m.date,
          by: m.user,
          icon: KIND_ICON[m.kind] || 'bi-envelope',
          tone,
          status: m.message_status,
          unread: isNew,
          link: patientChartPath(m.patientId) || undefined,
          linkLabel: 'Open chart',
          metrics: [
            { label: 'Priority', value: m.priority, color: tone },
            { label: 'Channel', value: m.kind, color: '#6f42c1' },
            { label: 'Status', value: m.message_status || 'Read', color: isNew ? '#dc3545' : '#198754' },
          ],
          fields: [
            ['Subject', m.subject],
            ['Patient', m.patientName && String(m.patientName).trim() ? `${String(m.patientName).trim()} (PID ${m.pid})` : 'No patient attached'],
            ['Posted by', m.user],
            ['Posted', formatDateTime(m.date)],
            ['Assigned to', m.assigned_to],
            ['Status', m.message_status || 'Read'],
          ],
          lists: [{ title: 'Message body', lines: String(m.body || '').split(/\r?\n/).filter(Boolean) }],
        };
      }),
    [enriched],
  );

  const filtered = useMemo(() => {
    let list = enriched;
    if (filter === 'unread') list = list.filter((m: any) => m.message_status === 'New');
    if (filter === 'read') list = list.filter((m: any) => m.message_status !== 'New');
    if (filter === 'priority') list = list.filter((m: any) => ['STAT', 'URGENT', 'HIGH'].includes(m.priority));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((m: any) => `${m.subject} ${m.body} ${m.priority} ${m.kind}`.toLowerCase().includes(q));
    return list;
  }, [enriched, filter, search]);

  const unreadCount = enriched.filter((m: any) => m.message_status === 'New').length;
  const priorityCount = enriched.filter((m: any) => ['STAT', 'URGENT', 'HIGH'].includes(m.priority)).length;

  const sendMsg = useMutation({
    mutationFn: (d: any) => nestClient.post('/messages', {
      title: d.title, body: d.body, pid: d.pid || undefined,
      recipientId: d.recipientId || undefined, priority: d.priority || 'NORMAL', type: d.messageType || 'clinic',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      setForm({ title: '', body: '', pid: '', recipientId: '', messageType: 'clinic', priority: 'NORMAL' });
      setShowCompose(false);
      addToast({ type: 'success', title: 'Sent', body: 'Message routed via event bus', priority: 'NORMAL' });
    },
  });

  const markRead = useMutation({
    mutationFn: (id: number) => nestClient.patch(`/messages/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages'] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => nestClient.post('/messages/read-all'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['messages'] }); setNewCount(0); },
  });

  const deleteMsg = useMutation({
    mutationFn: (id: number) => nestClient.delete(`/messages/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages'] }),
  });

  const openMessage = (m: any) => {
    setOpenId(openId === m.id ? null : m.id);
    if (m.message_status === 'New') markRead.mutate(m.id);
  };

  const fmtTime = (d: string) => {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleString();
  };

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
        .glass-page .list-group-item {
          background: transparent !important;
        }
      `}</style>
      {/* Toasts */}
      <div className="position-fixed bottom-0 end-0 p-3" style={{ zIndex: 9999 }}>
        {toasts.map(t => (
          <div key={t.id} className={`toast show align-items-center text-bg-${t.type} border-0 mb-2`}>
            <div className="d-flex">
              <div className="toast-body small"><strong>{t.title}</strong>{t.priority !== 'NORMAL' && <span className={`badge ms-1 ${PRIORITY_BADGE[t.priority]}`}>{t.priority}</span>}<br />{t.body}</div>
              <button className="btn-close btn-close-white me-2 m-auto" onClick={() => setToasts(p => p.filter(x => x.id !== t.id))}></button>
            </div>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="rounded-4 p-4 mb-4 text-white" style={{ background: 'linear-gradient(135deg, #0dcaf0 0%, #0d6efd 50%, #6610f2 100%)' }}>
        <div className="d-flex justify-content-between align-items-start flex-wrap gap-3">
          <div>
            <h2 className="mb-1 fw-bold"><i className="bi bi-chat-dots me-2"></i>Messages</h2>
            <p className="mb-0 text-white text-opacity-75 small"><i className="bi bi-broadcast me-1"></i>Smart inbox · priority-sorted · real-time</p>
          </div>
          <div className="d-flex gap-2 align-items-center">
            {unreadCount > 0 && <span className="badge bg-danger rounded-pill fs-6">{unreadCount} unread</span>}
            {unreadCount > 0 && (
              <button className="btn btn-outline-light btn-sm rounded-pill" onClick={() => markAllRead.mutate()}>
                <i className="bi bi-envelope-check me-1"></i>Mark all read
              </button>
            )}
            {canWrite && (
              <button className="btn btn-light rounded-pill" onClick={() => setShowCompose(!showCompose)}>
                <i className={`bi ${showCompose ? 'bi-x-lg' : 'bi-pencil-square'} me-1`}></i>
                {showCompose ? 'Cancel' : 'Compose'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Notification surface — same card + modal viewers used elsewhere */}
      <NotificationFeedCard
        title="Message Notifications"
        icon="bi-bell-fill"
        tone="#0d6efd"
        items={feedItems}
        emptyText="No new messages"
        onOpen={(item) => { setOpenFeed(item); if (item.unread) markRead.mutate(Number(item.id)); }}
        onSeeAll={() => setFilter('unread')}
      />

      {/* Compose */}
      {canWrite && showCompose && (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: '16px' }}>
          <div className="card-header bg-white py-3" style={{ borderRadius: '16px 16px 0 0' }}>
            <h6 className="mb-0 fw-bold"><i className="bi bi-pencil-square me-2 text-primary"></i>New Message</h6>
          </div>
          <div className="card-body">
            <div className="row g-2">
              <div className="col-md-2"><label className="form-label small">Type</label>
                <select className="form-select form-select-sm rounded-pill" value={form.messageType} onChange={e => setForm({ ...form, messageType: e.target.value, pid: '', recipientId: '' })}>
                  <option value="clinic">🏥 Clinic</option><option value="patient">👤 Patient</option><option value="direct">📨 Direct</option>
                </select>
              </div>
              <div className="col-md-3"><label className="form-label small">Recipient</label>
                {form.messageType === 'patient' ? (
                  <select className="form-select form-select-sm rounded-pill" value={form.pid} onChange={e => setForm({ ...form, pid: e.target.value })}>
                    <option value="">— Select Patient —</option>
                    {allPatients.map((p: any) => <option key={p.pid} value={p.pid}>{formatPatientName(p)} (PID {p.pid}){p.providerName ? ` — PCP: ${p.providerName}` : ''}</option>)}
                  </select>
                ) : (
                  <select className="form-select form-select-sm rounded-pill" value={form.recipientId} onChange={e => setForm({ ...form, recipientId: e.target.value })}>
                    <option value="">— Select Provider —</option>
                    <option value="all">📢 All Providers (Broadcast)</option>
                    {patientProviderId && (
                      <optgroup label="💡 Suggested — Patient's Provider">
                        {allUsers.filter((u: any) => String(u.id) === String(patientProviderId)).map((u: any) => (
                          <option key={u.id} value={u.id}>⭐ {u.title ? `${u.title} ` : ''}{u.fname} {u.lname} ({u.username})</option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="All Providers">
                      {allUsers.filter((u: any) => u.active).map((u: any) => (
                        <option key={u.id} value={u.id}>{u.title ? `${u.title} ` : ''}{u.fname} {u.lname} ({u.username})</option>
                      ))}
                    </optgroup>
                  </select>
                )}
              </div>
              <div className="col-md-3"><label className="form-label small">Subject</label><input className="form-control form-control-sm rounded-pill" placeholder="Subject" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
              <div className="col-md-2"><label className="form-label small">Body</label><input className="form-control form-control-sm rounded-pill" placeholder="Message..." value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} /></div>
              <div className="col-md-1"><label className="form-label small">Priority</label>
                <select className="form-select form-select-sm rounded-pill" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                  <option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option><option value="STAT">STAT</option>
                </select>
              </div>
              <div className="col-md-1 d-flex align-items-end">
                <button className="btn btn-sm rounded-pill w-100 text-white" style={{ background: 'linear-gradient(135deg,#0dcaf0,#0d6efd)' }}
                  onClick={() => sendMsg.mutate({ ...form, pid: form.pid ? Number(form.pid) : undefined, recipientId: form.recipientId ? Number(form.recipientId) : undefined, messageType: form.messageType })}
                  disabled={sendMsg.isPending || !form.title}>
                  {sendMsg.isPending ? <span className="spinner-border spinner-border-sm"></span> : <i className="bi bi-send"></i>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="row g-3 mb-3">
        {[
          { v: enriched.length, l: 'Total', c: '#0d6efd', i: 'bi-inbox' },
          { v: unreadCount, l: 'Unread', c: '#dc3545', i: 'bi-envelope-exclamation' },
          { v: priorityCount, l: 'Priority', c: '#fd7e14', i: 'bi-exclamation-diamond' },
          { v: enriched.length - unreadCount, l: 'Read', c: '#198754', i: 'bi-envelope-check' },
        ].map((s, i) => (
          <div className="col-md-3 col-sm-6" key={i}>
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: '16px' }}>
              <div className="card-body d-flex align-items-center gap-3 py-3">
                <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: '48px', height: '48px', backgroundColor: `${s.c}15` }}>
                  <i className={`bi ${s.i} fs-5`} style={{ color: s.c }}></i>
                </div>
                <div><div className="fs-5 fw-bold" style={{ color: s.c }}>{s.v}</div><small className="text-muted">{s.l}</small></div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar: filters + search */}
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <div className="btn-group" role="group">
          {([['all', 'All', 'bi-inbox'], ['unread', 'Unread', 'bi-envelope-exclamation'], ['priority', 'Priority', 'bi-exclamation-diamond'], ['read', 'Read', 'bi-envelope-check']] as [Filter, string, string][]).map(([f, label, icon]) => (
            <button key={f} className={`btn btn-sm rounded-pill ${filter === f ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setFilter(f)}>
              <i className={`bi ${icon} me-1`}></i>{label}
            </button>
          ))}
        </div>
        <div className="ms-auto" style={{ minWidth: '240px' }}>
          <div className="input-group input-group-sm">
            <span className="input-group-text bg-white border-end-0 rounded-pill-start"><i className="bi bi-search text-muted"></i></span>
            <input className="form-control border-start-0 rounded-pill-end" placeholder="Search messages..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Inbox */}
      <div className="card border-0 shadow-sm" style={{ borderRadius: '16px' }}>
        <div className="card-header bg-white d-flex justify-content-between py-3" style={{ borderRadius: '16px 16px 0 0' }}>
          <h6 className="mb-0 fw-bold"><i className="bi bi-inbox me-2 text-primary"></i>Inbox</h6>
          <span className="badge bg-primary rounded-pill">{filtered.length}</span>
        </div>
        <div className="card-body p-0">
          {filtered.map((m: any) => {
            const isNew = m.message_status === 'New';
            const isOpen = openId === m.id;
            const isPriority = ['STAT', 'URGENT', 'HIGH'].includes(m.priority);
            return (
              <div key={m.id} className={`border-bottom ${isNew ? 'bg-primary bg-opacity-05' : ''}`}>
                <div className="d-flex align-items-center gap-3 px-3 py-2" style={{ cursor: 'pointer', borderLeft: isNew ? '4px solid #0d6efd' : isPriority ? '4px solid #fd7e14' : '4px solid transparent' }}
                  onClick={() => openMessage(m)}>
                  <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0"
                    style={{ width: '44px', height: '44px', backgroundColor: isNew ? '#0d6efd15' : isPriority ? '#fd7e1415' : '#6c757d15' }}>
                    <i className={`bi ${KIND_ICON[m.kind] || 'bi-envelope'} fs-5`} style={{ color: isNew ? '#0d6efd' : isPriority ? '#fd7e14' : '#6c757d' }}></i>
                  </div>
                  <div className="flex-grow-1 min-width-0">
                    <div className="d-flex justify-content-between align-items-center gap-2">
                      <div className="d-flex align-items-center gap-2 min-width-0">
                        {m.priority !== 'NORMAL' && <span className={`badge rounded-pill ${PRIORITY_BADGE[m.priority]}`} style={{ fontSize: '0.65rem' }}>{m.priority}</span>}
                        <strong className={isNew ? 'text-primary text-truncate' : 'text-truncate'} style={{ fontSize: '0.9rem' }}>{m.subject || 'No Subject'}</strong>
                      </div>
                      <div className="d-flex gap-1 align-items-center flex-shrink-0">
                        <span className={`badge rounded-pill ${isNew ? 'bg-primary' : 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>{isNew ? 'New' : 'Read'}</span>
                      </div>
                    </div>
                    <p className="text-muted small mb-0 text-truncate">{m.body}</p>
                    <small className="text-muted">{fmtTime(m.date)} · {m.kind}</small>
                  </div>
                </div>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 bg-white" style={{ borderLeft: '4px solid transparent' }}>
                    <div className="p-3 bg-light rounded-3" style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.5 }}>{m.body || '(no body)'}</div>
                    <div className="d-flex gap-2 mt-2">
                      {(() => {
                        // pid may be 0 for system notices — never link those to /patients/0.
                        const href = patientChartPath(m.patientId, m.patientPid, m.pid);
                        if (!href) return null;
                        return (
                          <button className="btn btn-sm btn-outline-primary rounded-pill" onClick={() => navigate(href)}>
                            <i className="bi bi-person me-1"></i>Open Patient Chart
                          </button>
                        );
                      })()}
                      {isNew && <button className="btn btn-sm btn-outline-success rounded-pill" onClick={() => markRead.mutate(m.id)}><i className="bi bi-envelope-check me-1"></i>Mark read</button>}
                      <button className="btn btn-sm btn-outline-danger rounded-pill" onClick={() => deleteMsg.mutate(m.id)}><i className="bi bi-trash me-1"></i>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center text-muted py-5">
              <i className="bi bi-inbox fs-1 d-block mb-2 opacity-50"></i>
              <p>{search ? 'No messages match your search.' : 'No messages here.'}</p>
              {canWrite && (
                <button className="btn btn-primary btn-sm rounded-pill" onClick={() => setShowCompose(true)}>
                  <i className="bi bi-pencil-square me-1"></i>Compose Message
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <NotificationFeedModal
        item={openFeed}
        onClose={() => setOpenFeed(null)}
        onAck={(item) => { markRead.mutate(Number(item.id)); setOpenFeed(null); }}
        ackPending={markRead.isPending}
        onNavigate={(link) => navigate(link)}
      />
    </div>
  );
}
