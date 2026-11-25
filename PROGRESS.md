# Avancement — 25 novembre 2026

L'application reste en version `0.1.0`, mais a évolué depuis sa première livraison. Les fondations
(phase 1), le simulateur fondamental (phase 2) et une partie du simulateur avancé (phase 3)
fonctionnent. Les phases 4 à 6 sont maintenant **partiellement livrées** : classes et devoirs,
éditeur d'exercices, collaboration, examens et tutorat sont présents. Le contenu pédagogique livré
reste à créer.

Les résultats ci-dessous comprennent la suite Playwright complète exécutée le 25 novembre 2026 après
correction du conflit d'inscription du compte administrateur partagé.

## Ce qui fonctionne (vérifié)

| Suite | Résultat | Commande |
| --- | --- | --- |
| Moteur (Vitest) | 76 tests réussis | `npm test -w @netlab/engine` |
| API (Pytest) | 18 tests réussis | `cd apps/api && .venv/bin/python -m pytest -q --timeout 60` |
| Bout en bout (Playwright, Chromium, 1366×768, fr-FR) | 6/6 tests réussis dans la suite complète | `cd apps/web && npx playwright test` |
| Typage web | OK | `cd apps/web && npx tsc --noEmit -p .` |
| Build web | OK | `cd apps/web && npx vite build` |
| Migration Alembic montée/descendue/remontée (SQLite) | OK | vérification consignée dans le handoff |
| Migration PostgreSQL 0002 + santé API sur serveur Docker | OK | migration `0002 (head)`, `/api/health` répond `200` |

La configuration Playwright démarre l'API avec une base SQLite temporaire et Vite. La base et le
serveur sont donc ceux de l'environnement de test, pas une instance de production.

### Simulateur (navigateur)
- Espace de travail : barre de menus, barre d'outils, onglets de projets, bibliothèque, canevas
  (zoom, déplacement, minimap, grille magnétique, sélection multiple, menu contextuel), panneau de
  propriétés, terminal, liste d'événements, barre d'état, thème clair/sombre, FR/EN.
- Glisser-déposer des équipements, câblage manuel (choix du port) ou automatique, notes, zones
  colorées redimensionnables, dupliquer, copier/coller (dans un même projet), alignement, annuler /
  rétablir (50 niveaux), raccourcis clavier, export PNG / SVG / PDF, plein écran.
- Fenêtre d'équipement : Physique (alimentation, modules), Config (PC : IP ; IOS : import/export de
  configuration texte), CLI, Bureau (Configuration IP, Invite de commandes, Terminal console).
- Hôtes : configuration IPv4 statique ou DHCP, IPv6 et Wi-Fi. Points d'accès configurables ; les
  serveurs proposent DHCP, DNS, TFTP et HTTP(S). Le navigateur intégré est sandboxé.
- Moteur dans un Web Worker ; sauvegarde automatique IndexedDB ; synchronisation cloud avec
  détection de conflit ; import/export `.netlab`.
- Modes Temps réel (avance rapide +30 s) et Simulation (PDU ICMP, pas à pas, lecture, vitesse,
  animation, filtres, inspection OSI et cause de rejet).
- RIP v1/v2, OSPF, NAT/PAT, DHCP, DNS, TCP minimal, services applicatifs, IPv6 statique et
  connectivité sans fil ; voir les limites précises dans `COMPATIBILITY.md`.
- Détails par protocole et par commande : voir `COMPATIBILITY.md`.

### Serveur
- Inscription, connexion, déconnexion, sessions (jeton haché, cookie HttpOnly), CSRF double-submit,
  Argon2id, limitation des tentatives de connexion, super-administrateur d'amorçage.
- Établissements, codes d'invitation hachés (rôle élève / enseignant / admin), membres.
- Projets cloud (CRUD, versions, concurrence optimiste, limite de taille, protection IDOR).
- Exercices versionnés avec barème secret, publication, vue élève sans valeurs attendues.
- Soumission → instantané immuable (SHA-256) → correction en tâche de fond par le moteur réel →
  rapport filtré (tests cachés retirés) pour l'élève, complet pour l'enseignant.
- Classes, adhésions, annonces, devoirs/examens (fenêtres, durée, tentatives, temps supplémentaire,
  visibilité des résultats), vérifications intermédiaires, révision de note avec historique et
  tableaux de bord élève/professeur.
- Collaboration WebSocket avec journal ordonné, rôles lecture/écriture, présence, curseurs, chat,
  ticks d'horloge et sauvegarde ; partage de projet par lien.
- TPacket Tutor : diagnostic déterministe disponible dans le simulateur et IA facultative, désactivée
  sans configuration serveur et contrôlée selon les règles du devoir.
- Éditeur visuel de critères avec essai local ; publication bloquée si la solution de référence
  n'obtient pas la note maximale.
- OpenAPI : `/api/docs`.

## Ce qui reste à développer
Voir `ROADMAP.md` pour le plan détaillé. Principaux manques :
- **Contenu pédagogique livré : 0 module, 0 cours, 0 exercice et 0 quiz** (objectif : 11 / 35 / 60 / 150).
- Cours, quiz, glossaire, calculateur de sous-réseaux, compétences, gamification, bibliothèque,
  groupes et import CSV d'élèves.
- Activity Wizard, variantes d'exercices à graine et Network Incident.
- Fonctions d'identité avancées : vérification/réinitialisation par e-mail, 2FA, OIDC et LTI ;
  interfaces d'administration détaillées.
- Équipements et protocoles manquants : routeur Wi-Fi domestique, téléphone IP, cloud, modem,
  pare-feu, IoT, SLAAC/DHCPv6/OSPFv3, ACL nommées, FTP/SMTP/POP3/NTP, export PCAP et PDU complexes.

## Limitations connues
- Docker n'est pas installé sur la machine de développement. Les images ont été construites et la
  stack lancée sur le serveur privé le 25 novembre ; les conteneurs API, web, PostgreSQL et Redis
  sont actifs et le contrôle de santé a répondu 200.
- La migration 0002 a été vérifiée montée/descendue/remontée sur SQLite puis appliquée avec succès
  sur le PostgreSQL du serveur (`0002`, tête Alembic).
- Le serveur est actuellement servi en HTTP sur le réseau local, sans TLS. Ne pas l'exposer à
  Internet avant d'ajouter un terminateur TLS et de configurer `NETLAB_COOKIE_SECURE=true`.
- Limitation de débit en mémoire de processus (une seule instance d'API) ; Redis prévu.
- Les protocoles RIP/OSPF représentent l'état convergé calculé : pas de paquets de routage ni de
  délai de convergence simulé. OSPFv3, SLAAC et DHCPv6 ne sont pas pris en charge.
- La collaboration conserve ses salons et son journal en mémoire du processus ; ce n'est pas un
  service partagé entre plusieurs instances d'API. Le fonctionnement de l'horloge collaborative
  doit encore être confirmé dans l'interface.
- La suite Playwright complète passe avec le compte administrateur partagé : inscription lors de la
  première spec, connexion si le compte existe déjà.
- Copier/coller entre projets non pris en charge ; pas de groupes d'équipements (zones uniquement).
- La CLI ne gère pas le déplacement du curseur dans la ligne ni `Ctrl+A/E`.
- STP et CDP sont calculés (pas de BPDU/annonces simulés) ; le compteur « type 5 » n'est pas MD5-crypt.
- Pas de benchmark de performance publié (objectifs 100 / 500 équipements non mesurés).
- L'accessibilité WCAG 2.2 AA est un objectif : rôles ARIA et focus visibles en place, aucun audit réalisé.
