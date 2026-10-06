/**
 * Shared laboratory section tree.
 *
 * Single source of truth for how catalog tests are grouped on BOTH lab screens:
 *  - the Patient Laboratory Result Form (features/labreports/LabResultFormPage)
 *  - the Lab Orders result entry      (features/labs/LabsPage)
 *
 * Each catalog row is looked up by its MJ code and listed once, under a section
 * and (where shown) a sub-group, with an optional display label that overrides
 * the catalog wording. Every code here is a result-sheet test, so the
 * ordering-only catalog sections (fertility, tumour markers, thyroid, the
 * nutritional and coagulation panels) never appear on the result screens.
 */
export type LabItem = { code: string; label?: string };
export type LabGroup = { subsection?: string; items: LabItem[] };
export type LabSection = { title: string; groups: LabGroup[] };

export const LAB_TREE: LabSection[] = [
  {
    title: '🩸 HEMATOLOGY',
    groups: [
      { items: [{ code: 'MJ-001' }] },
      {
        subsection: 'CBC Complete Blood Count',
        items: [
          { code: 'MJ-003' },
          { code: 'MJ-131' },
          { code: 'MJ-132', label: 'MID (%)' },
          { code: 'MJ-133' },
          { code: 'MJ-134' },
          { code: 'MJ-135' },
          { code: 'MJ-136' },
          { code: 'MJ-137' },
          { code: 'MJ-138' },
          { code: 'MJ-139' },
          { code: 'MJ-140', label: 'MCV' },
          { code: 'MJ-141', label: 'MCH' },
          { code: 'MJ-142', label: 'MCHC' },
          { code: 'MJ-143', label: 'RDW-CV' },
          { code: 'MJ-144', label: 'RDW-SD' },
          { code: 'MJ-145', label: 'MPV' },
          { code: 'MJ-146', label: 'PCT' },
          { code: 'MJ-147', label: 'PDW' },
          { code: 'MJ-148', label: 'PLCR' },
          { code: 'MJ-149', label: 'PLCC' },
        ],
      },
      { subsection: 'Sickle Cell Testing', items: [{ code: 'MJ-005' }] },
    ],
  },
  {
    title: '🧪 CLINICAL CHEMISTRY',
    groups: [
      {
        items: [
          { code: 'MJ-031', label: 'FBS' },
          { code: 'MJ-032', label: 'RBS' },
          { code: 'MJ-052' },
          { code: 'MJ-128' },
          { code: 'MJ-049' },
          { code: 'MJ-129' },
          { code: 'MJ-054' },
          { code: 'MJ-050', label: 'Total Protein' },
          { code: 'MJ-037', label: 'Triglyceride' },
        ],
      },
      {
        subsection: 'Cholesterol',
        items: [
          { code: 'MJ-036', label: 'Total' },
          { code: 'MJ-038', label: 'HDL' },
          { code: 'MJ-039', label: 'LDL' },
        ],
      },
      {
        items: [
          { code: 'MJ-057', label: 'Chlorine' },
          { code: 'MJ-130' },
          { code: 'MJ-056', label: 'Potassium' },
          { code: 'MJ-055', label: 'Sodium' },
          { code: 'MJ-046', label: 'ALT (GPT)' },
          { code: 'MJ-045', label: 'AST (GOT)' },
          { code: 'MJ-061', label: 'Total Bilirubin' },
          { code: 'MJ-070' },
        ],
      },
    ],
  },
  {
    title: '🦠 SEROLOGY / INFECTIOUS DISEASE',
    groups: [
      { items: [{ code: 'MJ-016' }] },
      { subsection: 'Widal', items: [{ code: 'MJ-010', label: 'TO' }, { code: 'MJ-011', label: 'TH' }] },
      {
        items: [
          { code: 'MJ-020' },
          { code: 'MJ-026' },
          { code: 'MJ-019' },
          { code: 'MJ-154' },
        ],
      },
    ],
  },
  {
    title: '🔬 MICROBIOLOGY / PARASITOLOGY',
    groups: [
      {
        items: [
          { code: 'MJ-150' },
          { code: 'MJ-151' },
          { code: 'MJ-153' },
        ],
      },
    ],
  },
  {
    title: '🦟 MALARIA / PARASITOLOGY',
    groups: [
      {
        items: [
          { code: 'MJ-004' },
          { code: 'MJ-008' },
        ],
      },
    ],
  },
  {
    title: '🩸 IMMUNOHEMATOLOGY',
    groups: [{ items: [{ code: 'MJ-006', label: 'Blood / Group' }] }],
  },
  {
    title: '🧬 IMMUNOLOGY / ALLERGY',
    groups: [{ items: [{ code: 'MJ-152' }] }],
  },
  {
    title: '💧 URINE CHEMISTRY',
    groups: [
      {
        subsection: 'Chemical Analysis',
        items: [
          { code: 'MJ-110' },
          { code: 'MJ-111', label: 'S/G' },
          { code: 'MJ-104' },
          { code: 'MJ-103' },
          { code: 'MJ-108' },
          { code: 'MJ-105' },
          { code: 'MJ-109' },
          { code: 'MJ-107' },
          { code: 'MJ-112' },
          { code: 'MJ-106' },
        ],
      },
      {
        subsection: 'Visual Analysis',
        items: [
          { code: 'MJ-101' },
          { code: 'MJ-102' },
          { code: 'MJ-155', label: 'Sediment' },
        ],
      },
      {
        subsection: 'Microscopic Analysis',
        items: [
          { code: 'MJ-113' },
          { code: 'MJ-114' },
          { code: 'MJ-115', label: 'Epithelial Cells' },
          { code: 'MJ-116' },
          { code: 'MJ-117', label: 'Crystal' },
          { code: 'MJ-118', label: 'Parasites' },
          { code: 'MJ-119' },
          { code: 'MJ-120' },
          { code: 'MJ-121' },
        ],
      },
    ],
  },
];

/** code -> display label for the rows whose printed wording differs from the catalog name. */
export const LAB_LABELS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of LAB_TREE) for (const g of s.groups) for (const it of g.items) if (it.label) m[it.code] = it.label;
  return m;
})();

/** code -> which section / sub-group it belongs to (independent of the catalog). */
export const LAB_CODE_INDEX: Record<string, { section: string; subsection?: string }> = (() => {
  const m: Record<string, { section: string; subsection?: string }> = {};
  for (const s of LAB_TREE) for (const g of s.groups) for (const it of g.items) m[it.code] = { section: s.title, subsection: g.subsection };
  return m;
})();

/** Display label for a test: the tree wording wins, otherwise the catalog name. */
export const labLabel = (code: string, fallbackName: string): string => LAB_LABELS[code] || fallbackName;

/** A tree item resolved against the live catalog. */
export interface ResolvedLabItem { t: any; label: string }
export interface ResolvedLabGroup { subsection?: string; items: ResolvedLabItem[] }
export interface ResolvedLabSection { title: string; groups: ResolvedLabGroup[]; flat: ResolvedLabItem[] }

/**
 * Resolve the tree against a catalog payload (rows keyed by `code`). Sections or
 * items whose code is not present in the catalog are dropped, so the tree always
 * reflects what the API actually returned.
 */
export function buildLabSections(catalog: any[]): ResolvedLabSection[] {
  const byCode = new Map((catalog || []).map((t: any) => [t.code, t]));
  return LAB_TREE.map(sec => {
    const groups = sec.groups
      .map(g => ({
        subsection: g.subsection,
        items: g.items
          .map(it => {
            const t = byCode.get(it.code) as any;
            return t ? { t, label: labLabel(it.code, t.name) } : null;
          })
          .filter((x): x is ResolvedLabItem => !!x),
      }))
      .filter(g => g.items.length);
    const flat = groups.flatMap(g => g.items);
    return { title: sec.title, groups, flat };
  }).filter(s => s.flat.length);
}
