export interface LineBuffer {
  text: string;
  cursor: number;
}

export type LineEdit =
  | { type: 'insert'; text: string }
  | { type: 'move'; direction: 'left' | 'right' | 'start' | 'end' }
  | { type: 'delete'; direction: 'backward' | 'forward' | 'word' };

export function editLine(buffer: LineBuffer, edit: LineEdit): LineBuffer {
  const { text, cursor } = buffer;
  if (edit.type === 'move') {
    const next = edit.direction === 'left' ? cursor - 1
      : edit.direction === 'right' ? cursor + 1
        : edit.direction === 'start' ? 0 : text.length;
    return { text, cursor: Math.max(0, Math.min(text.length, next)) };
  }
  if (edit.type === 'insert') {
    return { text: text.slice(0, cursor) + edit.text + text.slice(cursor), cursor: cursor + edit.text.length };
  }
  if (edit.direction === 'backward') {
    if (cursor === 0) return buffer;
    return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }
  if (edit.direction === 'forward') {
    if (cursor === text.length) return buffer;
    return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  }
  let start = cursor;
  while (start > 0 && /\s/.test(text[start - 1]!)) start--;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  return { text: text.slice(0, start) + text.slice(cursor), cursor: start };
}
