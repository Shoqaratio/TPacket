# Compatibilité avec Cisco Packet Tracer

**Aucune compatibilité 1:1 n'est revendiquée.** Les statuts ci-dessous :

- **Non implémentée**
- **Partielle** — fonctionne, avec les écarts indiqués
- **Partielle (testée TPacket)** — le sous-ensemble décrit est couvert par un test de comportement, sans
  revendiquer l'implémentation complète du protocole
- **Implémentée** — fonctionne, sans test de comportement automatisé dédié
- **Testée (TPacket)** — couverte par des tests de comportement automatisés du projet

> Aucun scénario n'a encore été comparé à une exécution de référence dans Cisco Packet Tracer :
> le statut « Validée contre Packet Tracer » n'est attribué à aucune fonctionnalité pour l'instant.
> Le format `.pkt/.pka` (propriétaire, chiffré) n'est **pas** pris en charge.

## Équipements

| Élément | Statut | Notes |
| --- | --- | --- |
| Cisco 1841, 1941, 2621XM, 2811, 2911, routeur générique | Testée (TPacket) pour 1941/2911 ; Implémentée pour les autres | Ports fixes réels ; modules HWIC-2T/WIC-2T (série), NM génériques ; changement de module équipement éteint |
| Catalyst 2960-24TT, switch générique | Testée (TPacket) | |
| Catalyst 3560-24PS (L3) | Testée (TPacket) | SVI + `ip routing`, `no switchport` |
| Hub | Implémentée | Répète sur tous les ports |
| PC, portable, serveur, imprimante | Testée (TPacket) pour PC | Serveur : DHCP, DNS, TFTP, HTTP(S) ; fonctions limitées, voir couches 4–7 |
| Point d'accès, smartphone, tablette, portable Wi-Fi | Partielle (testée TPacket) | Association SSID/WPA2 et portée simulées ; pas de radio/interférences ni d'authentification réelle |
| Routeur Wi-Fi domestique | Partielle (testée TPacket) | Radio intégrée et `Wireless0` configurable ; le LAN Wi-Fi est ponté vers l'interface Ethernet active sans lien physique. Pas de configuration de bridge/VLAN granulaire ni d'assistant grand public |
| Téléphone IP, IoT | Partielle (testée TPacket) | Hôtes Ethernet configurables ; signalisation téléphonique et protocoles IoT dédiés absents |
| Modem, cloud | Partielle (testée TPacket) | Ponts Ethernet transparents ; aucun accès WAN ou réseau externe réel |
| Pare-feu | Partielle (testée TPacket) | Routeur IOS avec ACL standard/étendues ; pas d'OS ou de fonctions de pare-feu dédiés |

## Couche physique

| Élément | Statut | Notes |
| --- | --- | --- |
| Droit / croisé (règle MDI / MDI‑X) | Testée (TPacket) | Auto-MDIX si les deux ports sont Gigabit |
| Console (RS‑232 → Console) | Implémentée | Bureau du PC > Terminal ouvre la CLI de l'équipement relié |
| Fibre | Implémentée | Ports fibre via modules NM-1FFE |
| Série DCE/DTE, `clock rate` | Testée (TPacket) | Sans horloge côté DCE : up/down |
| Wi-Fi | Partielle (testée TPacket) | `AccessPoint-PT` et routeur Wi-Fi intégré, `Wireless0`, association SSID/WPA2 et portée (400 unités) ; pas de radio/interférences ni d'authentification réelle |
| Couleurs de liens vert / orange / rouge | Testée (TPacket) | Orange pendant écoute/apprentissage STP et port bloqué |
| `speed` / `duplex` | Partielle | Vitesses forcées incompatibles → lien down ; pas de simulation d'erreurs de duplex |

## Couche 2

| Élément | Statut | Notes |
| --- | --- | --- |
| Trames Ethernet, MAC, table CAM, vieillissement 300 s | Testée (TPacket) | |
| ARP (cache, file d'attente hôte, abandon du 1er paquet sur IOS `.!!!!`) | Testée (TPacket) | |
| Proxy ARP | Implémentée | Activé par défaut, `no ip proxy-arp` |
| ARP gratuit, détection de conflit d'adresses | Testée (TPacket) | |
| VLAN, ports access, création auto du VLAN d'accès | Testée (TPacket) | |
| Trunk 802.1Q, VLAN natif, `allowed vlan` (add/remove/except/none) | Testée (TPacket) | |
| DTP (`dynamic auto/desirable`) | Implémentée | Négociation déterminée par les modes ; pas de trames DTP simulées |
| STP (PVST, 802.1D) | Testée (TPacket) | Arbre **calculé** (pas d'échange de BPDU simulé) ; timers 15 s + 15 s ; `portfast`, `priority`, `root primary` |
| CDP | Partielle | `show cdp neighbors` dérivé de la topologie, sans paquets CDP |
| VTP, EtherChannel, Port-security, RSTP | Non implémentée | |

## Couche 3

| Élément | Statut | Notes |
| --- | --- | --- |
| IPv4, ICMP echo / unreachable / time-exceeded | Testée (TPacket) | |
| Routes connectées, locales (IOS 15), statiques, par défaut, flottantes | Testée (TPacket) | Résolution récursive du next-hop |
| Préfixe le plus long, distance administrative | Testée (TPacket) | |
| TTL et traceroute (UDP IOS, ICMP Windows) | Testée (TPacket) | |
| Routage inter-VLAN (router-on-a-stick, SVI) | Testée (TPacket) | |
| ACL standard / étendues numérotées et nommées (ip, icmp, tcp, udp, `eq`) | Testée (TPacket) | |
| RIPv1/v2 | Partielle (testée TPacket) | Bellman-Ford, split horizon, `passive-interface`, `auto-summary` et compatibilité de versions ; mises à jour UDP 520 IPv1 broadcast/IPv2 multicast émises/livrées sur L2 et répétées toutes les 30 s. Pas de hold-down ni d'installation différée |
| OSPFv2 mono-zone | Partielle (testée TPacket) | Hello/LSA IP 89 multicast émis/livrés sur L2 ; Hello répété toutes les 10 s ; voisinage, aire/masque, router-id, DR/BDR et SPF. Pas de dead timer ni de convergence différée |
| NAT / PAT | Testée (TPacket) | NAT statique, pools et surcharge PAT ; trafic de bout en bout entre réseaux simulés. Le moteur n'ouvre volontairement aucune socket vers Internet |
| IPv6, ICMPv6, NDP | Testée (TPacket) | Adresses statiques, link-local EUI-64, SLAAC et DHCPv6 stateful (préfixe) ; pas de bail/renouvellement DHCPv6 complet, DNS IPv6 côté client ni SLAAC privacy extensions |
| OSPFv3 | Partielle (testée TPacket) | Hello/LSA IPv6 multicast IP 89 livrés sur L2 ; Hello répété toutes les 10 s. Un processus par routeur, aire configurée par interface, adjacences et SPF IPv6 ; routes calculées à l'état convergé, sans dead timer ni installation progressive |

## Couches 4–7

| Élément | Statut | Notes |
| --- | --- | --- |
| TCP / UDP | Partielle (testée TPacket) | TCP : handshake et état serveur, séquences de contrôle, requête/réponse, FIN/FIN-ACK et retransmissions SYN/données/FIN ; doublons de requête idempotents. Charge utile abstraite (pas de segmentation, fenêtre, congestion ou numéros d'octets complets). UDP applicatif avec retransmissions |
| DHCP | Partielle (testée TPacket) | Pools IOS, service serveur, relais `ip helper-address`, renouvellement client et APIPA ; pas de temporisation/DORA détaillée en paquets visibles |
| DNS | Partielle (testée TPacket) | Enregistrements côté serveur, `nslookup` et résolution pour ping/navigateur ; pas de cache/recursion réaliste |
| HTTP(S), TFTP | Partielle (testée TPacket) | Navigation simulée et transfert TFTP ; le navigateur intégré utilise un iframe sandboxé pour afficher le contenu |
| Telnet / SSH | Partielle (testée TPacket) | Accès VTY simulé avec règles IOS ; pas de vrai terminal réseau ni de chiffrement SSH |
| FTP | Partielle (testée TPacket) | Liste, lecture et écriture de fichiers via opérations TCP simulées ; canal de contrôle/données FTP complet, modes actif/passif et authentification non implémentés |
| SMTP / POP3 | Partielle (testée TPacket) | Envoi, boîte aux lettres simulée et lecture par index via échanges TCP abstraits ; pas de dialogue RFC, authentification ni TLS |
| NTP | Partielle (testée TPacket) | Réponse UDP avec l'horloge virtuelle en millisecondes ; pas de datagramme NTP RFC ni d'heure civile |

## CLI IOS

| Élément | Statut | Notes |
| --- | --- | --- |
| Modes user / privileged / config / interface / range / subif / line / vlan | Testée (TPacket) | Retour automatique au mode parent comme IOS |
| Abréviations, `?` contextuel, TAB, historique, `--More--`, erreurs `^` / ambigu / incomplet | Testée (TPacket) | |
| Édition de ligne dans le terminal web | Partielle (testée TPacket) | Curseur, Home/End, Ctrl+A/E/W, suppression avant/après et historique ; pas d'émulation exhaustive des raccourcis de terminaux IOS |
| `enable secret` / `enable password`, `service password-encryption` (type 7) | Testée (TPacket) | Le hachage « type 5 » n'est pas un vrai MD5-crypt (non interchangeable avec IOS) |
| `line con/vty`, `login`, `login local`, `username`, `transport input` | Partielle | Sessions VTY simulées ; pas de transport réseau ou de cryptographie réels |
| running / startup-config, `copy`, `write`, `erase`, `reload`, alimentation | Testée (TPacket) | |
| `crypto key generate rsa`, `ip ssh version`, `ip domain-name`, `banner motd` | Testée (TPacket) | |
| `show` : running/startup-config, version, clock, history, ip interface brief, interfaces, ip route, arp, mac address-table, vlan (brief), interfaces trunk, cdp neighbors, spanning-tree, access-lists | Testée (TPacket) | Sans compteurs de trafic (non simulés plutôt que fictifs) |
| `router rip/ospf`, `ipv6 router ospf`, `ip dhcp …`, `ipv6 dhcp …`, `ip nat …`, `ipv6 …`, `copy tftp`, `show ip protocols`, `show ip ospf neighbor`, `show ipv6 ospf neighbor`, `show ip/ipv6 dhcp binding`, `show ipv6 …` | Partielle | Sous-ensemble de commandes nécessaire aux fonctions simulées ; consulter les messages CLI pour les syntaxes acceptées |

## Mode simulation

| Élément | Statut | Notes |
| --- | --- | --- |
| Lecture, pause, pas à pas, réinitialisation, vitesse | Testée (TPacket) | |
| PDU complexe ICMP / TCP / UDP, statut réussi/échec | Testée (TPacket) | Port destination configurable pour TCP/UDP ; transport simulé limité |
| Liste d'événements, filtres ARP/ICMP/ICMPv6/UDP/TCP/NDP, animation | Testée (TPacket) | |
| Inspection OSI (L1–L4) et cause de rejet | Testée (TPacket) | |
| Export PCAP | Testée (TPacket) | PCAP 2.4, Ethernet avec tags 802.1Q, événements d'émission seulement ; trames série HDLC ignorées |
| Commandes CLI pendant le mode Simulation | Partielle | Exécutées immédiatement (non pas à pas), événements visibles dans la liste |

## Édition et presse-papiers

| Élément | Statut | Notes |
| --- | --- | --- |
| Copier/coller une sélection entre projets | Partielle (testée TPacket) | Fragment JSON validé avant import, avec nouveaux IDs et adresses MAC ; liens internes, annotations et configuration IOS conservés. Limite de 4 Mo ; dépend des permissions de presse-papiers du navigateur |

## Correction et tutorat

| Élément | Statut | Notes |
| --- | --- | --- |
| Critères `dhcp_client`, `service_access`, `dns_resolution`, `ipv6_connectivity`, `route_exists` via RIP/OSPF | Implémentée | Évaluation déterministe côté moteur ; le serveur n'expose pas les critères cachés à l'élève |
| TPacket Tutor déterministe | Implémentée | Diagnostic aller/retour, cinq niveaux d'indices FR/EN et suggestion de commande |
| Tutor IA | Partielle | Désactivé sans configuration `NETLAB_AI_URL`; endpoint compatible OpenAI. Peut être interdit par devoir ; ne garantit pas la disponibilité du fournisseur configuré |
