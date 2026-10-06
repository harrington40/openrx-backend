import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createAllergy, deleteAllergy } from '../../../api/endpoints/allergies';
import nestClient from '../../../api/nest-client';

interface Props { patientId: string; allergies: any[]; enriched?: any[]; readOnly?: boolean }

/**
 * High-yield known allergens drawn from common drug classes and FDA/RxNorm
 * terminology. Used to pre-populate/suggest the allergy field.
 */
const KNOWN_ALLERGENS = [
  'Penicillins', 'Amoxicillin', 'Ampicillin', 'Penicillin G',
  'Cephalosporins', 'Ceftriaxone', 'Cefalexin',
  'Sulfonamides', 'Sulfamethoxazole / Trimethoprim', 'Sulfasalazine',
  'Tetracyclines', 'Doxycycline',
  'Macrolides', 'Azithromycin', 'Erythromycin',
  'Quinolones', 'Ciprofloxacin', 'Levofloxacin',
  'NSAIDs', 'Ibuprofen', 'Naproxen', 'Diclofenac', 'Aspirin',
  'Opioids', 'Morphine', 'Codeine', 'Tramadol',
  'Acetaminophen',
  'Insulin', 'Metformin',
  'ACE Inhibitors', 'Lisinopril', 'Enalapril',
  'Statins', 'Atorvastatin', 'Simvastatin',
  'Anticonvulsants', 'Carbamazepine', 'Phenytoin', 'Lamotrigine',
  'Iodinated Contrast', 'Gadolinium',
  'Latex', 'Egg', 'Peanut', 'Shellfish', 'Wheat', 'Soy', 'Milk',
];

export default function AllergiesTab({ patientId, allergies, enriched = [], readOnly = false }: Props) {
  const queryClient = useQueryClient();
  const [allergen, setAllergen] = useState('');
  const [reaction, setReaction] = useState('');
  const [adding, setAdding] = useState(false);

  // FDA / RxNorm drug-name lookup to supplement the known-allergen list.
  const { data: lookupResults = [] } = useQuery({
    queryKey: ['allergen-lookup', allergen.trim()],
    queryFn: async () => {
      const term = allergen.trim();
      if (term.length < 2) return [];
      try {
        const r = await nestClient.get('/fda/rxnav/approximate', { params: { term } });
        return (r.data?.results || [])
          .map((d: any) => String(d.name || d.drug || '').trim())
          .filter(Boolean)
          .slice(0, 12);
      } catch {
        return [];
      }
    },
    enabled: allergen.trim().length >= 2,
  });

  const suggestions = useMemo(() => {
    const q = allergen.trim().toLowerCase();
    const merged = new Set<string>();
    KNOWN_ALLERGENS.forEach(a => { if (!q || a.toLowerCase().includes(q)) merged.add(a); });
    (lookupResults as string[]).forEach(n => { if (!q || n.toLowerCase().includes(q)) merged.add(n); });
    // Keep the currently typed value out of the suggestion chips.
    merged.delete(allergen.trim());
    return [...merged].slice(0, 16);
  }, [allergen, lookupResults]);

  const handleAdd = async () => {
    if (!allergen.trim()) return;
    setAdding(true);
    try {
      await createAllergy(patientId, { allergen: allergen.trim(), reaction: reaction.trim() });
      setAllergen(''); setReaction('');
      queryClient.invalidateQueries({ queryKey: ['patient', patientId, 'allergies'] });
    } catch { /* ignore */ }
    finally { setAdding(false); }
  };

  const handleDelete = async (id: number) => {
    await deleteAllergy(patientId, id);
    queryClient.invalidateQueries({ queryKey: ['patient', patientId, 'allergies'] });
  };

  return (
    <div className="card">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h5 className="mb-0"><i className="bi bi-exclamation-triangle me-2"></i>Allergies</h5>
      </div>
      <div className="card-body">
        {!readOnly && (
          <>
            <div className="row g-2 mb-2">
              <div className="col-md-5">
                <input
                  className="form-control form-control-sm"
                  list="allergen-options"
                  placeholder="Search allergen (e.g. Penicillin)"
                  value={allergen}
                  onChange={e => setAllergen(e.target.value)}
                />
                <datalist id="allergen-options">
                  {KNOWN_ALLERGENS.map(a => <option key={a} value={a} />)}
                </datalist>
              </div>
              <div className="col-md-5">
                <input className="form-control form-control-sm" placeholder="Reaction (e.g. Hives)" value={reaction} onChange={e => setReaction(e.target.value)} />
              </div>
              <div className="col-md-2">
                <button className="btn btn-primary btn-sm w-100" onClick={handleAdd} disabled={adding || !allergen.trim()}>
                  {adding ? <span className="spinner-border spinner-border-sm"/> : 'Add'}
                </button>
              </div>
            </div>

            {suggestions.length > 0 && (
              <div className="mb-3">
                <div className="small text-muted mb-1">
                  <i className="bi bi-lightbulb me-1"></i>
                  Suggested from drug classes & FDA / RxNorm — click to select:
                </div>
                <div className="d-flex flex-wrap gap-1">
                  {suggestions.map(s => (
                    <button
                      type="button"
                      key={s}
                      className="btn btn-sm btn-outline-secondary rounded-pill py-0"
                      style={{ fontSize: '0.75rem' }}
                      onClick={() => setAllergen(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {enriched.filter((a: any) => a.source && a.source !== 'recorded').length > 0 && (
          <div className="mb-3">
            <div className="small text-muted mb-1"><i className="bi bi-magic me-1"></i>Auto-detected from clinical notes & medications</div>
            <div className="d-flex flex-wrap gap-1">
              {enriched.filter((a: any) => a.source && a.source !== 'recorded').map((a: any, i: number) => (
                <span key={i} className="badge bg-warning bg-opacity-10 text-dark border" title={a.reaction || ''}>
                  {a.allergen} <i className={`bi ms-1 ${a.source === 'note' ? 'bi-journal-text' : 'bi-capsule'}`}></i>
                </span>
              ))}
            </div>
          </div>
        )}
        {allergies.length === 0 ? (
          <p className="text-muted text-center mb-0">No allergies recorded.</p>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm table-hover mb-0">
              <thead><tr><th>Allergen</th><th>Reaction</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {allergies.map((a: any) => (
                  <tr key={a.id}><td><strong>{a.allergen || a.title}</strong></td><td>{a.reaction || '—'}</td><td>{a.date || '—'}</td>
                    <td>{!readOnly && <button className="btn btn-outline-danger btn-sm" onClick={() => handleDelete(a.id)}><i className="bi bi-trash"/></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
