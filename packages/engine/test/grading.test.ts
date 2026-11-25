import { describe, expect, it } from 'vitest';
import { grade, type Rubric } from '../src';
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

  it('rejects malformed rubrics', () => {
    const { net } = twoRouters();
    expect(() => grade(net.serialize(), { maxScore: 20, criteria: [{ id: 'x', type: 'rm -rf', points: 1 }] })).toThrow();
  });
});
