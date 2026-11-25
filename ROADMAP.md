# Feuille de route

Légende : ✅ fait et testé · 🟡 partiel · ⬜ à faire. Chaque phase doit livrer une version fonctionnelle et testée.

## Phase 1 — Fondations 🟡
- ✅ Monorepo (moteur, web, API), TypeScript strict, CI.
- ✅ Authentification (Argon2id, sessions, CSRF, anti-force-brute), établissements, invitations, rôles.
- ✅ Modèle relationnel initial + migration Alembic ; isolation inter-établissements testée.
- ✅ Docker / Compose / Nginx construits et déployés sur le serveur privé ; validation HTTPS/TLS
  encore nécessaire avant toute exposition Internet.
- ⬜ Vérification d'e-mail et réinitialisation du mot de passe : table `email_tokens` (jeton haché,
  expiration 1 h, usage unique), envoi SMTP configurable, réponses identiques que le compte existe ou non.
- ⬜ 2FA TOTP facultative (RFC 6238, codes de secours hachés).
- ⬜ SSO OpenID Connect (Authlib), puis LTI 1.3 (Moodle / ENT).
- ⬜ Interfaces d'administration d'établissement et super-admin (utilisateurs, années, quotas, journaux).
- ⬜ Limitation de débit et sessions partagées via Redis (plusieurs instances d'API).

## Phase 2 — Équipements et ergonomie du simulateur ✅
Éditeur, équipements, câblage, Ethernet, ARP, IPv4, ICMP, routage statique, CLI IOS.
- ✅ Point d'accès, smartphone, tablette et interface Wi-Fi sur portable ; association SSID/WPA2.
- ✅ Téléphone IP et IoT (hôtes), modem et cloud (ponts Ethernet), pare-feu (routage IOS avec ACL)
  et routeur Wi‑Fi (interface radio IOS configurable, pontée vers le LAN Ethernet actif).
- ✅ Édition de ligne CLI : déplacement du curseur, Home/End, Ctrl+A/E/W, suppression avant/après
  le curseur et navigation dans l'historique.
- ✅ Copier/coller inter-projets : fragment validé, nouveaux identifiants/MAC, liens internes,
  annotations et configuration IOS préservés.

## Phase 3 — Simulateur avancé ✅
Le périmètre livré est couvert par des tests de comportement ; « terminé » signifie que le sous-ensemble
annoncé fonctionne, pas une émulation complète ni une compatibilité 1:1 avec Packet Tracer. Les écarts
restants sont explicités dans `COMPATIBILITY.md`.
- ✅ VLAN, trunk 802.1Q, DTP, STP, routage inter-VLAN, ACL numérotées et nommées (standard/étendues), mode simulation, inspection.
- 🟡 **RIPv1/v2** : tests de routage, version et interface passive ; état convergé calculé (Bellman-Ford), split horizon, `passive-interface`,
  `auto-summary`, compatibilité de versions et `show ip protocols`. Pas de paquets UDP 520 ni de
  temporisation de convergence.
- 🟡 **OSPFv2 mono-zone** : tests d’adjacence, de routes et d’aire ; adjacences via le domaine de diffusion L2, aire/masque, router-id,
  DR/BDR et SPF. Pas de Hello/LSA simulés ni de délai de convergence.
- 🟡 **TCP et services** : tests TCP/UDP, DHCP, DNS, HTTP, TFTP et VTY ; TCP minimal avec retransmissions ; DHCP (pools IOS/serveur, relais et
  client), DNS, TFTP, HTTP(S), Telnet/SSH VTY. Pas de FTP/SMTP/POP3/NTP ni de pile TCP complète.
- 🟡 **NAT/PAT** : tests de NAT statique et PAT ; statique, pools et surcharge PAT.
- ✅ **IPv6** : tests d’adressage statique, SLAAC, DHCPv6 stateful, NDP, connectivité routée et OSPFv3 ; link-local EUI-64, ICMPv6 et routes statiques ; OSPFv3 (un processus, aires par interface).
- ✅ PDU complexes ICMP/TCP/UDP et export PCAP Ethernet (trames émises).

Les protocoles de routage affichent l'état convergé calculé : les paquets de contrôle et les
temporisations de convergence ne sont pas simulés. Les sous-ensembles et écarts sont détaillés dans
`COMPATIBILITY.md`. Validation locale après la phase 2 : `npm test` (84 tests moteur, 9 tests web),
`npx playwright test` (11 tests), `npm run typecheck` et `npm run build`.

## Phase 4 — Plateforme pédagogique 🟡
- ✅ Classes, adhésions, codes d'inscription, annonces, devoirs/examens, dates d'ouverture/échéance,
  durée, tentatives, temps supplémentaire, vérifications intermédiaires et visibilité des résultats.
- ✅ Espaces élève/professeur et tableaux de bord ; révision de notes avec historique.
- ⬜ Import CSV et groupes d'élèves ; cours, modules, leçons, ressources, quiz, glossaire et
  calculateur de sous-réseaux.

## Phase 5 — Correction automatique 🟡
- ✅ Correcteur déterministe (17 types de critères, points partiels, dépendances, bonus, pénalités,
  critères obligatoires, tests cachés), exécution serveur isolée, instantanés immuables.
- ✅ Éditeur visuel de critères, essai local et garde de publication vérifiant la note maximale de
  la solution de référence.
- ⬜ Activity Wizard et variantes à graine déterministe avec vérification de faisabilité.
- 🟡 Rapport pédagogique et visibilité configurable ; modification manuelle de note avec historique
  (`grade_history`) livrée.

## Phase 6 — Fonctionnalités avancées 🟡
- ✅ Collaboration WebSocket : opérations ordonnées rejouées par le moteur local, partage, rôles,
  présence, chat, curseurs, ticks et sauvegarde. Les salons sont en mémoire du processus ; le
  fonctionnement de l'horloge en interface reste à confirmer.
- ✅ Mode devoir/examen : fenêtre et durée, tentatives, temps supplémentaire, soumission, et
  signalement d'onglet. Les événements ne sont conservés que si l'établissement active le suivi ;
  ils sont informatifs, pas une preuve de fraude.
- ✅ TPacket Tutor : diagnostic local déterministe et intégration IA facultative, désactivée par défaut.
- ⬜ Network Incident, compétences, gamification et bibliothèque communautaire.

## Phase 7 — Finalisation ⬜
Contenu pédagogique complet (11 modules, 35 cours, 60 exercices, 150 questions, 20 scénarios,
5 examens, 10 projets, glossaire de 100 termes) : **aucun contenu de cours, exercice ou quiz n'est
encore livré**. Restent aussi la comparaison avec Packet Tracer, audit de sécurité, benchmarks
(100 / 500 équipements), documentation, validation PostgreSQL de la migration 0002 et déploiement.
