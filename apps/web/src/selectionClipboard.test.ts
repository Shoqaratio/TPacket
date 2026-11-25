import { describe, expect, it } from 'vitest';
import { addDevice, createProject, validateProject } from '@netlab/engine';
import { decodeSelection, encodeSelection, selectionProject } from './selectionClipboard';

describe('selection clipboard', () => {
  it('keeps only selected devices and their internal links, and round-trips safely', () => {
    const source = createProject('source');
    const a = addDevice(source, 'PC', 0, 0);
    const b = addDevice(source, 'IP-Phone-PT', 200, 0);
    const c = addDevice(source, 'PC', 400, 0);
    source.links.push({
      id: 'l1', cable: 'crossover',
      a: { device: a.id, port: 'FastEthernet0' }, b: { device: b.id, port: 'FastEthernet0' },
    });
    source.links.push({
      id: 'l2', cable: 'crossover',
      a: { device: b.id, port: 'FastEthernet0' }, b: { device: c.id, port: 'FastEthernet0' },
    });
    source.links.splice(1, 1);

    const selection = selectionProject(source, [a.id, b.id]);
    expect(selection.devices.map((d) => d.model)).toEqual(['PC', 'IP-Phone-PT']);
    expect(selection.links).toHaveLength(1);
    expect(decodeSelection(encodeSelection(source, [a.id, b.id]))).toEqual(validateProject(selection));
  });

  it('includes endpoints when copying a selected cable and rejects arbitrary text', () => {
    const source = createProject('source');
    const a = addDevice(source, 'PC', 0, 0);
    const b = addDevice(source, 'PC', 100, 0);
    source.links.push({ id: 'l1', cable: 'crossover', a: { device: a.id, port: 'FastEthernet0' }, b: { device: b.id, port: 'FastEthernet0' } });
    expect(decodeSelection(encodeSelection(source, ['l1'])).devices).toHaveLength(2);
    expect(() => decodeSelection('hello')).toThrow('Clipboard does not contain a TPacket selection');
  });
});
