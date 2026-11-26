import { describe, expect, it } from 'vitest';
import { pathTo, walkable, type CampusMap } from './map';

const map: CampusMap = {
  grid: ['#######', '#..#..#', '#..+..#', '#..#..#', '#######'],
  spawn: [1, 1],
  guides: [],
  rooms: [{ id: 'staff', name: 'Staff', topic: '', x: 4, y: 1, w: 2, h: 3, door: [3, 2], station: [5, 1] }],
};

describe('campus navigation', () => {
  it('uses the shortest orthogonal route through an opening', () => {
    const path = pathTo(map, { x: 2, y: 1 }, { x: 4, y: 1 }, true);
    expect(path).toEqual([{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 1 }]);
  });

  it('rejects walls, outside positions, and student routes to staff', () => {
    expect(walkable(map, { x: 3, y: 1 }, true)).toBe(false);
    expect(walkable(map, { x: -1, y: 2 }, true)).toBe(false);
    expect(pathTo(map, { x: 1, y: 1 }, { x: 5, y: 3 }, false)).toEqual([]);
  });
});
