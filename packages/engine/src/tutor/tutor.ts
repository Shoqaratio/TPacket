/**
 * TPacket Tutor — deterministic, rule-based diagnosis (no generative AI).
 *
 * Follows the path a datagram would take hop by hop using the live state of the simulator
 * (interfaces, broadcast domains, routing tables, ACLs), on the way out AND back, and turns the
 * first problem found into five progressive hints:
 *   1 orientation · 2 theory · 3 location · 4 detailed explanation · 5 full correction.
 */
import { classfulMask, ipToString, maskToPrefix, networkOf, parseIp, prefixToMask } from '../net/ipv4';
import type { Network, RtDevice } from '../sim/network';
import type { Ipv4Pkt } from '../sim/packets';

export type Locale = 'fr' | 'en';

export interface Diagnosis {
  ok: boolean;
  code: string;
  device?: string;
  /** Five hints, from orientation to full correction. */
  hints: string[];
  /** Devices crossed before the problem (names), for display. */
  path: string[];
}

type P = Record<string, string>;
type Texts = Record<string, (p: P) => [string, string, string, string, string]>;

const FR: Texts = {
  ok: (p) => [
    `Le chemin de ${p.src} vers ${p.dst} semble correct dans les deux sens.`,
    'Un ping réussit quand la requête ET la réponse trouvent leur chemin.',
    'Aucune anomalie détectée sur le chemin aller ni sur le retour.',
    `Si le premier ping échoue, c'est normal : les routeurs abandonnent le paquet qui déclenche la résolution ARP. Relance le ping.`,
    'Aucune correction nécessaire.',
  ],
  src_off: (p) => [`Observe ${p.src}.`, 'Un équipement éteint ne peut rien émettre.', `${p.src} est éteint.`, `Allume ${p.src} (onglet Physique).`, `Mets ${p.src} sous tension dans l'onglet Physique.`],
  src_no_ip: (p) => [`Commence par la configuration de ${p.src}.`, 'Pour communiquer en IPv4, une machine a besoin d’une adresse et d’un masque.', `${p.src} n'a pas d'adresse IPv4 valide.`, `Vérifie avec ipconfig : l'adresse ou le masque de ${p.src} est absent.`, `Configure ${p.src} avec une adresse du réseau ${p.net ?? 'prévu'} et le bon masque (Bureau › Configuration IP).`],
  src_link_down: (p) => [`Regarde la connexion physique de ${p.src}.`, 'La couche 1 doit être opérationnelle (voyant vert) avant tout échange.', `L'interface ${p.iface} de ${p.src} est inactive (${p.state}).`, `Câble absent, mauvais type de câble (droit/croisé), port désactivé (shutdown) ou équipement voisin éteint : vérifie le voyant du lien.`, p.fix ?? `Rends le lien opérationnel sur ${p.src} ${p.iface}.`],
  no_gateway: (p) => [`${p.dst} n'est pas sur le même réseau que ${p.src} : pense à la passerelle.`, 'Pour joindre un autre réseau, un hôte envoie le paquet à sa passerelle par défaut.', `${p.src} n'a pas de passerelle par défaut utilisable.`, `La passerelle doit être l'adresse du routeur sur le réseau de ${p.src} (${p.net}).`, `Définis la passerelle de ${p.src} : ${p.gw ?? 'adresse IP du routeur sur ce réseau'}.`],
  gateway_wrong_subnet: (p) => [`Vérifie la passerelle de ${p.src}.`, 'La passerelle doit appartenir au même sous-réseau que l’hôte.', `La passerelle ${p.gw} n'est pas dans le réseau ${p.net} de ${p.src}.`, 'Compare l’adresse, le masque et la passerelle avec ipconfig.', `Corrige la passerelle de ${p.src} (adresse du routeur dans ${p.net}) ou son masque.`],
  l2_unreachable: (p) => [`Le problème se situe entre ${p.from} et ${p.to}.`, 'Deux équipements d’un même réseau doivent partager le même domaine de diffusion (même VLAN, liens actifs, trunk autorisé).', `${p.from} ne peut pas atteindre ${p.to} (${p.ip}) au niveau 2.`, `Vérifie sur les switchs : show vlan brief (port dans le bon VLAN ?), show interfaces trunk (VLAN autorisé ?), l'état des liens et du spanning-tree.`, p.fix ?? `Place ${p.from} et ${p.to} dans le même VLAN et vérifie les trunks entre les switchs.`],
  no_route: (p) => [`Regarde la table de routage de ${p.device}.`, 'Un routeur ne transmet un paquet que s’il possède une route vers le réseau de destination (la plus spécifique l’emporte).', `${p.device} ne connaît aucune route vers ${p.dst}.`, `Sur ${p.device}, show ip route ne contient aucune entrée couvrant ${p.dst} : ajoute une route statique, une route par défaut ou un protocole de routage (RIP/OSPF).`, p.fix ? `Sur ${p.device} : ${p.fix}` : `Ajoute sur ${p.device} une route vers ${p.net}.`],
  acl: (p) => [`Une règle de sécurité intervient sur ${p.device}.`, 'Une ACL est lue de haut en bas ; la première règle qui correspond décide, et tout se termine par un deny implicite.', `L'ACL ${p.acl} appliquée en ${p.dir === 'in' ? 'entrée' : 'sortie'} de ${p.iface} sur ${p.device} bloque ce trafic.`, `Consulte show access-lists sur ${p.device} : aucune entrée ne permet ${p.src} → ${p.dst} (deny implicite) ou une entrée deny correspond.`, `Sur ${p.device}, ajoute une règle permit adaptée avant le deny dans l'ACL ${p.acl}, ou retire « ip access-group ${p.acl} ${p.dir} » de ${p.iface} si elle n'est pas voulue.`],
  iface_down: (p) => [`Vérifie l'état des interfaces de ${p.device}.`, 'Une interface doit être up/up pour transmettre ; les interfaces de routeur sont désactivées par défaut.', `L'interface ${p.iface} de ${p.device} est ${p.state}.`, `show ip interface brief sur ${p.device} : ${p.iface} n'est pas up/up (shutdown, câble, horloge série DCE…).`, p.fix ?? `Sur ${p.device} : interface ${p.iface} puis no shutdown.`],
  loop: (p) => [`Le paquet tourne en rond.`, 'Une boucle de routage apparaît quand deux routeurs se renvoient mutuellement le paquet ; le TTL finit par expirer.', `Boucle détectée entre ${p.device} et ${p.next}.`, `Compare show ip route sur ${p.device} et ${p.next} : chacun pointe vers l'autre pour ${p.dst}.`, `Corrige la route vers ${p.net} sur l'un des deux routeurs.`],
  return_path: (p) => [`L'aller fonctionne : regarde le chemin du retour.`, 'La réponse doit elle aussi trouver une route vers la source.', `Le retour de ${p.dst} vers ${p.src} échoue : ${p.detail}`, `Applique le même raisonnement depuis la destination : passerelle de l'hôte distant, routes des routeurs vers le réseau de ${p.src}.`, p.fix ?? `Ajoute la route de retour vers le réseau de ${p.src}.`],
  dst_unknown: (p) => [`Vérifie l'adresse de destination ${p.dst}.`, 'L’adresse doit appartenir à un équipement allumé.', `Aucun équipement allumé ne possède l'adresse ${p.dst}.`, 'Contrôle l’adresse saisie et la configuration IP de la machine cible.', `Configure l'adresse ${p.dst} sur la machine cible ou corrige la destination.`],
};

const EN: Texts = {
  ok: (p) => [`The path from ${p.src} to ${p.dst} looks correct both ways.`, 'A ping succeeds when the request AND the reply find their way.', 'No anomaly on the forward or return path.', 'If the first ping fails, that is expected: routers drop the packet that triggers ARP. Ping again.', 'No correction needed.'],
  src_off: (p) => [`Look at ${p.src}.`, 'A powered-off device cannot send anything.', `${p.src} is powered off.`, `Turn ${p.src} on (Physical tab).`, `Power ${p.src} on in the Physical tab.`],
  src_no_ip: (p) => [`Start with ${p.src}'s configuration.`, 'IPv4 needs an address and a mask.', `${p.src} has no valid IPv4 address.`, `Check with ipconfig: ${p.src}'s address or mask is missing.`, `Configure ${p.src} with an address in ${p.net ?? 'the planned network'} and the right mask.`],
  src_link_down: (p) => [`Check ${p.src}'s physical connection.`, 'Layer 1 must be up (green LED) first.', `${p.src} interface ${p.iface} is down (${p.state}).`, 'Missing cable, wrong cable type, shutdown port or neighbour powered off: check the link LED.', p.fix ?? `Bring ${p.src} ${p.iface} up.`],
  no_gateway: (p) => [`${p.dst} is not on ${p.src}'s network: think about the gateway.`, 'To reach another network a host sends to its default gateway.', `${p.src} has no usable default gateway.`, `The gateway must be the router's address on ${p.src}'s network (${p.net}).`, `Set ${p.src}'s gateway to ${p.gw ?? "the router's address on this network"}.`],
  gateway_wrong_subnet: (p) => [`Check ${p.src}'s gateway.`, 'The gateway must be in the host’s subnet.', `Gateway ${p.gw} is outside ${p.src}'s network ${p.net}.`, 'Compare address, mask and gateway with ipconfig.', `Fix ${p.src}'s gateway or mask.`],
  l2_unreachable: (p) => [`The problem is between ${p.from} and ${p.to}.`, 'Devices of one network must share a broadcast domain (same VLAN, active links, allowed on trunks).', `${p.from} cannot reach ${p.to} (${p.ip}) at layer 2.`, 'On the switches: show vlan brief, show interfaces trunk, link and spanning-tree states.', p.fix ?? `Put ${p.from} and ${p.to} in the same VLAN and check trunks.`],
  no_route: (p) => [`Look at ${p.device}'s routing table.`, 'A router forwards only if it has a route to the destination (longest prefix wins).', `${p.device} has no route to ${p.dst}.`, `show ip route on ${p.device} has nothing covering ${p.dst}: add a static/default route or a routing protocol.`, p.fix ? `On ${p.device}: ${p.fix}` : `Add a route to ${p.net} on ${p.device}.`],
  acl: (p) => [`A security rule acts on ${p.device}.`, 'ACLs are read top-down; first match wins; implicit deny at the end.', `ACL ${p.acl} (${p.dir}) on ${p.device} ${p.iface} blocks this traffic.`, `show access-lists on ${p.device}: no permit matches ${p.src} → ${p.dst}.`, `Add a suitable permit before the deny in ACL ${p.acl}, or remove "ip access-group ${p.acl} ${p.dir}" from ${p.iface}.`],
  iface_down: (p) => [`Check ${p.device}'s interfaces.`, 'An interface must be up/up; router interfaces are shut by default.', `${p.device} ${p.iface} is ${p.state}.`, `show ip interface brief on ${p.device}: ${p.iface} is not up/up.`, p.fix ?? `On ${p.device}: interface ${p.iface}, no shutdown.`],
  loop: (p) => ['The packet is looping.', 'A routing loop happens when routers send the packet back and forth until TTL expires.', `Loop between ${p.device} and ${p.next}.`, `Compare show ip route on ${p.device} and ${p.next}.`, `Fix the route to ${p.net} on one of them.`],
  return_path: (p) => ['The forward path works: check the way back.', 'The reply also needs a route to the source.', `The return from ${p.dst} to ${p.src} fails: ${p.detail}`, 'Reason from the destination: remote host gateway, routes back to the source network.', p.fix ?? `Add the return route to ${p.src}'s network.`],
  dst_unknown: (p) => [`Check destination ${p.dst}.`, 'The address must belong to a powered device.', `No powered device owns ${p.dst}.`, 'Check the address and the target’s IP configuration.', `Configure ${p.dst} on the target or fix the destination.`],
};

function owner(net: Network, ip: number): RtDevice | undefined {
  for (const d of net.devices.values()) if (d.doc.powered && net.l3Ifs(d).some((i) => i.ip === ip)) return d;
  return undefined;
}

function stateOf(net: Network, d: RtDevice, iface: string): string {
  const st = d.ios ? net.ifStatus(d, iface) : net.portStatus(d.doc.id, iface);
  return st.adminDown ? 'administratively down' : st.l1 ? 'up/down' : 'down/down';
}

interface Problem {
  code: string;
  device?: RtDevice;
  params: P;
}

/** Walks from `src` toward `dst`. Returns the first problem, or null when the datagram arrives. */
function walk(net: Network, src: RtDevice, srcIp: number, dst: number, path: string[]): Problem | null {
  let cur = src;
  const seen = new Map<string, number>();
  const probe: Ipv4Pkt = { src: srcIp, dst, ttl: 64, proto: 'icmp', id: 0, icmp: { type: 8, code: 0, ident: 0, seq: 0 } };
  let ingress: string | undefined;
  for (let hop = 0; hop < 30; hop++) {
    path.push(cur.doc.name);
    seen.set(cur.doc.id, (seen.get(cur.doc.id) ?? 0) + 1);
    if (cur.ios && ingress) {
      const cfg = cur.ios.interfaces.get(ingress);
      if (cfg?.aclIn && !net.aclPermits(cur, cfg.aclIn, probe, false)) return { code: 'acl', device: cur, params: { device: cur.doc.name, acl: cfg.aclIn, dir: 'in', iface: ingress } };
    }
    if (net.l3Ifs(cur).some((i) => i.ip === dst)) return null;
    const r = net.resolve(cur, dst);
    if (!r) {
      if (cur.host) {
        const h = cur.host;
        const me = net.l3Ifs(cur)[0]!;
        const gw = parseIp(h.gateway);
        const lan = `${ipToString(networkOf(me.ip, me.mask))}/${maskToPrefix(me.mask)}`;
        const router = [...net.broadcastDomain(cur, me.name)].find((e) => e.dev.ios && networkOf(e.iface.ip, me.mask) === networkOf(me.ip, me.mask));
        if (gw === null) return { code: 'no_gateway', device: cur, params: { net: lan, ...(router ? { gw: ipToString(router.iface.ip) } : {}) } };
        return { code: 'gateway_wrong_subnet', device: cur, params: { gw: h.gateway, net: lan } };
      }
      // Root cause first: an interface configured on the destination subnet but not up/up.
      const local = net.l3Ifs(cur).find((i) => networkOf(dst, i.mask) === networkOf(i.ip, i.mask));
      if (local && !net.ifUp(cur, local.name)) {
        const st = net.ifStatus(cur, local.name);
        return { code: 'iface_down', device: cur, params: { device: cur.doc.name, iface: local.name, state: stateOf(net, cur, local.name), ...(st.adminDown ? { fix: `interface ${local.name} / no shutdown` } : {}) } };
      }
      const target = networkOf(dst, classfulMask(dst));
      let fix: string | undefined;
      // Suggest a next hop: a neighbouring router that knows the destination.
      for (const i of net.l3Ifs(cur)) {
        if (!net.ifUp(cur, i.name)) continue;
        for (const nb of net.broadcastDomain(cur, i.name)) {
          if (nb.dev === cur || !nb.dev.ios || !net.routingEnabled(nb.dev)) continue;
          const rr = net.resolve(nb.dev, dst);
          if (rr && rr.iface !== nb.iface.name) {
            const m = rr.route?.mask ?? prefixToMask(24);
            fix = `ip route ${ipToString(networkOf(dst, m))} ${ipToString(m)} ${ipToString(nb.iface.ip)}`;
            break;
          }
        }
        if (fix) break;
      }
      return { code: 'no_route', device: cur, params: { device: cur.doc.name, dst: ipToString(dst), net: ipToString(target), ...(fix ? { fix } : {}) } };
    }
    if (cur.ios) {
      const out = cur.ios.interfaces.get(r.iface);
      if (out?.aclOut && !net.aclPermits(cur, out.aclOut, probe, false)) return { code: 'acl', device: cur, params: { device: cur.doc.name, acl: out.aclOut, dir: 'out', iface: r.iface } };
    }
    if (!net.ifUp(cur, r.iface)) {
      return { code: cur.host ? 'src_link_down' : 'iface_down', device: cur, params: { device: cur.doc.name, iface: r.iface, state: stateOf(net, cur, r.iface) } };
    }
    const nextHopDev = owner(net, r.nextHop);
    const domain = net.broadcastDomain(cur, r.iface);
    const reach = domain.find((e) => e.iface.ip === r.nextHop);
    if (!reach) {
      if (!nextHopDev) return r.nextHop === dst ? { code: 'dst_unknown', params: { dst: ipToString(dst) } } : { code: 'l2_unreachable', device: cur, params: { from: cur.doc.name, to: ipToString(r.nextHop), ip: ipToString(r.nextHop) } };
      const st = nextHopDev.ios ? net.l3Ifs(nextHopDev).find((i) => i.ip === r.nextHop) : undefined;
      if (st && !net.ifUp(nextHopDev, st.name)) return { code: 'iface_down', device: nextHopDev, params: { device: nextHopDev.doc.name, iface: st.name, state: stateOf(net, nextHopDev, st.name) } };
      return { code: 'l2_unreachable', device: cur, params: { from: cur.doc.name, to: nextHopDev.doc.name, ip: ipToString(r.nextHop) } };
    }
    if ((seen.get(reach.dev.doc.id) ?? 0) >= 1 && reach.dev !== src) {
      return { code: 'loop', device: cur, params: { device: cur.doc.name, next: reach.dev.doc.name, dst: ipToString(dst), net: ipToString(networkOf(dst, classfulMask(dst))) } };
    }
    if (reach.dev.host && reach.iface.ip !== dst) return { code: 'l2_unreachable', device: cur, params: { from: cur.doc.name, to: reach.dev.doc.name, ip: ipToString(r.nextHop) } };
    ingress = reach.iface.name;
    cur = reach.dev;
  }
  return { code: 'loop', params: { device: cur.doc.name, next: '?', dst: ipToString(dst), net: ipToString(dst) } };
}

export function diagnose(net: Network, srcId: string, dstText: string, locale: Locale = 'fr'): Diagnosis {
  const T = locale === 'fr' ? FR : EN;
  const src = net.dev(srcId);
  const make = (code: string, params: P, path: string[], device?: string): Diagnosis => ({ ok: code === 'ok', code, ...(device ? { device } : {}), hints: T[code]!({ src: src.doc.name, dst: dstText, ...params }), path });
  if (!src.doc.powered) return make('src_off', {}, [], src.doc.name);
  const dst = parseIp(dstText) ?? (owner(net, 0) ? null : null);
  let dstIp = dst;
  if (dstIp === null) {
    const d = [...net.devices.values()].find((x) => x.doc.name.toLowerCase() === dstText.toLowerCase());
    dstIp = d ? (net.l3Ifs(d)[0]?.ip ?? null) : null;
  }
  if (dstIp === null) return make('dst_unknown', { dst: dstText }, []);
  const me = net.l3Ifs(src)[0];
  if (!me) return make('src_no_ip', {}, [], src.doc.name);
  if (src.host && !net.ifUp(src, me.name)) return make('src_link_down', { iface: me.name, state: stateOf(net, src, me.name) }, [], src.doc.name);
  const dstDev = owner(net, dstIp);
  if (!dstDev) return make('dst_unknown', { dst: ipToString(dstIp) }, []);
  const fwdPath: string[] = [];
  const fwd = walk(net, src, me.ip, dstIp, fwdPath);
  if (fwd) return make(fwd.code, { dst: ipToString(dstIp), ...fwd.params }, fwdPath, fwd.device?.doc.name);
  const backPath: string[] = [];
  const back = walk(net, dstDev, dstIp, me.ip, backPath);
  if (back) {
    const inner = T[back.code]!({ src: dstDev.doc.name, dst: ipToString(me.ip), ...back.params });
    return make('return_path', { dst: dstDev.doc.name, detail: inner[2], ...(back.params.fix ? { fix: `${back.device?.doc.name ?? ''} : ${back.params.fix}` } : {}) }, backPath, back.device?.doc.name);
  }
  return make('ok', { dst: ipToString(dstIp) }, fwdPath);
}
