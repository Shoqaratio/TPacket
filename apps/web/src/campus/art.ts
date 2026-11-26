import type { CampusMap } from './map';

export const TILE = 24;
export const colors = ['#62d7ff', '#f5a5c8', '#b6e37b', '#ffc977', '#baabff', '#e8edf7'];
const floors = ['#405d70', '#655777', '#506a64', '#3e6472', '#454c69', '#356a71'];

export function paintCampus(ctx: CanvasRenderingContext2D, map: CampusMap) {
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  map.grid.forEach((row, iy) => [...row].forEach((tile, ix) => {
    const x = ix * TILE;
    const y = iy * TILE;
    const room = map.rooms.find(r => ix > r.x && ix < r.x + r.w - 1 && iy > r.y && iy < r.y + r.h - 1);
    if (tile === '#') {
      rect(x, y, TILE, TILE, '#101a2a');
      const edge = [map.grid[iy - 1]?.[ix], map.grid[iy + 1]?.[ix], row[ix - 1], row[ix + 1]].some(t => t && t !== '#');
      if (edge) {
        rect(x, y + 3, TILE, 13, '#263851');
        rect(x, y + 2, TILE, 3, '#445c77');
        rect(x, y + 16, TILE, 5, '#172337');
        rect(x + 2, y + 20, 20, 2, '#0a1220');
        rect(x + (iy % 2 ? 6 : 17), y + 6, 1, 9, '#17283e');
        rect(x + (iy % 2 ? 7 : 18), y + 6, 1, 9, '#38506c');
        if ((ix + iy) % 6 === 0) {
          rect(x + 7, y + 8, 10, 3, '#26303d');
          rect(x + 8, y + 9, 8, 1, '#6ca4af');
        }
      }
      return;
    }
    rect(x, y, TILE, TILE, '#253846');
    rect(x + 1, y + 1, 23, 23, room ? floors[map.rooms.indexOf(room) % floors.length]! : '#536e7e');
    rect(x + 2, y + 2, 21, 1, '#ffffff18');
    if ((ix + iy) % 2 === 0) rect(x + 1, y + 1, 23, 23, '#ffffff08');
    if (!room && (ix === 24 || ix === 30)) {
      rect(x + 11, y + 1, 2, 23, '#355969');
      if (iy % 3 === 0) rect(x + 10, y + 8, 4, 8, '#77a5aa');
    }
    if (room && iy === room.y + 4) rect(x + 1, y + 19, 23, 5, '#12264136');
    if (tile === '+') {
      rect(x, y, TILE, 3, '#a5e6e5');
      rect(x, y + 20, TILE, 4, '#204955');
      for (let stripe = 2; stripe < TILE; stripe += 5) rect(x + stripe, y + 19, 2, 2, '#c0dcca');
    }
    if (tile === 'p' || tile === 'd') {
      rect(x + 1, y + 9, 22, 15, '#172736');
      rect(x + 1, y + 8, 22, 10, '#ac785c');
      rect(x + 2, y + 8, 20, 2, '#e5a986');
      rect(x + 5, y + 1, 14, 11, '#162233');
      rect(x + 7, y + 3, 10, 7, tile === 'p' ? '#8df1e1' : '#5c98bf');
      rect(x + 8, y + 5, 6, 1, '#d2fff9');
      rect(x + 8, y + 14, 8, 2, '#2d3945');
      rect(x + 9, y + 20, 7, 4, '#265968');
    }
    if (tile === 'r') {
      rect(x + 4, y + 1, 16, 22, '#131d30');
      for (let slot = 0; slot < 3; slot++) {
        rect(x + 6, y + 4 + slot * 5, 12, 4, '#465775');
        rect(x + 13, y + 5 + slot * 5, 3, 1, '#86eabe');
      }
    }
    if (tile === 'v') {
      rect(x + 7, y + 13, 10, 10, '#985c58');
      rect(x + 5, y + 9, 14, 5, '#dc9776');
      rect(x + 10, y + 1, 4, 13, '#64a86a');
      rect(x + 4, y + 4, 8, 5, '#86c877');
      rect(x + 13, y + 6, 8, 4, '#a2d883');
    }
    if (tile === 's' || tile === 'w') {
      rect(x + 1, y + 8, 22, 15, '#233747');
      rect(x + 1, y + 6, 22, 10, '#678392');
      rect(x + 4, y + 10, 16, 5, '#23374b');
      for (let port = 0; port < 5; port++) rect(x + 5 + port * 3, y + 11, 2, 2, '#a4e3c4');
      if (tile === 'w') {
        rect(x + 4, y + 1, 2, 10, '#d1e2dd');
        rect(x + 18, y + 1, 2, 10, '#d1e2dd');
      }
    }
    if (tile === 'b') {
      rect(x + 1, y + 4, 22, 15, '#33283e');
      rect(x + 2, y + 5, 20, 10, '#72586d');
      rect(x + 3, y + 6, 18, 2, '#b77b87');
      rect(x + 4, y + 18, 3, 4, '#202b40');
      rect(x + 17, y + 18, 3, 4, '#202b40');
    }
    if (tile === 'c') {
      rect(x + 4, y + 2, 16, 21, '#23334a');
      rect(x + 5, y + 3, 14, 18, '#9b5b6d');
      rect(x + 7, y + 5, 9, 9, '#21354e');
      rect(x + 8, y + 7, 2, 4, '#8fdad8');
      rect(x + 12, y + 8, 2, 4, '#f6d799');
      rect(x + 8, y + 16, 8, 3, '#452d47');
    }
  }));
  ctx.font = 'bold 12px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const room of map.rooms) {
    const x = (room.x + room.w / 2) * TILE;
    const y = (room.y + 0.55) * TILE;
    rect(x - 109, y - 9, 218, 19, '#111e30');
    rect(x - 109, y + 8, 218, 2, '#70b6c0');
    rect(x - 108, y - 5, 3, 11, '#32546a');
    rect(x + 105, y - 5, 3, 11, '#32546a');
    ctx.fillStyle = '#e0f4ef';
    ctx.fillText(room.name.toLocaleUpperCase('fr'), Math.round(x), Math.round(y));
    if (room.id === 'lecture' || room.id === 'network') {
      rect(x + 128, y - 8, 62, 17, '#745d54');
      rect(x + 130, y - 7, 58, 13, '#254a43');
      rect(x + 138, y - 3, 24, 1, '#9fc6ad');
      rect(x + 138, y, 38, 1, '#91b7ab');
    }
  }
  const [x, y] = map.spawn;
  const cx = (x + 0.5) * TILE;
  const cy = (y + 0.5) * TILE;
  rect(cx - 41, cy - 81, 82, 146, '#253e50');
  rect(cx - 39, cy - 79, 78, 142, '#2f5361');
  rect(cx - 37, cy - 78, 2, 140, '#70a8a5');
  rect(cx + 35, cy - 78, 2, 140, '#70a8a5');
  for (let i = -2; i <= 2; i++) {
    const r = 14 - Math.abs(i) * 5;
    rect(cx - r, cy + i * 6 - 9, r * 2, 5, '#356471');
  }
  rect(cx - 8, cy - 21, 16, 2, '#75bbbc');
  rect(cx - 17, cy - 11, 34, 2, '#75bbbc');
  rect(cx - 8, cy + 1, 16, 2, '#75bbbc');
  ctx.fillStyle = '#d5eeed';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('TPACKET', cx, cy - 57);
  ctx.fillStyle = '#93c8cc';
  ctx.fillText('HALL', cx, cy - 43);
}

export function paintAvatar(ctx: CanvasRenderingContext2D, color: string, direction: string, phase: number) {
  const rect = (x: number, y: number, w: number, h: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
  };
  const stride = phase === 1 ? 2 : phase === 2 ? -2 : 0;
  rect(3, 21, 12, 3, '#15213280');
  rect(5, 18, 3, 4 + stride, '#1c2b46');
  rect(10, 18, 3, 4 - stride, '#1c2b46');
  rect(4, 11, 10, 8, '#18263a');
  rect(5, 11, 8, 6, color);
  rect(2, 12, 3, 5, color);
  rect(13, 12, 3, 5, color);
  rect(4, 3, 10, 8, '#283044');
  rect(6, 2, 6, 2, '#684658');
  if (direction !== 'up') {
    rect(5, 6, 8, 5, '#ecb996');
    if (direction !== 'right') rect(6, 7, 1, 2, '#29253a');
    if (direction !== 'left') rect(11, 7, 1, 2, '#29253a');
  }
}
