import Phaser from 'phaser';
import { colors, paintAvatar, paintCampus, TILE } from './art';
import { distance, pathTo, same, walkable, type CampusMap, type Player, type Point } from './map';

export type Direction = 'up' | 'down' | 'left' | 'right';
export const directions: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};
const keys: Record<string, Direction> = {
  z: 'up', w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down',
  q: 'left', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right',
};
const emotes = ['', '👋', '👍', '💡', '🎉', '❓', '☕'];
const pixel = (tile: number) => (tile + 0.5) * TILE;
type Actor = { sprite: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text; target: Player; movingUntil: number };

interface Options {
  map: CampusMap;
  staff: boolean;
  userId: string;
  economy: boolean;
  reduced: () => boolean;
  blocked: () => boolean;
  zoom: () => number;
  closed: () => string[];
  step: (p: Point, direction: Direction) => void;
}

export function mountCampus(parent: HTMLElement, options: Options) {
  const { map } = options;
  const actors = new Map<string, Actor>();
  const held = new Map<string, Direction>();
  let peers: Player[] = [];
  let route: Point[] = [];
  let lastStep = -1000;
  let ownPoint: Point | undefined;
  let destination: Point | undefined;
  let queuedDirection: Direction | undefined;
  const clearKeys = () => {
    held.clear();
    queuedDirection = undefined;
  };
  const goTo = (goal: Point) => {
    if (!ownPoint) return;
    destination = goal;
    route = pathTo(map, ownPoint, goal, options.staff, options.closed());
    clearKeys();
  };

  const scene = new class extends Phaser.Scene {
    private doors: { node: Phaser.GameObjects.Rectangle; id: string; x: number; y: number }[] = [];
    private leds: Phaser.GameObjects.Rectangle[] = [];

    create() {
      const width = map.grid[0]!.length * TILE;
      const height = map.grid.length * TILE;
      const floor = this.textures.createCanvas('campus-floor', width, height)!;
      paintCampus(floor.context, map);
      floor.refresh();
      this.add.image(0, 0, 'campus-floor').setOrigin(0);
      this.cameras.main.setBounds(0, 0, width, height).centerOn(pixel(map.spawn[0]), pixel(map.spawn[1]));
      for (const room of map.rooms) {
        const [x, y] = room.door;
        const [sx, sy] = room.station;
        this.doors.push({ x, y, id: room.id, node: this.add.rectangle(pixel(x), pixel(y), 6, 18, 0x6ca1b1).setStrokeStyle(1, 0xaccad0) });
        this.leds.push(this.add.rectangle(pixel(sx) + 7, pixel(sy) + 3, 2, 2, 0x9fffe2));
      }
      const atlas = this.textures.createCanvas('campus-avatars', 18 * 12, 24 * colors.length)!;
      for (const [row, color] of colors.entries()) {
        for (const [facing, direction] of Object.keys(directions).entries()) {
          for (let phase = 0; phase < 3; phase++) {
            const x = (facing * 3 + phase) * 18;
            const y = row * 24;
            atlas.context.save();
            atlas.context.translate(x, y);
            paintAvatar(atlas.context, color, direction, phase);
            atlas.context.restore();
            atlas.add(`${row}-${direction}-${phase}`, 0, x, y, 18, 24);
          }
        }
      }
      atlas.refresh();
      for (const [index, guide] of map.guides.entries()) {
        const x = pixel(guide.x);
        const y = pixel(guide.y);
        this.add.image(x, y, 'campus-avatars', `${2 + index % 4}-down-0`).setOrigin(0.5, 0.75).setDepth(1);
        this.add.text(x, y - 17, guide.name, { fontFamily: 'monospace', fontSize: '10px', color: '#fff2b0' }).setOrigin(0.5, 1);
      }
      this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (options.blocked() || !ownPoint) return;
        const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const goal = { x: Math.floor(point.x / TILE), y: Math.floor(point.y / TILE) };
        if (map.grid[goal.y]?.[goal.x] === 'p') goal.y += 1;
        goTo(goal);
      });
      const press = (event: KeyboardEvent) => {
        const key = event.key.toLowerCase();
        const direction = keys[key];
        if (!direction || options.blocked() || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) return;
        event.preventDefault();
        if (!held.has(key)) {
          held.set(key, direction);
          queuedDirection = direction;
        }
        route = [];
        destination = undefined;
      };
      const release = (event: KeyboardEvent) => held.delete(event.key.toLowerCase());
      window.addEventListener('keydown', press);
      window.addEventListener('keyup', release);
      window.addEventListener('blur', clearKeys);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        window.removeEventListener('keydown', press);
        window.removeEventListener('keyup', release);
        window.removeEventListener('blur', clearKeys);
      });
    }

    override update(time: number, delta: number) {
      const reduced = options.reduced();
      this.cameras.main.setZoom(options.zoom());
      const live = new Set(peers.map(p => p.id));
      for (const [id, actor] of actors) {
        if (live.has(id)) continue;
        actor.sprite.destroy();
        actor.label.destroy();
        actors.delete(id);
        if (id === options.userId) {
          this.cameras.main.stopFollow();
          ownPoint = undefined;
        }
      }
      for (const peer of peers) {
        let actor = actors.get(peer.id);
        if (!actor) {
          const sprite = this.add.image(pixel(peer.x), pixel(peer.y), 'campus-avatars', '0-down-0').setOrigin(0.5, 0.75).setDepth(2);
          const label = this.add.text(sprite.x, sprite.y - 19, '', {
            color: '#f2ffff', fontFamily: 'monospace', fontSize: '11px', backgroundColor: '#13263edb', padding: { x: 3, y: 2 },
          }).setOrigin(0.5, 1).setDepth(3);
          actor = { sprite, label, target: peer, movingUntil: 0 };
          actors.set(peer.id, actor);
          if (peer.id === options.userId) this.cameras.main.startFollow(sprite, true, 0.25, 0.25);
        }
        if (!same(peer, actor.target)) actor.movingUntil = time + 210;
        actor.target = peer;
        const factor = reduced ? 1 : Math.min(delta / 95, 1);
        actor.sprite.x += (pixel(peer.x) - actor.sprite.x) * factor;
        actor.sprite.y += (pixel(peer.y) - actor.sprite.y) * factor;
        const phase = !reduced && time < actor.movingUntil ? 1 + Math.floor(time / 95) % 2 : 0;
        actor.sprite.setFrame(`${peer.color}-${peer.direction}-${phase}`);
        actor.label.setPosition(actor.sprite.x, actor.sprite.y - 15)
          .setText(`${peer.emote ? `${emotes[peer.emote]} ` : ''}${peer.status === 'help' ? '🛟 ' : peer.status === 'done' ? '✓ ' : peer.status === 'working' ? '⌨ ' : ''}${peer.name}`);
      }
      for (const door of this.doors) {
        const locked = options.closed().includes(door.id);
        door.node.setFillStyle(locked ? 0x8a515d : 0x6ca1b1);
        const open = (!locked || options.staff) && peers.some(p => distance(p, door) <= 1);
        door.node.scaleY = reduced ? 1 : Phaser.Math.Linear(door.node.scaleY, open ? 0.16 : 1, Math.min(delta / 65, 1));
        door.node.setAlpha(reduced && open ? 0.3 : 1);
      }
      for (const led of this.leds) led.setAlpha(reduced || Math.floor(time / 650) % 2 === 0 ? 1 : 0.25);
      const me = peers.find(p => p.id === options.userId);
      if (!me || options.blocked()) {
        clearKeys();
        if (!me) {
          route = [];
          destination = undefined;
        }
        return;
      }
      if (destination && (!ownPoint || !same(me, ownPoint))) route = pathTo(map, me, destination, options.staff, options.closed());
      ownPoint = me;
      if (time - lastStep < 170) return;
      const direction = queuedDirection ?? [...held.values()].at(-1);
      queuedDirection = undefined;
      const offset = direction ? directions[direction] : undefined;
      const next = offset ? { x: me.x + offset.x, y: me.y + offset.y } : route[0];
      if (!next || !walkable(map, next, options.staff, options.closed())) return;
      const facing = direction ?? (next.x > me.x ? 'right' : next.x < me.x ? 'left' : next.y > me.y ? 'down' : 'up');
      options.step(next, facing);
      lastStep = time;
    }
  }();

  const game = new Phaser.Game({
    type: Phaser.CANVAS, parent, scene, backgroundColor: '#101a2a', pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    fps: { target: options.economy ? 30 : 60, limit: options.economy ? 30 : 60 },
  });
  return {
    suspend: (suspended: boolean) => {
      if (suspended) game.loop.sleep();
      else game.loop.wake();
    },
    update: (players: Player[]) => { peers = players; },
    goTo,
    hold: (direction: Direction, on: boolean) => {
      if (on) {
        held.set('touch', direction);
        queuedDirection = direction;
        route = [];
        destination = undefined;
      } else held.delete('touch');
    },
    destroy: () => game.destroy(true),
  };
}
