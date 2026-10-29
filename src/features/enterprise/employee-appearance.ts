/** Stable visual identity; availability changes only the pose. */
export interface EmployeeAppearance {
  shell: 'rounded' | 'capsule' | 'squircle';
  visor: 'wide' | 'compact' | 'arched';
  ear: 'left' | 'right' | 'both';
  core: 'bar' | 'round' | 'diamond';
  palette: 'coral' | 'sage' | 'sky' | 'amber' | 'lilac' | 'teal' | 'rose' | 'peach' | 'slate' | 'silver';
  expression: 'friendly' | 'cheerful' | 'curious' | 'calm' | 'bright';
}

const SHELLS = ['rounded', 'capsule', 'squircle'] as const;
const VISORS = ['wide', 'compact', 'arched'] as const;
const EARS = ['left', 'right', 'both'] as const;
const CORES = ['bar', 'round', 'diamond'] as const;
const PALETTES = ['coral', 'sage', 'sky', 'amber', 'lilac', 'teal', 'rose', 'peach', 'slate', 'silver'] as const;
const EXPRESSIONS = ['friendly', 'cheerful', 'curious', 'calm', 'bright'] as const;

function featureHash(id: string, feature: string): number {
  let hash = 2166136261;
  for (const character of `${feature}:${id}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

export function employeeAppearance(id: string): EmployeeAppearance {
  return {
    shell: SHELLS[featureHash(id, 'shell') % SHELLS.length],
    visor: VISORS[featureHash(id, 'visor') % VISORS.length],
    ear: EARS[featureHash(id, 'ear') % EARS.length],
    core: CORES[featureHash(id, 'core') % CORES.length],
    palette: PALETTES[featureHash(id, 'palette') % PALETTES.length],
    expression: EXPRESSIONS[featureHash(id, 'expression') % EXPRESSIONS.length],
  };
}
