export interface Point { x: number; y: number }
export interface Room extends Point {
  id: string;
  name: string;
  topic: string;
  w: number;
  h: number;
  door: [number, number];
  station: [number, number];
}
export interface CampusMap {
  grid: string[];
  spawn: [number, number];
  rooms: Room[];
  guides: (Point & { room: string; name: string; role: string; hints: string[] })[];
}
export interface Player extends Point {
  id: string;
  name: string;
  direction: 'up' | 'down' | 'left' | 'right';
  staff?: boolean;
  color: number;
  status: '' | 'help' | 'done' | 'working';
  emote: number;
}

export const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
export const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const roomAt = (map: CampusMap, p: Point) => map.rooms.find((r) =>
  p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
export function walkable(map: CampusMap, p: Point, staff: boolean, closed: string[] = []) {
  const tile = map.grid[p.y]?.[p.x];
  if (tile !== '.' && tile !== ':' && tile !== '+') return false;
  const room = roomAt(map, p);
  return staff || !room || (room.id !== 'staff' && !closed.includes(room.id));
}

export function pathTo(map: CampusMap, start: Point, goal: Point, staff: boolean, closed: string[] = []): Point[] {
  if (!walkable(map, goal, staff, closed)) return [];
  const width = map.grid[0]!.length;
  const id = (p: Point) => p.x + p.y * width;
  const open = [{ point: start, cost: 0, estimate: distance(start, goal) }];
  const cost = new Map([[id(start), 0]]);
  const parent = new Map<number, Point>();
  while (open.length) {
    open.sort((a, b) => b.estimate - a.estimate);
    const next = open.pop()!;
    if (next.cost !== cost.get(id(next.point))) continue;
    if (same(next.point, goal)) {
      const path = [];
      let point = goal;
      while (!same(point, start)) {
        path.push(point);
        point = parent.get(id(point))!;
      }
      return path.reverse();
    }
    const { x, y } = next.point;
    for (const point of [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }]) {
      const step = next.cost + 1;
      if (!walkable(map, point, staff, closed) || step >= (cost.get(id(point)) ?? Infinity)) continue;
      cost.set(id(point), step);
      parent.set(id(point), next.point);
      open.push({ point, cost: step, estimate: step + distance(point, goal) });
    }
  }
  return [];
}
