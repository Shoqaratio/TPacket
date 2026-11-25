import { describe, expect, it } from 'vitest';
import { editLine } from './lineEditor';

describe('terminal line editing', () => {
  it('moves within the command and inserts or deletes at the cursor', () => {
    let line = { text: 'show ip route', cursor: 5 };
    line = editLine(line, { type: 'insert', text: 'version ' });
    expect(line).toEqual({ text: 'show version ip route', cursor: 13 });
    line = editLine(line, { type: 'move', direction: 'left' });
    line = editLine(line, { type: 'delete', direction: 'backward' });
    expect(line.text).toBe('show versio ip route');
  });

  it('supports Home/End and Ctrl+W word deletion', () => {
    let line = { text: 'show ip route', cursor: 13 };
    line = editLine(line, { type: 'delete', direction: 'word' });
    expect(line).toEqual({ text: 'show ip ', cursor: 8 });
    line = editLine(line, { type: 'move', direction: 'start' });
    line = editLine(line, { type: 'move', direction: 'end' });
    expect(line.cursor).toBe(line.text.length);
  });
});
