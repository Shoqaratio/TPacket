import { addDevice, addLink, createProject, type ProjectDoc } from '@netlab/engine';

export interface LocalizedText {
  fr: string;
  en: string;
}

export interface StarterCourse {
  id: string;
  title: LocalizedText;
  summary: LocalizedText;
  durationMinutes: number;
  objectives: LocalizedText[];
  lessons: { title: LocalizedText; body: LocalizedText; takeaway: LocalizedText }[];
}

interface DeviceSeed {
  model: string;
  x: number;
  y: number;
}

type LinkSeed = readonly [number, string, number, string];

export interface StarterExercise {
  id: string;
  title: LocalizedText;
  summary: LocalizedText;
  statement: LocalizedText;
  durationMinutes: number;
  makeProject(title: string, statement: string): ProjectDoc;
}

export function localizedText(value: LocalizedText, locale: string): string {
  return locale === 'en' ? value.en : value.fr;
}

export const starterCourses: StarterCourse[] = [
  {
    id: 'network-basics',
    title: { fr: 'Fondamentaux des réseaux', en: 'Networking fundamentals' },
    summary: {
      fr: 'Découvrez les équipements, les échanges sur un réseau local et le rôle des modèles en couches.',
      en: 'Learn about network devices, local network communication and layered models.',
    },
    durationMinutes: 25,
    objectives: [
      { fr: 'Différencier un switch, un routeur et un point d’accès.', en: 'Distinguish a switch, a router and an access point.' },
      { fr: 'Décrire l’encapsulation avec le modèle TCP/IP.', en: 'Describe encapsulation with the TCP/IP model.' },
      { fr: 'Expliquer le rôle des adresses MAC et du protocole ARP.', en: 'Explain the role of MAC addresses and ARP.' },
    ],
    lessons: [
      {
        title: { fr: 'Les équipements et leurs rôles', en: 'Devices and their roles' },
        body: {
          fr: 'Les terminaux (PC, téléphones, serveurs) produisent ou reçoivent les données. Un switch relie les équipements d’un même réseau local et transmet les trames selon les adresses MAC. Un routeur relie des réseaux IP différents. Un point d’accès connecte les clients sans fil au réseau.',
          en: 'End devices (PCs, phones and servers) send or receive data. A switch connects devices on a local network and forwards frames using MAC addresses. A router connects different IP networks. An access point connects wireless clients to the network.',
        },
        takeaway: {
          fr: 'Switch : réseau local. Routeur : passage entre réseaux IP.',
          en: 'Switch: local network. Router: path between IP networks.',
        },
      },
      {
        title: { fr: 'Du message à la trame', en: 'From message to frame' },
        body: {
          fr: 'Le modèle TCP/IP organise la communication en couches : application, transport, Internet et accès réseau. Chaque couche ajoute les informations nécessaires à son travail. Une requête web devient ainsi des données transportées par TCP, dans des paquets IP puis des trames Ethernet.',
          en: 'The TCP/IP model organizes communication into application, transport, Internet and network-access layers. Each layer adds the information it needs. A web request is carried by TCP, inside IP packets, then Ethernet frames.',
        },
        takeaway: {
          fr: 'Encapsulation : chaque couche enveloppe les données de la précédente.',
          en: 'Encapsulation: each layer wraps the data from the layer above.',
        },
      },
      {
        title: { fr: 'Adresses MAC et ARP', en: 'MAC addresses and ARP' },
        body: {
          fr: 'Dans un LAN IPv4, un hôte connaît généralement l’adresse IP de sa destination, mais doit aussi trouver son adresse MAC pour lui envoyer une trame. ARP diffuse une question sur le LAN; le propriétaire de l’adresse IP répond avec sa MAC. Le switch apprend les MAC sources et les ports associés.',
          en: 'On an IPv4 LAN, a host usually knows its destination IP address but also needs its MAC address to send an Ethernet frame. ARP broadcasts a question on the LAN; the owner replies with its MAC. The switch learns source MAC addresses and their associated ports.',
        },
        takeaway: {
          fr: 'ARP résout IPv4 vers MAC sur le réseau local; le switch construit sa table MAC.',
          en: 'ARP resolves IPv4 to MAC on the local network; the switch builds its MAC table.',
        },
      },
    ],
  },
  {
    id: 'ipv4-subnets',
    title: { fr: 'IPv4 et calcul des sous-réseaux', en: 'IPv4 addressing and subnetting' },
    summary: {
      fr: 'Lisez un préfixe CIDR, trouvez les plages d’hôtes et configurez une passerelle.',
      en: 'Read a CIDR prefix, find host ranges and configure a default gateway.',
    },
    durationMinutes: 30,
    objectives: [
      { fr: 'Associer un préfixe CIDR à un masque IPv4.', en: 'Match a CIDR prefix to an IPv4 mask.' },
      { fr: 'Calculer l’adresse réseau, le broadcast et la plage d’hôtes.', en: 'Calculate the network, broadcast and host range.' },
      { fr: 'Expliquer pourquoi une passerelle est nécessaire entre deux sous-réseaux.', en: 'Explain why a gateway is needed between subnets.' },
    ],
    lessons: [
      {
        title: { fr: 'Adresse et préfixe', en: 'Address and prefix' },
        body: {
          fr: 'IPv4 utilise 32 bits, écrits en quatre octets décimaux. Le préfixe indique combien de bits identifient le réseau. Par exemple, /24 correspond au masque 255.255.255.0 : les 24 premiers bits sont communs au réseau.',
          en: 'IPv4 uses 32 bits, written as four decimal octets. The prefix tells how many bits identify the network. For example, /24 corresponds to 255.255.255.0: the first 24 bits are shared by the network.',
        },
        takeaway: {
          fr: 'Plus le préfixe est grand, plus le réseau est petit et contient moins d’hôtes.',
          en: 'The larger the prefix, the smaller the network and the fewer hosts it contains.',
        },
      },
      {
        title: { fr: 'Réseau, broadcast et hôtes', en: 'Network, broadcast and hosts' },
        body: {
          fr: 'Pour 192.168.10.64/26, le masque est 255.255.255.192 et le pas est de 64. L’adresse réseau est .64, le broadcast .127 et les hôtes utilisables vont de .65 à .126. Un /24 découpé en /26 donne quatre sous-réseaux.',
          en: 'For 192.168.10.64/26, the mask is 255.255.255.192 and the block size is 64. The network address is .64, the broadcast is .127 and usable hosts range from .65 to .126. A /24 split into /26 gives four subnets.',
        },
        takeaway: {
          fr: 'L’adresse réseau identifie le sous-réseau; le broadcast vise tous ses hôtes.',
          en: 'The network address identifies the subnet; the broadcast reaches all its hosts.',
        },
      },
      {
        title: { fr: 'Passerelle et routage', en: 'Default gateway and routing' },
        body: {
          fr: 'Un hôte envoie directement les paquets aux voisins de son sous-réseau. Pour joindre une autre plage IP, il transmet le paquet à sa passerelle par défaut, qui est l’adresse d’une interface de routeur située dans le même sous-réseau.',
          en: 'A host sends packets directly to neighbors in its subnet. To reach another IP range, it sends the packet to its default gateway, the address of a router interface in the same subnet.',
        },
        takeaway: {
          fr: 'L’adresse de passerelle doit appartenir au même sous-réseau que l’hôte.',
          en: 'The gateway address must belong to the same subnet as the host.',
        },
      },
    ],
  },
  {
    id: 'vlans-routing',
    title: { fr: 'VLAN et routage inter-VLAN', en: 'VLANs and inter-VLAN routing' },
    summary: {
      fr: 'Segmentez un switch en réseaux logiques et faites communiquer les VLANs avec un routeur.',
      en: 'Split a switch into logical networks and route between VLANs.',
    },
    durationMinutes: 35,
    objectives: [
      { fr: 'Créer des VLANs et placer les ports utilisateurs en mode access.', en: 'Create VLANs and assign user ports to access mode.' },
      { fr: 'Distinguer un port access d’un trunk 802.1Q.', en: 'Distinguish an access port from an 802.1Q trunk.' },
      { fr: 'Décrire le routage « router-on-a-stick ».', en: 'Describe router-on-a-stick routing.' },
    ],
    lessons: [
      {
        title: { fr: 'Segmenter avec des VLANs', en: 'Segment with VLANs' },
        body: {
          fr: 'Un VLAN forme un domaine de broadcast logique. Des appareils sur le même switch mais dans des VLANs différents ne communiquent pas directement en couche 2. La segmentation permet de séparer, par exemple, les postes administratifs et les postes élèves.',
          en: 'A VLAN forms a logical broadcast domain. Devices on the same switch but in different VLANs do not communicate directly at Layer 2. Segmentation can separate, for example, administration and student devices.',
        },
        takeaway: {
          fr: 'Un VLAN correspond à un domaine de broadcast distinct.',
          en: 'Each VLAN is a separate broadcast domain.',
        },
      },
      {
        title: { fr: 'Ports access et trunks', en: 'Access ports and trunks' },
        body: {
          fr: 'Un port access transporte le trafic d’un seul VLAN, généralement vers un terminal. Un trunk transporte plusieurs VLANs entre équipements; 802.1Q ajoute une étiquette au trafic pour conserver l’identifiant du VLAN.',
          en: 'An access port carries one VLAN, usually toward an end device. A trunk carries multiple VLANs between devices; 802.1Q tags traffic to preserve the VLAN identifier.',
        },
        takeaway: {
          fr: 'Terminal → access; liaison entre équipements réseau → trunk.',
          en: 'End device → access; link between network devices → trunk.',
        },
      },
      {
        title: { fr: 'Router-on-a-stick', en: 'Router-on-a-stick' },
        body: {
          fr: 'Un routeur peut partager une interface physique en sous-interfaces. Chaque sous-interface reçoit une encapsulation dot1Q et une adresse IP servant de passerelle pour son VLAN. Le lien du switch vers le routeur doit être un trunk qui autorise ces VLANs.',
          en: 'A router can split one physical interface into subinterfaces. Each subinterface gets a dot1Q encapsulation and an IP address that acts as the gateway for its VLAN. The switch link to the router must be a trunk allowing those VLANs.',
        },
        takeaway: {
          fr: 'Le trunk transporte les VLANs; les sous-interfaces du routeur assurent le routage entre eux.',
          en: 'The trunk carries the VLANs; router subinterfaces route between them.',
        },
      },
    ],
  },
];

function projectWithNote(
  name: string,
  statement: string,
  deviceSeeds: DeviceSeed[],
  links: LinkSeed[],
): ProjectDoc {
  const project = createProject(name);
  const devices = deviceSeeds.map((device) => addDevice(project, device.model, device.x, device.y));
  for (const [a, aPort, b, bPort] of links) {
    addLink(project, 'straight', { device: devices[a]!.id, port: aPort }, { device: devices[b]!.id, port: bPort });
  }
  project.notes.push({ id: 'n1', x: 25, y: 25, text: statement, color: '#fde68a' });
  project.counters.note = 1;
  return project;
}

export const starterExercises: StarterExercise[] = [
  {
    id: 'first-lan',
    title: { fr: 'Premier LAN : connecter deux PC', en: 'First LAN: connect two PCs' },
    summary: {
      fr: 'Configurez deux hôtes dans le même sous-réseau et vérifiez la commutation.',
      en: 'Configure two hosts on the same subnet and inspect switching.',
    },
    durationMinutes: 15,
    statement: {
      fr: 'OBJECTIF\nFaire communiquer PC0 et PC1 dans 192.168.10.0/24.\n\nÀ FAIRE\n1. Configurez PC0 en 192.168.10.10/24 et PC1 en 192.168.10.20/24.\n2. Depuis PC0, lancez ping 192.168.10.20.\n3. Sur Switch0, consultez show mac address-table.\n\nRÉUSSITE\nLe ping répond et le switch apprend les deux adresses MAC.',
      en: 'GOAL\nMake PC0 and PC1 communicate in 192.168.10.0/24.\n\nTASKS\n1. Configure PC0 as 192.168.10.10/24 and PC1 as 192.168.10.20/24.\n2. From PC0, run ping 192.168.10.20.\n3. On Switch0, inspect show mac address-table.\n\nSUCCESS\nThe ping replies and the switch learns both MAC addresses.',
    },
    makeProject: (title, statement) => projectWithNote(title, statement, [
      { model: 'PC', x: 120, y: 190 },
      { model: 'PC', x: 120, y: 390 },
      { model: '2960-24TT', x: 470, y: 290 },
    ], [
      [0, 'FastEthernet0', 2, 'FastEthernet0/1'],
      [1, 'FastEthernet0', 2, 'FastEthernet0/2'],
    ]),
  },
  {
    id: 'ipv4-routing',
    title: { fr: 'IPv4 : relier deux sous-réseaux /26', en: 'IPv4: connect two /26 subnets' },
    summary: {
      fr: 'Configurez les interfaces d’un routeur, deux réseaux et leurs passerelles.',
      en: 'Configure a router, two networks and their default gateways.',
    },
    durationMinutes: 25,
    statement: {
      fr: 'OBJECTIF\nRelier 192.168.20.0/26 et 192.168.20.64/26.\n\nPLAN D’ADRESSAGE\nPC0 : 192.168.20.10/26, passerelle 192.168.20.1.\nPC1 : 192.168.20.70/26, passerelle 192.168.20.65.\nRouter0 G0/0 : 192.168.20.1/26; G0/1 : 192.168.20.65/26.\n\nÀ FAIRE\nConfigurez les interfaces du routeur (no shutdown), les deux PC, puis testez le ping de PC0 vers 192.168.20.70.',
      en: 'GOAL\nConnect 192.168.20.0/26 and 192.168.20.64/26.\n\nADDRESS PLAN\nPC0: 192.168.20.10/26, gateway 192.168.20.1.\nPC1: 192.168.20.70/26, gateway 192.168.20.65.\nRouter0 G0/0: 192.168.20.1/26; G0/1: 192.168.20.65/26.\n\nTASKS\nConfigure the router interfaces (no shutdown), both PCs, then ping 192.168.20.70 from PC0.',
    },
    makeProject: (title, statement) => projectWithNote(title, statement, [
      { model: 'PC', x: 80, y: 210 },
      { model: '2960-24TT', x: 330, y: 210 },
      { model: '1941', x: 610, y: 300 },
      { model: '2960-24TT', x: 900, y: 390 },
      { model: 'PC', x: 1150, y: 390 },
    ], [
      [0, 'FastEthernet0', 1, 'FastEthernet0/1'],
      [1, 'GigabitEthernet0/1', 2, 'GigabitEthernet0/0'],
      [2, 'GigabitEthernet0/1', 3, 'GigabitEthernet0/1'],
      [3, 'FastEthernet0/1', 4, 'FastEthernet0'],
    ]),
  },
  {
    id: 'vlan-router-stick',
    title: { fr: 'VLAN 10/20 et routage inter-VLAN', en: 'VLAN 10/20 and inter-VLAN routing' },
    summary: {
      fr: 'Séparez deux groupes sur un switch et faites-les communiquer via un trunk.',
      en: 'Separate two groups on a switch and route between them over a trunk.',
    },
    durationMinutes: 30,
    statement: {
      fr: 'OBJECTIF\nCréer VLAN 10 (ADMIN) et VLAN 20 (SIO), puis autoriser leur communication via Router0.\n\nADRESSAGE\nPC0 : 192.168.10.10/24, passerelle 192.168.10.1.\nPC1 : 192.168.20.10/24, passerelle 192.168.20.1.\n\nÀ FAIRE\n1. Créez les VLANs et affectez Fa0/1 à VLAN 10, Fa0/2 à VLAN 20.\n2. Configurez Gi0/1 du switch en trunk.\n3. Créez les sous-interfaces Router0 G0/0.10 et G0/0.20 avec encapsulation dot1Q et les passerelles ci-dessus.\n4. Testez le ping entre les deux PC.',
      en: 'GOAL\nCreate VLAN 10 (ADMIN) and VLAN 20 (SIO), then allow them to communicate through Router0.\n\nADDRESSING\nPC0: 192.168.10.10/24, gateway 192.168.10.1.\nPC1: 192.168.20.10/24, gateway 192.168.20.1.\n\nTASKS\n1. Create the VLANs and assign Fa0/1 to VLAN 10, Fa0/2 to VLAN 20.\n2. Configure switch Gi0/1 as a trunk.\n3. Create Router0 G0/0.10 and G0/0.20 subinterfaces with dot1Q encapsulation and the gateways above.\n4. Ping between the two PCs.',
    },
    makeProject: (title, statement) => projectWithNote(title, statement, [
      { model: 'PC', x: 120, y: 190 },
      { model: 'PC', x: 120, y: 410 },
      { model: '2960-24TT', x: 480, y: 300 },
      { model: '1941', x: 850, y: 300 },
    ], [
      [0, 'FastEthernet0', 2, 'FastEthernet0/1'],
      [1, 'FastEthernet0', 2, 'FastEthernet0/2'],
      [2, 'GigabitEthernet0/1', 3, 'GigabitEthernet0/0'],
    ]),
  },
];
