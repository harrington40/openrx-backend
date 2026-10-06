import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';

/**
 * WebRTC video consultation room.
 *
 * Both the patient and the physician open the same URL — /video/<room> — where
 * <room> is the code minted by the booking service (e.g. vc-1a2b3c4d). The two
 * browsers grab their camera/microphone, connect to the `/telehealth` socket.io
 * namespace for signalling, and then exchange audio + video peer-to-peer.
 */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const SOCKET_BASE =
  typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? window.location.origin
    : 'http://localhost:3002';

/** Ack returned by the gateway's `telehealth:join` handler. */
type JoinAck = { ok?: boolean; room?: string; peers?: number; initiator?: boolean };

/** SDP / ICE payloads exchanged between the two peers. */
type SignalData =
  | { type: 'offer'; sdp?: string }
  | { type: 'answer'; sdp?: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

export default function VideoConsultPage() {
  const { room = '' } = useParams<{ room: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const role = params.get('role') === 'physician' ? 'physician' : 'patient';

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteReady = useRef(false);

  const [status, setStatus] = useState<'init' | 'waiting' | 'connected' | 'ended' | 'error'>('init');
  const [error, setError] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [peers, setPeers] = useState(0);

  const joinUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/video/${room}` : '';

  /** Send an SDP/ICE payload to the other participant via the relay. */
  const signal = useCallback((data: SignalData) => {
    socketRef.current?.emit('telehealth:signal', { room, data });
  }, [room]);

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    while (pendingCandidates.current.length) {
      const c = pendingCandidates.current.shift()!;
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore stale candidates */
      }
    }
  }, []);

  const createOffer = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ type: 'offer', sdp: offer.sdp });
  }, [signal]);


  useEffect(() => {
    if (!room) return undefined;
    let disposed = false;

    const start = async () => {
      // 1. Local media first — without it there is nothing to send.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } catch (e) {
        setError(
          'Could not access your camera/microphone. Please grant permission and reload. (' +
            ((e as Error)?.message || 'media error') +
            ')',
        );
        setStatus('error');
        return;
      }

      // 2. Peer connection.
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));

      const remoteStream = new MediaStream();
      pc.ontrack = (ev) => {
        ev.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) signal({ type: 'candidate', candidate: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('connected');
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          remoteReady.current = false;
        }
      };

      // 3. Signalling socket.
      const socket = io(`${SOCKET_BASE}/telehealth`, {
        path: '/messaging/socket.io',
        transports: ['websocket', 'polling'],
        reconnection: true,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('telehealth:join', { room, role }, (res: JoinAck) => {
          if (!res?.ok) return;
          setPeers(res.peers || 0);
          if (res.initiator) {
            setStatus('connected');
            createOffer();
          } else {
            setStatus('waiting');
          }
        });
      });

      socket.on('telehealth:peer-joined', () => {
        setPeers((p) => Math.max(p, 1) + 1);
        // The newcomer initiates; if we are already waiting we just wait.
      });

      socket.on('telehealth:peer-left', () => {
        remoteReady.current = false;
        setPeers(1);
        setStatus('waiting');
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      });

      socket.on('telehealth:signal', async ({ data }: { data?: SignalData }) => {
        try {
          if (data?.type === 'offer') {
            await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
            remoteReady.current = true;
            await flushCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signal({ type: 'answer', sdp: answer.sdp });
            setStatus('connected');
          } else if (data?.type === 'answer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            remoteReady.current = true;
            await flushCandidates();
            setStatus('connected');
          } else if (data?.type === 'candidate' && data.candidate) {
            if (remoteReady.current) {
              await pc.addIceCandidate(data.candidate).catch(() => undefined);
            } else {
              pendingCandidates.current.push(data.candidate);
            }
          }
        } catch (err) {
          console.warn('[telehealth] signal error', err);
        }
      });
    };

    start();

    return () => {
      disposed = true;
      socketRef.current?.emit('telehealth:leave', { room });
      socketRef.current?.disconnect();
      socketRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      remoteReady.current = false;
      pendingCandidates.current = [];
    };
  }, [room, role, createOffer, flushCandidates, signal]);

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    }
  };

  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setCamOn(track.enabled);
    }
  };

  const hangUp = () => {
    socketRef.current?.emit('telehealth:leave', { room });
    socketRef.current?.disconnect();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    setStatus('ended');
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(joinUrl);
  };

  const banner =
    status === 'connected'
      ? { cls: 'alert-success', icon: 'bi-camera-video-fill', text: 'Connected — you are live.' }
      : status === 'waiting'
      ? { cls: 'alert-info', icon: 'bi-hourglass-split', text: 'Waiting for the other participant to join…' }
      : status === 'ended'
      ? { cls: 'alert-secondary', icon: 'bi-telephone-x', text: 'Call ended.' }
      : status === 'error'
      ? { cls: 'alert-danger', icon: 'bi-exclamation-triangle-fill', text: error }
      : { cls: 'alert-light', icon: 'bi-camera-video', text: 'Starting your camera…' };



  return (
    <div className="min-vh-100 d-flex flex-column" style={{ background: '#0b1220' }}>
      <div className="container-fluid py-3 flex-grow-1 d-flex flex-column">
        <div className="d-flex align-items-center justify-content-between text-white mb-3">
          <div className="d-flex align-items-center gap-2">
            <i className="bi bi-camera-video-fill text-info fs-4"></i>
            <div>
              <div className="fw-bold">OpenRx Video Consultation</div>
              <div className="small text-white-50">Room {room} · joined as {role}</div>
            </div>
          </div>
          <span className="badge rounded-pill bg-secondary text-white-50">{peers} participant(s)</span>
        </div>

        <div className={`alert ${banner.cls} py-2 d-flex align-items-center gap-2`}>
          <i className={`bi ${banner.icon}`}></i>
          <span>{banner.text}</span>
        </div>

        <div className="row g-3 flex-grow-1">
          <div className="col-12 col-lg-9">
            <div className="position-relative rounded-4 overflow-hidden bg-black h-100" style={{ minHeight: '52vh' }}>
              <video ref={remoteVideoRef} autoPlay playsInline className="w-100 h-100" style={{ objectFit: 'cover' }} />
              {status !== 'connected' && (
                <div className="position-absolute top-50 start-50 translate-middle text-center text-white-50">
                  <i className="bi bi-person-video3 display-1 d-block mb-2"></i>
                  {status === 'waiting' ? 'Waiting for the other participant…' : 'Connecting…'}
                </div>
              )}
            </div>
          </div>
          <div className="col-12 col-lg-3">
            <div className="position-relative rounded-4 overflow-hidden bg-black mb-3" style={{ aspectRatio: '4 / 3' }}>
              <video ref={localVideoRef} autoPlay playsInline muted className="w-100 h-100" style={{ objectFit: 'cover', transform: 'scaleX(-1)' }} />
              <span className="position-absolute bottom-0 start-0 m-2 badge bg-dark bg-opacity-75">You</span>
              {!camOn && (
                <div className="position-absolute top-50 start-50 translate-middle text-white-50">
                  <i className="bi bi-camera-video-off fs-1"></i>
                </div>
              )}
            </div>
            <div className="card border-0 bg-dark bg-opacity-50 text-white-50" style={{ borderRadius: 12 }}>
              <div className="card-body py-2 px-3 small">
                <div className="text-truncate mb-2" title={joinUrl}>
                  <i className="bi bi-link-45deg me-1"></i>{joinUrl}
                </div>
                <button className="btn btn-outline-light btn-sm w-100 mb-1" onClick={copyLink}>
                  <i className="bi bi-clipboard me-1"></i>Copy invite link
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex justify-content-center gap-2 py-3">
          <button className={`btn btn-lg rounded-circle ${micOn ? 'btn-light' : 'btn-danger'}`} style={{ width: 56, height: 56 }} onClick={toggleMic} title={micOn ? 'Mute' : 'Unmute'}>
            <i className={`bi ${micOn ? 'bi-mic-fill' : 'bi-mic-mute-fill'}`}></i>
          </button>
          <button className={`btn btn-lg rounded-circle ${camOn ? 'btn-light' : 'btn-danger'}`} style={{ width: 56, height: 56 }} onClick={toggleCam} title={camOn ? 'Stop video' : 'Start video'}>
            <i className={`bi ${camOn ? 'bi-camera-video-fill' : 'bi-camera-video-off-fill'}`}></i>
          </button>
          <button className="btn btn-lg btn-danger rounded-circle" style={{ width: 56, height: 56 }} onClick={hangUp} title="Hang up">
            <i className="bi bi-telephone-x-fill"></i>
          </button>
          <button className="btn btn-lg btn-outline-light rounded-pill px-4" onClick={() => navigate(-1)}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
