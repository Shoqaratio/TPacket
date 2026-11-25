# Changelog

## 0.1.0 — 2026-11-25
Première version : fondations, simulateur fondamental, début du simulateur avancé et du correcteur.

### Moteur (`@netlab/engine`, ENGINE_VERSION 0.1.0)
- Catalogue : routeurs 1841/1941/2621XM/2811/2911/générique, switchs 2960/3560/générique, hub, PC,
  portable, serveur, imprimante ; modules série et NM.
- Couche 1 : câbles droit/croisé/console/fibre/série, MDI/MDI-X, auto-MDIX Gigabit, horloge DCE, vitesses.
- Couche 2 : Ethernet, CAM, ARP, proxy ARP, ARP gratuit, conflits d'adresses, VLAN, 802.1Q, DTP, PVST.
- Couche 3 : IPv4, ICMP, routes connectées/locales/statiques/flottantes, LPM, TTL, traceroute,
  inter-VLAN, ACL standard et étendues numérotées.
- CLI IOS : 8 modes, abréviations, aide, complétion, erreurs, mots de passe, running/startup,
  reload, alimentation, messages système, ~140 formes de commandes.
- Invite de commandes PC : ipconfig, ping, tracert, arp.
- Correcteur déterministe à 17 types de critères ; bundle Node pour le serveur.

### Web
- Espace de travail complet (voir PROGRESS.md), Web Worker, IndexedDB, PWA, FR/EN, thèmes.

### API
- Auth (Argon2id, sessions, CSRF, limitation), établissements, invitations, projets cloud,
  exercices versionnés, soumissions immuables, correction serveur ; migration Alembic initiale.

## Travaux ultérieurs consignés — 25 novembre 2026 (toujours version 0.1.0)

Ces changements sont présents dans l'arbre de travail, sans numéro de version distinct ni commit.

### Moteur
- Ajout du routage RIP v1/v2 et OSPF calculés à l'état convergé, de DHCP, DNS, TFTP, HTTP(S),
  NAT/PAT et d'un sous-ensemble TCP avec retransmissions.
- Ajout d'IPv6 statique (link-local, NDP, ICMPv6 et routes statiques), d'hôtes Wi-Fi et d'associations
  point d'accès/client.
- Ajout de commandes IOS pour ces fonctions, d'accès VTY simulé, de critères de correction associés
  et de TPacket Tutor déterministe bilingue.
- Limites importantes : les protocoles de routage ne simulent ni paquets ni convergence ; IPv6 ne
  comprend pas SLAAC/DHCPv6/OSPFv3 ; TCP et les services restent partiels.

### API et web
- Ajout des classes, adhésions, annonces, devoirs/examens, vérifications, soumissions liées aux
  devoirs et historique de révision des notes (migration 0002).
- Ajout de la collaboration WebSocket et du partage de projet, d'un endpoint IA facultatif pour le
  tutorat, ainsi que des espaces professeur/élève, barre de devoir, éditeur d'exercices, panneau
  Tutor et panneau de collaboration.
- Ajout de services DHCP/DNS/HTTP(S) côté serveur simulé, configuration Wi-Fi et IPv6 des hôtes,
  configuration des points d'accès et navigateur sandboxé.
- Playwright démarre l'API sur SQLite temporaire en plus de Vite. Après correction de l'inscription
  concurrente du compte administrateur partagé, la suite complète passe (6/6).

### Finalisation de la phase 3 — 25 novembre 2026
- ACL standard et étendues nommées, SLAAC, DHCPv6 stateful et OSPFv3 calculé (un processus par routeur).
- PDU complexes configurables (ICMP/TCP/UDP) et export PCAP 2.4 Ethernet des trames émises, tags 802.1Q inclus.
- CLI hôte `ipv6config /renew`, configuration IPv6 automatique dans l'interface, vues DHCPv6/OSPFv3
  et persistance IOS testée.
- Couverture moteur mise à jour à 80 tests ; typechecks, builds, tests web et Playwright revérifiés.
- Limites : routage calculé à l'état convergé sans paquets de contrôle/délai, options DNS DHCPv6 non
  consommées par le client, capture PCAP sans trames série HDLC.

### Phase 2 — Équipements et ergonomie du simulateur
- Ajout du téléphone IP et IoT comme hôtes, du modem et du cloud comme ponts Ethernet, du pare-feu
  IOS avec ACL et du routeur Wi-Fi domestique avec interface radio configurable.
- Le parseur IOS accepte désormais les interfaces `Wireless` (`Wireless0`) ; la radio du routeur
  Wi-Fi peut transmettre et recevoir comme point d'accès intégré, avec pont vers le LAN Ethernet
  actif quand son port n'a pas de lien physique.
- Le terminal web prend en charge l'édition de ligne avec curseur, Home/End, Ctrl+A/E/W,
  suppression avant/après et historique.
- Le copier/coller inter-projets valide les fragments importés et régénère leurs IDs/MAC, tout en
  conservant liens internes, annotations et configuration IOS.
- Validation : 84 tests moteur, 9 tests web, 11 tests Playwright, typechecks engine/web et builds.

### Phase 3 — compléments de routage NAT et TCP
- Le client TCP complète maintenant le handshake par ACK, séquence les données, puis ferme par
  FIN/FIN-ACK/ACK ; le test vérifie les numéros de séquence/ACK.
- Ajout d'un test NAT dynamique par pool sur un réseau extérieur simulé, en plus des scénarios PAT
  et NAT statique ; NAT/PAT est désormais testé de bout en bout dans le simulateur.
- Validation locale à cette étape : 85 tests moteur réussis. Les sections suivantes décrivent les
  compléments ultérieurs sur les échanges RIP/OSPF et les services TCP.

### Phase 3 — services applicatifs et cycle TCP
- Le serveur TCP maintient désormais l'état minimal du handshake, vérifie les séquences, rejoue les
  réponses aux segments de données/FIN retransmis et refuse les données arrivant sans connexion.
- Ajout de FTP (LIST/RETR/STOR), SMTP/POP3 (envoi, boîte aux lettres et lecture) et NTP (horloge
  virtuelle), avec commandes PC, activation dans l'onglet Services et limites de stockage.
- Validation locale : 88 tests moteur, 9 web, 19 API, 11 Playwright, typechecks et builds réussis.
- Ajout de mises à jour RIP UDP 520 périodiques (30 s), de Hello OSPFv2 (10 s) et de Hello/LSA
  OSPFv3 multicast IP 89 visibles dans les événements et livrés sur les domaines L2. Les routes
  restent projetées à l'état convergé ; dead timer, hold-down et installation progressive ne sont
  pas modélisés.
