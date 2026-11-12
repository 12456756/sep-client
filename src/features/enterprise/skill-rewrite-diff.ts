export interface SkillDiffPart {
  text: string;
  changed: boolean;
}

interface DiffPart {
  text: string;
  kind: 'equal' | 'remove' | 'add';
}

const maxCells = 250_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function append(parts: DiffPart[], text: string, kind: DiffPart['kind']): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ text, kind });
}

function compare(before: string[], after: string[]): DiffPart[] {
  let start = 0;
  let endBefore = before.length;
  let endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--; endAfter--;
  }
  const parts: DiffPart[] = [];
  append(parts, before.slice(0, start).join(''), 'equal');
  const rows = endBefore - start;
  const columns = endAfter - start;
  // Bound both memory and work for unusually large, completely rewritten documents.
  if (!rows || !columns || (rows + 1) * (columns + 1) > maxCells) {
    append(parts, before.slice(start, endBefore).join(''), 'remove');
    append(parts, after.slice(start, endAfter).join(''), 'add');
  } else {
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        lengths[row * width + column] = before[start + row] === after[start + column]
          ? 1 + lengths[(row + 1) * width + column + 1]
          : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
      }
    }
    let row = 0;
    let column = 0;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && before[start + row] === after[start + column]) {
        append(parts, before[start + row++], 'equal'); column++;
      } else if (row < rows && (column === columns || lengths[(row + 1) * width + column] >= lengths[row * width + column + 1])) {
        append(parts, before[start + row++], 'remove');
      } else {
        append(parts, after[start + column++], 'add');
      }
    }
  }
  append(parts, before.slice(endBefore).join(''), 'equal');
  return parts;
}

export function buildSkillRewriteDiff(before: string, after: string): { before: SkillDiffPart[]; after: SkillDiffPart[] } {
  const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const characters = (text: string): string[] => Array.from(graphemes.segment(text), item => item.segment);
  const blocks = compare(lines(before), lines(after));
  const refined: DiffPart[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (block.kind === 'remove' && next?.kind === 'add') {
      for (const part of compare(characters(block.text), characters(next.text))) append(refined, part.text, part.kind);
      index++;
    } else append(refined, block.text, block.kind);
  }
  return {
    before: refined.filter(part => part.kind !== 'add').map(part => ({ text: part.text, changed: part.kind === 'remove' })),
    after: refined.filter(part => part.kind !== 'remove').map(part => ({ text: part.text, changed: part.kind === 'add' })),
  };
}
