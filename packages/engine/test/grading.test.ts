import { describe, expect, it } from 'vitest';
import { grade, requiresMessage, type Rubric } from '../src';
import { cli, twoRouters } from './helpers';

const rubric: Rubric = {
  title: 'Deux réseaux reliés par une liaison série',
  maxScore: 20,
  criteria: [
    { id: 'ip', type: 'interface_address', device: 'Router0', interface: 'g0/0', expected: '192.168.1.1/24', points: 3 },
    { id: 'route', type: 'route_exists', device: 'Router0', destination: '192.168.2.0/24', points: 4 },
    { id: 'conn', type: 'connectivity_test', source: 'PC0', destination: 'PC1', expected: 'success', points: 5, required: true },
    { id: 'secret', type: 'enable_secret', device: 'Router0', points: 4, hidden: true },
    { id: 'save', type: 'configuration_saved', device: 'Router0', points: 4, dependsOn: ['secret'] },
  ],
};

describe('grader', () => {
  it('awards partial points from real behaviour', () => {
    const { net } = twoRouters();
    const report = grade(structuredClone(net.serialize()), rubric);
    const by = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(by.ip!.passed && by.route!.passed && by.conn!.passed).toBe(true);
    expect(by.secret!.passed).toBe(false);
    expect(by.save!.skipped).toBe(true);
    // 'save' is visible but depends on the hidden 'secret': its id must not leak.
    expect(by.save!.message).toBe('Requires: 1 hidden criterion');
    expect(JSON.stringify(by.save)).not.toContain('secret');
    expect(report.score).toBe(12);
    expect(report.completed).toBe(true);
    expect(report.results.find((r) => r.id === 'secret')!.hidden).toBe(true);
  });

  it('full marks when everything is configured and saved', () => {
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'enable secret class', 'end', 'write memory']);
    expect(grade(structuredClone(net.serialize()), rubric).score).toBe(20);
  });

  it('accepts an alternative valid solution (default route instead of a specific route) for connectivity', () => {
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'ip route 0.0.0.0 0.0.0.0 Serial0/0/0', 'end']);
    const r = grade(structuredClone(net.serialize()), rubric);
    expect(r.results.find((x) => x.id === 'conn')!.passed).toBe(true);
    expect(r.results.find((x) => x.id === 'route')!.passed).toBe(false);
  });

  it('a graded submission is reproducible', () => {
    const { net } = twoRouters();
    const doc = structuredClone(net.serialize());
    expect(grade(structuredClone(doc), rubric)).toEqual(grade(structuredClone(doc), rubric));
  });

  it('isolation criteria and penalties', () => {
    const { net } = twoRouters({ routes: false });
    const r = grade(structuredClone(net.serialize()), {
      maxScore: 10,
      criteria: [
        { id: 'iso', type: 'connectivity_test', source: 'PC0', destination: '192.168.2.10', expected: 'failure', points: 10 },
        { id: 'pen', type: 'route_exists', device: 'Router0', destination: '192.168.1.0/24', via: 'connected', points: 3, penalty: true },
      ],
    });
    expect(r.results[0]!.passed).toBe(true);
    expect(r.score).toBe(7);
  });

  it('penalties: dependencies, feedback and completion follow the student outcome', () => {
    const { net } = twoRouters({ routes: false });
    const r = grade(structuredClone(net.serialize()), {
      maxScore: 10,
      criteria: [
        // Triggered: Router0 does have this connected route.
        { id: 'hit', type: 'route_exists', device: 'Router0', destination: '192.168.1.0/24', via: 'connected', points: 2, penalty: true, required: true, feedback: 'remove it' },
        // Avoided: no such static route exists.
        { id: 'miss', type: 'route_exists', device: 'Router0', destination: '10.99.0.0/16', via: 'static', points: 2, penalty: true, feedback: 'never shown' },
        { id: 'afterHit', type: 'hostname', device: 'Router0', expected: 'Router0', points: 5, dependsOn: ['hit'] },
        { id: 'afterMiss', type: 'hostname', device: 'Router0', expected: 'Router0', points: 5, dependsOn: ['miss'] },
      ],
    });
    const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(by.hit!.passed).toBe(false);
    expect(by.hit!.earned).toBe(-2);
    expect(by.hit!.feedback).toBe('remove it');
    expect(by.miss!.passed).toBe(true);
    expect(by.miss!.earned).toBe(0);
    expect(by.miss!.feedback).toBeUndefined();
    expect(by.afterHit!.skipped).toBe(true);
    expect(by.afterMiss!.skipped).toBe(false);
    expect(r.completed).toBe(false);
  });

  it('rejects a malformed dependsOn', () => {
    const { net } = twoRouters();
    expect(() => grade(net.serialize(), { maxScore: 5, criteria: [{ id: 'x', type: 'hostname', device: 'Router0', expected: 'R', points: 1, dependsOn: 'y' as never }] })).toThrow();
  });

  it('rejects malformed rubrics', () => {
    const { net } = twoRouters();
    expect(() => grade(net.serialize(), { maxScore: 20, criteria: [{ id: 'x', type: 'rm -rf', points: 1 }] })).toThrow();
  });
});

describe('requiresMessage', () => {
  it('lists visible dependencies and only counts hidden ones', () => {
    const hidden = new Set(['h1', 'h2']);
    expect(requiresMessage(['a', 'b'], hidden)).toBe('Requires: a, b');
    expect(requiresMessage(['a', 'h1'], hidden)).toBe('Requires: a (+1 hidden criterion)');
    expect(requiresMessage(['h1', 'h2'], hidden)).toBe('Requires: 2 hidden criteria');
  });
});
