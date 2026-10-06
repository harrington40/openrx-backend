import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ImagingUpload from '../../components/common/ImagingUpload';
import nestClient from '../../api/nest-client';

declare global {
  interface Window {
    cornerstone: any;
    cornerstoneWADOImageLoader: any;
    dicomParser: any;
  }
}

/** One stored study as returned by ``GET /imaging/patient/:pid``. */
interface ImagingItem {
  id: number;
  pid: number;
  type: 'xray' | 'lab';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  description: string;
  uploadedBy: string;
  createdAt: string;
}

type ToolName = 'wl' | 'pan' | 'zoom' | 'length' | 'angle' | 'roi' | 'crosshair';
interface Pt { x: number; y: number; }
interface Measurement { id: number; tool: 'length' | 'angle' | 'roi'; pts: Pt[]; text: string; }

interface StudyInfo {
  patientName: string; patientId: string; modality: string; studyDate: string;
  studyDescription: string; seriesDescription: string; seriesNumber: string;
  instanceNumber: string; sliceThickness: string; spacing: string; rows: string;
  columns: string; bitsStored: string; frames: string;
  top: string; bottom: string; left: string; right: string; plane: string;
}

const EMPTY_INFO: StudyInfo = {
  patientName: '', patientId: '', modality: '', studyDate: '', studyDescription: '',
  seriesDescription: '', seriesNumber: '', instanceNumber: '', sliceThickness: '',
  spacing: '', rows: '', columns: '', bitsStored: '', frames: '',
  top: 'A', bottom: 'P', left: 'R', right: 'L', plane: 'Axial',
};

/** Read a DICOM tag as a trimmed string ("" when missing). */
function tt(ds: any, tag: string): string {
  try {
    if (!ds || !ds.elements || !ds.elements[tag]) return '';
    const v = ds.string(tag);
    return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  } catch { return ''; }
}
/** Read a multi-valued numeric DICOM tag (e.g. "1\\0\\0\\0\\1\\0"). */
function tnums(ds: any, tag: string): number[] {
  return tt(ds, tag).split('\\').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
}
/** Map a patient-space direction to an orientation letter. */
function axisLabel(dir: number[]): string {
  const [x, y, z] = dir;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (az >= ax && az >= ay) return z >= 0 ? 'H' : 'F';
  if (ax >= ay) return x >= 0 ? 'L' : 'R';
  return y >= 0 ? 'P' : 'A';
}

export default function DicomViewerPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rasterUrlRef = useRef<string | null>(null);
  const imageRef = useRef<any>(null);
  const infoRef = useRef<StudyInfo>(EMPTY_INFO);
  const measurementsRef = useRef<Measurement[]>([]);
  const dragRef = useRef<{ mode: ToolName; startX: number; startY: number; viewport?: any } | null>(null);
  const anglePtsRef = useRef<Pt[]>([]);
  const previewRef = useRef<Measurement | null>(null);
  const cacheRef = useRef<Map<number, string>>(new Map());
  const qc = useQueryClient();

  const [loaded, setLoaded] = useState(false);
  const [fileName, setFileName] = useState('');
  const [viewerPid, setViewerPid] = useState('1');
  const [metadata, setMetadata] = useState<[string, string][]>([]);
  const [info, setInfo] = useState<StudyInfo>(EMPTY_INFO);
  const [windowWidth, setWindowWidth] = useState(400);
  const [windowCenter, setWindowCenter] = useState(40);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loadingStudy, setLoadingStudy] = useState(false);
  const [rasterUrl, setRasterUrl] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolName>('wl');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [crosshair, setCrosshair] = useState(false);
  const [cine, setCine] = useState(false);
  const [sliceIndex, setSliceIndex] = useState(0);

  // Studies already stored in B2 for the patient currently in the ID box.
  const { data: studies = [] } = useQuery<ImagingItem[]>({
    queryKey: ['imaging', viewerPid],
    queryFn: async () => {
      const pid = parseInt(viewerPid, 10) || 1;
      const r = await nestClient.get(`/imaging/patient/${pid}`, { params: { type: 'xray' } });
      return r.data;
    },
  });
  const sliceCount = studies.length;

  // Load Cornerstone from CDN
  useEffect(() => {
    if (window.cornerstone) { setLoaded(true); return; }
    const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.onload = () => resolve(); s.onerror = reject; document.head.appendChild(s);
    });
    const CDN = 'https://unpkg.com';
    Promise.all([
      loadScript(`${CDN}/cornerstone-core@2.6.1/dist/cornerstone.min.js`),
      loadScript(`${CDN}/dicom-parser@1.8.21/dist/dicomParser.min.js`),
      // "NoWebWorkers" build: decodes on the main thread with the JPEG /
      // JPEG-Lossless / JPEG-LS / JPEG2000 (WASM) codecs bundled inline. The
      // default worker build fetches a cross-origin Web Worker from the CDN,
      // which browsers block, leaving the view blank.
      loadScript(`${CDN}/cornerstone-wado-image-loader@4.3.0/dist/cornerstoneWADOImageLoaderNoWebWorkers.bundle.min.js`),
    ]).then(() => {
      const cwil = window.cornerstoneWADOImageLoader;
      cwil.external.cornerstone = window.cornerstone;
      cwil.external.dicomParser = window.dicomParser;
      try {
        cwil.webWorkerManager?.initialize?.({
          maxWebWorkers: 1, startWebWorkersOnDemand: true, webWorkerTaskPaths: [],
          taskConfiguration: { decodeTask: { initializeCodecsOnStartup: true, strict: false } },
        });
      } catch { /* codecs still initialise on first decode */ }
      setLoaded(true);
    }).catch(() => setError('Failed to load DICOM viewer libraries. Check internet connection.'));
  }, []);

  useEffect(() => {
    if (!loaded || !viewportRef.current) return;
    try { window.cornerstone.enable(viewportRef.current); } catch { /* already enabled */ }
    try { window.cornerstone.resize(viewportRef.current); } catch { /* ignore */ }
  }, [loaded]);

  // Revoke the previous inline-image object URL so it doesn't leak.
  const clearRaster = useCallback(() => {
    if (rasterUrlRef.current) { URL.revokeObjectURL(rasterUrlRef.current); rasterUrlRef.current = null; }
    setRasterUrl(null);
  }, []);
  const showRaster = useCallback((file: File) => {
    if (rasterUrlRef.current) URL.revokeObjectURL(rasterUrlRef.current);
    const url = URL.createObjectURL(file);
    rasterUrlRef.current = url;
    setRasterUrl(url);
  }, []);
  useEffect(() => () => clearRaster(), [clearRaster]);

  /** Draw measurements + crosshair on the overlay canvas. */
  const redrawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const el = viewportRef.current;
    if (!overlay || !el || !window.cornerstone) return;
    const cv = el.querySelector('canvas');
    const w = cv ? cv.clientWidth : el.clientWidth;
    const h = cv ? cv.clientHeight : el.clientHeight;
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);
    if (crosshair) {
      ctx.strokeStyle = 'rgba(0,255,180,0.85)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    }
    const toCanvas = (p: Pt): Pt => { try { return window.cornerstone.pixelToCanvas(el, p); } catch { return p; } };
    ctx.strokeStyle = '#ffd400'; ctx.fillStyle = '#ffd400'; ctx.lineWidth = 2; ctx.font = '13px monospace';
    const all = previewRef.current ? [...measurementsRef.current, previewRef.current] : measurementsRef.current;
    for (const m of all) {
      const pts = m.pts.map(toCanvas);
      if (m.tool === 'roi' && pts.length >= 2) {
        const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
        ctx.strokeRect(x, y, Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
        ctx.fillText(m.text, x + 4, y + 15);
      } else {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        const last = pts[pts.length - 1];
        if (last) ctx.fillText(m.text, last.x + 6, last.y - 6);
      }
    }
    for (const p of anglePtsRef.current) { const q = toCanvas(p); ctx.fillRect(q.x - 3, q.y - 3, 6, 6); }
  }, [crosshair]);

  /** Load + display an imageId, sync state, and redraw overlays. */
  const renderImage = useCallback(async (imageId: string, studyId?: number) => {
    const el = viewportRef.current;
    if (!el || !window.cornerstone) return;
    try { window.cornerstone.enable(el); } catch { /* already enabled */ }
    try { window.cornerstone.resize(el); } catch { /* ignore */ }
    const image = await window.cornerstone.loadAndCacheImage(imageId);
    imageRef.current = image;
    const viewport = window.cornerstone.getDefaultViewportForImage(el, image);
    window.cornerstone.displayImage(el, image);
    window.cornerstone.setViewport(el, viewport);
    if (viewport?.voi) { setWindowWidth(Math.round(viewport.voi.windowWidth)); setWindowCenter(Math.round(viewport.voi.windowCenter)); }
    if (viewport?.scale) setZoom(viewport.scale);
    if (studyId != null) setSelectedId(studyId);
    clearRaster();
    requestAnimationFrame(() => redrawOverlay());
  }, [clearRaster, redrawOverlay]);

  // Keep the overlay in sync whenever Cornerstone repaints.
  useEffect(() => {
    const el = viewportRef.current;
    if (!loaded || !el || !window.cornerstone) return;
    const handler = () => redrawOverlay();
    el.addEventListener('cornerstoneimagerendered', handler);
    return () => el.removeEventListener('cornerstoneimagerendered', handler);
  }, [loaded, redrawOverlay]);

  /** Populate the DICOM-tag table and the patient/study/series info + orientation. */
  const applyDataSet = useCallback((ds: any) => {
    const rows: [string, string][] = [];
    const add = (label: string, tag: string) => { const v = tt(ds, tag); if (v) rows.push([label, v]); };
    add('Patient Name', 'x00100010'); add('Patient ID', 'x00100020'); add('Birth Date', 'x00100030'); add('Sex', 'x00100040');
    add('Study Date', 'x00080020'); add('Study Time', 'x00080030'); add('Modality', 'x00080060'); add('Study Description', 'x00081030');
    add('Series Description', 'x0008103e'); add('Series Number', 'x00200011'); add('Instance Number', 'x00200013'); add('Body Part', 'x00180015');
    add('Rows', 'x00280010'); add('Columns', 'x00280011'); add('Bits Allocated', 'x00280100'); add('Bits Stored', 'x00280101');
    add('Photometric Interpretation', 'x00280004'); add('Pixel Spacing', 'x00280030'); add('Slice Thickness', 'x00180050');
    add('Slice Location', 'x00201041'); add('Window Center', 'x00281050'); add('Window Width', 'x00281051');
    add('Rescale Intercept', 'x00281052'); add('Rescale Slope', 'x00281053'); add('Number of Frames', 'x00280008');
    setMetadata(rows);

    const iop = tnums(ds, 'x00200037');
    let { top, bottom, left, right, plane } = EMPTY_INFO;
    if (iop.length === 6) {
      const rowDir = [iop[0], iop[1], iop[2]], colDir = [iop[3], iop[4], iop[5]];
      top = axisLabel([-colDir[0], -colDir[1], -colDir[2]]);
      bottom = axisLabel(colDir);
      left = axisLabel([-rowDir[0], -rowDir[1], -rowDir[2]]);
      right = axisLabel(rowDir);
      plane = Math.abs(colDir[2]) > 0.7 ? 'Axial' : Math.abs(rowDir[2]) > 0.7 ? 'Coronal' : 'Sagittal';
    }
    const ni: StudyInfo = {
      patientName: tt(ds, 'x00100010'), patientId: tt(ds, 'x00100020'), modality: tt(ds, 'x00080060'),
      studyDate: tt(ds, 'x00080020'), studyDescription: tt(ds, 'x00081030'),
      seriesDescription: tt(ds, 'x0008103e'), seriesNumber: tt(ds, 'x00200011'),
      instanceNumber: tt(ds, 'x00200013'), sliceThickness: tt(ds, 'x00180050'),
      spacing: tt(ds, 'x00280030'), rows: tt(ds, 'x00280010'), columns: tt(ds, 'x00280011'),
      bitsStored: tt(ds, 'x00280101'), frames: tt(ds, 'x00280008'), top, bottom, left, right, plane,
    };
    infoRef.current = ni; setInfo(ni);
  }, []);

  /** Render a locally-chosen file (DICOM via Cornerstone, plain image inline). */
  const loadDicomFile = useCallback(async (file: File, studyId?: number) => {
    if (!window.cornerstone || !viewportRef.current) return;
    setFileName(file.name); setError('');
    const isDicom = /\.(dcm|dicom)$/i.test(file.name) || /dicom/i.test(file.type);
    if (!isDicom) { showRaster(file); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try { applyDataSet(window.dicomParser.parseDicom(bytes)); } catch { /* metadata best-effort */ }
      const imageId = window.cornerstoneWADOImageLoader.wadouri.fileManager.add(file);
      await renderImage(imageId, studyId);
    } catch (e) {
      setError('Failed to load DICOM file: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  }, [renderImage, showRaster, applyDataSet]);

  /** Fetch a stored study's bytes through the backend proxy → imageId (cached). */
  const fetchStudyImageId = useCallback(async (item: ImagingItem): Promise<string | null> => {
    const cached = cacheRef.current.get(item.id);
    if (cached) return cached;
    const r = await nestClient.get(`/imaging/${item.id}/file`, { responseType: 'arraybuffer' });
    const blob = new Blob([r.data], { type: item.mimeType || 'application/dicom' });
    const file = new File([blob], item.originalName, { type: blob.type });
    if (!/\.(dcm|dicom)$/i.test(item.originalName) && !/dicom/i.test(blob.type)) return null;
    try { applyDataSet(window.dicomParser.parseDicom(new Uint8Array(await file.arrayBuffer()))); } catch { /* best-effort */ }
    const imageId = window.cornerstoneWADOImageLoader.wadouri.fileManager.add(file);
    cacheRef.current.set(item.id, imageId);
    return imageId;
  }, [applyDataSet]);

  /** Open a stored study (fetch + display). */
  const openStudy = useCallback(async (item: ImagingItem) => {
    setLoadingStudy(true); setError('');
    try {
      const imageId = await fetchStudyImageId(item);
      if (!imageId) { setError('This study is not a DICOM image.'); return; }
      await renderImage(imageId, item.id);
      measurementsRef.current = []; previewRef.current = null; setMeasurements([]);
      const idx = studies.findIndex((s) => s.id === item.id);
      if (idx >= 0) setSliceIndex(idx);
    } catch (e) {
      const apiMessage = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError('Failed to load study: ' + (apiMessage || (e instanceof Error ? e.message : 'Unknown error')));
    } finally {
      setLoadingStudy(false);
    }
  }, [fetchStudyImageId, renderImage, studies]);

  /** Jump to a slice (study) by index — used by wheel / keys / slider / cine. */
  const goToSlice = useCallback((idx: number) => {
    if (!studies.length) return;
    const i = Math.max(0, Math.min(studies.length - 1, idx));
    setSliceIndex(i);
    if (studies[i]?.id !== selectedId) void openStudy(studies[i]);
  }, [studies, selectedId, openStudy]);

  const applyWindowLevel = (ww: number, wc: number) => {
    setWindowWidth(Math.round(ww)); setWindowCenter(Math.round(wc));
    const el = viewportRef.current; if (!el || !window.cornerstone) return;
    const vp = window.cornerstone.getViewport(el); if (!vp?.voi) return;
    vp.voi.windowWidth = ww; vp.voi.windowCenter = wc;
    window.cornerstone.setViewport(el, vp);
  };
  const applyZoom = (z: number) => {
    const el = viewportRef.current; if (!el || !window.cornerstone) return;
    const vp = window.cornerstone.getViewport(el); if (!vp) return;
    vp.scale = z; window.cornerstone.setViewport(el, vp); setZoom(z);
  };
  const mutateViewport = (fn: (vp: any) => void) => {
    const el = viewportRef.current; if (!el || !window.cornerstone) return;
    const vp = window.cornerstone.getViewport(el); if (!vp) return;
    fn(vp); window.cornerstone.setViewport(el, vp); requestAnimationFrame(() => redrawOverlay());
  };
  const rotateBy = (deg: number) => mutateViewport((vp) => { vp.rotation = (vp.rotation || 0) + deg; });
  const flipH = () => mutateViewport((vp) => { vp.hflip = !vp.hflip; });
  const flipV = () => mutateViewport((vp) => { vp.vflip = !vp.vflip; });
  const resetViewport = () => {
    const el = viewportRef.current; if (!el || !window.cornerstone || !imageRef.current) return;
    const vp = window.cornerstone.getDefaultViewportForImage(el, imageRef.current);
    window.cornerstone.setViewport(el, vp);
    if (vp?.voi) { setWindowWidth(Math.round(vp.voi.windowWidth)); setWindowCenter(Math.round(vp.voi.windowCenter)); }
    if (vp?.scale) setZoom(vp.scale);
    measurementsRef.current = []; previewRef.current = null; anglePtsRef.current = []; setMeasurements([]);
    redrawOverlay();
  };

  const pixelSpacingMm = (): [number, number] => {
    const s = infoRef.current.spacing.split('\\').map(Number).filter((n) => !Number.isNaN(n) && n > 0);
    return s.length === 2 ? [s[0], s[1]] : [1, 1]; // [row (y), column (x)]
  };
  const distMm = (a: Pt, b: Pt): number => {
    const [r, c] = pixelSpacingMm();
    return Math.hypot((a.x - b.x) * c, (a.y - b.y) * r);
  };
  const angleBetween = (a: Pt, b: Pt, c: Pt): number => {
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
    if (!m1 || !m2) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)))) * 180) / Math.PI;
  };
  const roiMean = (a: Pt, b: Pt): number | null => {
    const img = imageRef.current; if (!img || typeof img.getPixelData !== 'function') return null;
    const data = img.getPixelData(); const cols = img.columns, rows = img.rows;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x))), x1 = Math.min(cols - 1, Math.ceil(Math.max(a.x, b.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y))), y1 = Math.min(rows - 1, Math.ceil(Math.max(a.y, b.y)));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { sum += data[y * cols + x]; n++; }
    return n ? sum / n : null;
  };
  const addMeasurement = (kind: Measurement['tool'], pts: Pt[], text: string) => {
    const m: Measurement = { id: Date.now() + Math.random(), tool: kind, pts, text };
    measurementsRef.current = [...measurementsRef.current, m];
    setMeasurements(measurementsRef.current);
    redrawOverlay();
  };

  const presets = [
    { label: 'Lung', ww: 1500, wc: -600 },
    { label: 'Bone', ww: 2000, wc: 300 },
    { label: 'Abdomen', ww: 400, wc: 40 },
    { label: 'Brain', ww: 80, wc: 40 },
  ];

  const sliceIndexRef = useRef(0);
  useEffect(() => { sliceIndexRef.current = sliceIndex; }, [sliceIndex]);

  // Cine: advance through slices on a timer while playing.
  useEffect(() => {
    if (!cine || studies.length < 2) return;
    const t = window.setInterval(() => goToSlice((sliceIndexRef.current + 1) % studies.length), 700);
    return () => window.clearInterval(t);
  }, [cine, goToSlice, studies.length]);

  // Keyboard slice navigation.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') goToSlice(sliceIndexRef.current + 1);
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') goToSlice(sliceIndexRef.current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToSlice]);

  // Reset any in-progress angle when the tool changes.
  useEffect(() => { anglePtsRef.current = []; previewRef.current = null; redrawOverlay(); }, [tool, redrawOverlay]);

  const toImagePt = (clientX: number, clientY: number): Pt | null => {
    const el = viewportRef.current; if (!el || !window.cornerstone) return null;
    const rect = el.getBoundingClientRect();
    try { return window.cornerstone.canvasToPixel(el, { x: clientX - rect.left, y: clientY - rect.top }); } catch { return null; }
  };

  const onPointerDown = (e: React.MouseEvent) => {
    const el = viewportRef.current; if (!el || !imageRef.current) return;
    e.preventDefault();
    const mode: ToolName = e.button === 1 ? 'pan' : e.button === 2 ? 'zoom' : tool;
    if (mode === 'crosshair') { setCrosshair((c) => !c); return; }
    if (mode === 'angle') {
      const p = toImagePt(e.clientX, e.clientY); if (!p) return;
      anglePtsRef.current = [...anglePtsRef.current, p];
      if (anglePtsRef.current.length === 3) {
        const [a, b, c] = anglePtsRef.current;
        addMeasurement('angle', [a, b, c], angleBetween(a, b, c).toFixed(1) + '°');
        anglePtsRef.current = [];
      }
      redrawOverlay();
      return;
    }
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, viewport: window.cornerstone.getViewport(el) };
    if (mode === 'length' || mode === 'roi') {
      const p = toImagePt(e.clientX, e.clientY);
      previewRef.current = p ? { id: -1, tool: mode, pts: [p, p], text: mode === 'length' ? '0.0 mm' : '' } : null;
    }
  };

  const onPointerMove = (e: React.MouseEvent) => {
    const d = dragRef.current; const el = viewportRef.current;
    if (!d || !el || !window.cornerstone) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (d.mode === 'wl') {
      const vp = d.viewport; if (!vp?.voi) return;
      vp.voi.windowWidth = Math.max(1, vp.voi.windowWidth + dx * 2);
      vp.voi.windowCenter = vp.voi.windowCenter + dy * 2;
      window.cornerstone.setViewport(el, vp);
      setWindowWidth(Math.round(vp.voi.windowWidth)); setWindowCenter(Math.round(vp.voi.windowCenter));
      d.startX = e.clientX; d.startY = e.clientY;
    } else if (d.mode === 'pan') {
      const vp = d.viewport; if (!vp) return;
      vp.translation = { x: (vp.translation?.x || 0) + dx, y: (vp.translation?.y || 0) + dy };
      window.cornerstone.setViewport(el, vp);
      d.startX = e.clientX; d.startY = e.clientY;
    } else if (d.mode === 'zoom') {
      const vp = d.viewport; if (!vp) return;
      vp.scale = Math.max(0.1, (vp.scale || 1) * (1 - dy * 0.005));
      window.cornerstone.setViewport(el, vp);
      setZoom(vp.scale);
      d.startX = e.clientX; d.startY = e.clientY;
    } else if (d.mode === 'length' || d.mode === 'roi') {
      const p = toImagePt(e.clientX, e.clientY); const m = previewRef.current;
      if (!p || !m) return;
      m.pts = [m.pts[0], p];
      m.text = d.mode === 'length' ? distMm(m.pts[0], p).toFixed(1) + ' mm' : '';
      redrawOverlay();
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current; const m = previewRef.current;
    if (d && (d.mode === 'length' || d.mode === 'roi') && m && m.pts.length === 2) {
      const [a, b] = m.pts;
      if (d.mode === 'length') {
        addMeasurement('length', [a, b], distMm(a, b).toFixed(1) + ' mm');
      } else {
        const [r, c] = pixelSpacingMm();
        const areaCm2 = (Math.abs(a.x - b.x) * c * Math.abs(a.y - b.y) * r) / 100;
        const mean = roiMean(a, b);
        addMeasurement('roi', [a, b], `${areaCm2.toFixed(2)} cm²${mean != null ? ` · μ=${Math.round(mean)}` : ''}`);
      }
    }
    previewRef.current = null;
    dragRef.current = null;
    redrawOverlay();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!studies.length) return;
    e.preventDefault();
    if (e.ctrlKey) { applyZoom(Math.max(0.1, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); return; }
    goToSlice(sliceIndex + (e.deltaY > 0 ? 1 : -1));
  };

  const TOOLS: { name: ToolName; label: string; icon: string; title: string }[] = [
    { name: 'wl', label: 'W/L', icon: 'bi-brightness-high', title: 'Window / Level — drag' },
    { name: 'pan', label: 'Pan', icon: 'bi-hand-index', title: 'Pan — drag (or middle mouse)' },
    { name: 'zoom', label: 'Zoom', icon: 'bi-zoom-in', title: 'Zoom — drag (or right mouse)' },
    { name: 'length', label: 'Length', icon: 'bi-rulers', title: 'Measure length — drag' },
    { name: 'angle', label: 'Angle', icon: 'bi-triangle', title: 'Measure angle — 3 clicks' },
    { name: 'roi', label: 'ROI', icon: 'bi-bounding-box', title: 'Rectangle ROI — drag' },
  ];
  const cursor = tool === 'pan' ? 'grab' : tool === 'zoom' ? 'zoom-in' : 'crosshair';
  const panel: React.CSSProperties = { background: '#111827', border: '1px solid #1f2937', borderRadius: 10, padding: 8 };
  const overh: React.CSSProperties = { position: 'absolute', color: '#a5f3fc', font: '12px monospace', lineHeight: 1.5, textShadow: '0 0 4px #000', pointerEvents: 'none' };

  return (
    <div style={{ minHeight: '100vh', background: '#0b1220', color: '#e5e7eb', padding: 12 }}>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}><i className="bi bi-image me-2"></i>DICOM / CT / X-Ray Viewer</div>
              <div style={{ fontSize: 12, opacity: 0.7 }} className="text-truncate">
                {info.patientName || fileName || 'No study loaded'}
                {info.patientId ? ` · ID ${info.patientId}` : ''}
                {info.modality ? ` · ${info.modality}` : ''}
                {info.studyDescription ? ` · ${info.studyDescription}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="form-control form-control-sm" style={{ width: 90 }} placeholder="Patient ID" value={viewerPid} onChange={(e) => setViewerPid(e.target.value)} />
              <button className="btn btn-sm btn-outline-light" onClick={() => fileInputRef.current?.click()}><i className="bi bi-folder2-open me-1"></i>Open</button>
              <input ref={fileInputRef} type="file" accept=".dcm,.dicom" className="d-none" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadDicomFile(f); }} />
            </div>
          </div>

          <div
            style={{ position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', height: '70vh', minHeight: 420, border: '1px solid #1f2937', cursor }}
            onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp} onMouseLeave={onPointerUp}
            onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}
          >
            <div ref={viewportRef} style={{ width: '100%', height: '100%' }} />
            <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
            {rasterUrl && <img src={rasterUrl} alt={fileName || 'study'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
            {!rasterUrl && fileName && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', color: '#7dd3fc', font: '600 14px monospace' }}>
                <span style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)' }}>{info.top}</span>
                <span style={{ position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)' }}>{info.bottom}</span>
                <span style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)' }}>{info.left}</span>
                <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)' }}>{info.right}</span>
              </div>
            )}
            {!rasterUrl && fileName && (
              <div style={{ ...overh, top: 8, left: 8 }}>
                <div>{info.patientName} {info.patientId ? `(${info.patientId})` : ''}</div>
                <div>{info.studyDescription || info.modality}{info.seriesDescription ? ` · ${info.seriesDescription}` : ''}</div>
                <div>Image {sliceCount ? sliceIndex + 1 : 1} / {sliceCount || 1} · {info.plane}</div>
              </div>
            )}
            {!rasterUrl && fileName && (
              <div style={{ ...overh, top: 8, right: 8, textAlign: 'right' }}>
                <div>W: {windowWidth}  L: {windowCenter}</div>
                <div>Zoom {Math.round(zoom * 100)}%</div>
                {info.sliceThickness && <div>Thk {info.sliceThickness} mm</div>}
                {info.spacing && <div>Spacing {info.spacing.replace('\\', ' × ')} mm</div>}
                {info.columns && info.rows && <div>{info.columns} × {info.rows}</div>}
              </div>
            )}
            {loadingStudy && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}>
                <div className="spinner-border text-light" />
              </div>
            )}
            {!loaded && !error && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spinner-border text-primary" />
              </div>
            )}
            {!fileName && !loadingStudy && loaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
                <i className="bi bi-images" style={{ fontSize: '2.5rem' }}></i>
                <p className="mt-2 mb-2">Select a study on the right, or open a .dcm file</p>
                <button className="btn btn-outline-light btn-sm" onClick={() => fileInputRef.current?.click()}>Open DICOM File</button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button className="btn btn-sm btn-outline-light" disabled={sliceIndex <= 0} onClick={() => goToSlice(sliceIndex - 1)}><i className="bi bi-chevron-left"></i></button>
            <input type="range" min={0} max={Math.max(0, sliceCount - 1)} value={Math.min(sliceIndex, Math.max(0, sliceCount - 1))} onChange={(e) => goToSlice(+e.target.value)} disabled={sliceCount < 2} style={{ flex: 1 }} />
            <button className="btn btn-sm btn-outline-light" disabled={sliceIndex >= sliceCount - 1} onClick={() => goToSlice(sliceIndex + 1)}><i className="bi bi-chevron-right"></i></button>
            <button className={`btn btn-sm ${cine ? 'btn-primary' : 'btn-outline-light'}`} disabled={sliceCount < 2} onClick={() => setCine((c) => !c)}><i className={`bi ${cine ? 'bi-pause-fill' : 'bi-play-fill'} me-1`}></i>Cine</button>
            <span style={{ fontFamily: 'monospace', fontSize: 12, minWidth: 96, textAlign: 'center' }}>Slice {sliceCount ? sliceIndex + 1 : 0} / {sliceCount}</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={panel}>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>TOOLS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {TOOLS.map((t) => (
                <button key={t.name} className={`btn btn-sm ${tool === t.name ? 'btn-primary' : 'btn-outline-light'}`} title={t.title} disabled={!fileName} onClick={() => setTool(t.name)}>
                  <i className={`bi ${t.icon} me-1`}></i>{t.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginTop: 8 }}>
              <button className="btn btn-sm btn-outline-light" title="Rotate -90" disabled={!fileName} onClick={() => rotateBy(-90)}><i className="bi bi-arrow-counterclockwise"></i></button>
              <button className="btn btn-sm btn-outline-light" title="Rotate +90" disabled={!fileName} onClick={() => rotateBy(90)}><i className="bi bi-arrow-clockwise"></i></button>
              <button className="btn btn-sm btn-outline-light" title="Flip horizontal" disabled={!fileName} onClick={flipH}><i className="bi bi-arrow-left-right"></i></button>
              <button className="btn btn-sm btn-outline-light" title="Flip vertical" disabled={!fileName} onClick={flipV}><i className="bi bi-arrow-up-down"></i></button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn btn-sm btn-outline-light flex-grow-1" disabled={!fileName} onClick={resetViewport}><i className="bi bi-arrow-repeat me-1"></i>Reset</button>
              <button className={`btn btn-sm ${crosshair ? 'btn-primary' : 'btn-outline-light'} flex-grow-1`} disabled={!fileName} onClick={() => setCrosshair((c) => !c)}><i className="bi bi-plus-lg me-1"></i>Cross</button>
              <button className="btn btn-sm btn-outline-light" title="Clear measurements" disabled={!fileName || measurements.length === 0} onClick={() => { measurementsRef.current = []; previewRef.current = null; setMeasurements([]); redrawOverlay(); }}><i className="bi bi-trash"></i></button>
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>WINDOW / LEVEL</div>
            <label style={{ fontSize: 11 }}>Width {windowWidth}</label>
            <input type="range" min={1} max={4000} value={windowWidth} onChange={(e) => applyWindowLevel(+e.target.value, windowCenter)} style={{ width: '100%' }} />
            <label style={{ fontSize: 11 }}>Center {windowCenter}</label>
            <input type="range" min={-1024} max={3072} value={windowCenter} onChange={(e) => applyWindowLevel(windowWidth, +e.target.value)} style={{ width: '100%' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {presets.map((p) => (<button key={p.label} className="btn btn-sm btn-outline-info" onClick={() => applyWindowLevel(p.ww, p.wc)}>{p.label}</button>))}
            </div>
          </div>

          <div style={{ ...panel, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>ZOOM</span>
            <button className="btn btn-sm btn-outline-light" onClick={() => applyZoom(Math.max(0.1, zoom - 0.2))}>-</button>
            <span style={{ fontFamily: 'monospace', fontSize: 12, flex: 1, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <button className="btn btn-sm btn-outline-light" onClick={() => applyZoom(zoom + 0.2)}>+</button>
            <button className="btn btn-sm btn-outline-light" onClick={() => applyZoom(1)}>1:1</button>
          </div>

          <div style={{ ...panel, overflow: 'auto', maxHeight: 190 }}>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>SERIES / STUDIES ({sliceCount})</div>
            {sliceCount === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.5 }}>No studies for patient {viewerPid}.</div>
            ) : studies.map((s, i) => (
              <button key={s.id} onClick={() => goToSlice(i)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 6px', borderRadius: 6, border: `1px solid ${selectedId === s.id ? '#3b82f6' : 'transparent'}`, background: selectedId === s.id ? '#1e3a8a' : 'transparent', color: 'inherit', fontSize: 12, marginBottom: 4 }}>
                <span style={{ opacity: 0.6, marginRight: 6 }}>{i + 1}.</span>{s.originalName}
              </button>
            ))}
          </div>

          <div style={{ ...panel, overflow: 'auto', maxHeight: 240 }}>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>DICOM TAGS</div>
            {metadata.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.5 }}>No metadata.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 11 }}><tbody>
                {metadata.map(([k, v]) => (<tr key={k}><td style={{ opacity: 0.55, paddingRight: 6, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td><td>{v}</td></tr>))}
              </tbody></table>
            )}
          </div>
        </div>
      </div>

      <div style={{ ...panel, marginTop: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}><i className="bi bi-cloud-upload me-1"></i>Upload X-Ray / DICOM to Backblaze B2 (Patient {viewerPid || '1'})</div>
        <ImagingUpload type="xray" pid={parseInt(viewerPid, 10) || 1} onFileSelected={(f) => loadDicomFile(f)} onSuccess={() => qc.invalidateQueries({ queryKey: ['imaging', viewerPid] })} />
      </div>
    </div>
  );
}
