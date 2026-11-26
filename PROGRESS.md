# Avancement — 26 novembre 2026

L'application reste en version `0.1.0`, mais a évolué depuis sa première livraison. Les fondations
(phase 1), le simulateur fondamental (phase 2) et le périmètre prévu du simulateur avancé (phase 3)
sont livrés. La phase 6 dispose désormais de scénarios Network Incident, suivi des compétences,
récompenses personnelles et bibliothèque communautaire modérée ; leur suite de tests doit encore être
exécutée. Les phases 4 et 5 restent **partiellement livrées**. Le contenu pédagogique livré reste à créer.

Les résultats ci-dessous comprennent la suite Playwright complète exécutée après l'implémentation de
la phase 2 et la correction du conflit d'inscription du compte administrateur partagé.

## Ce qui fonctionne (vérifié)

| Suite | Résultat | Commande |
| --- | --- | --- |
| Moteur (Vitest) | 88 tests réussis | `npm test -w @netlab/engine` |
| Web (Vitest) | 9 tests réussis | `npm test -w @netlab/web` |
| API (Pytest) | 19 tests réussis | `cd apps/api && .venv/bin/python -m pytest -q --timeout 60` |
| Bout en bout (Playwright, Chromium, 1366×768, fr-FR) | 11/11 tests réussis dans la suite complète | `cd apps/web && npx playwright test` |
| Typechecks engine + web | OK | `npm run typecheck` |
| Builds grader + web | OK | `npm run build` |
| Migration Alembic montée/descendue/remontée (SQLite) | OK | vérification consignée dans le handoff |
| Migration PostgreSQL 0002 + santé API sur serveur Docker | OK | migration `0002 (head)`, `/api/health` répond `200` |

La configuration Playwright démarre l'API avec une base SQLite temporaire et Vite. La base et le
serveur sont donc ceux de l'environnement de test, pas une instance de production.

### Simulateur (navigateur)
- Espace de travail : barre de menus, barre d'outils, onglets de projets, bibliothèque, canevas
  (zoom, déplacement, minimap, grille magnétique, sélection multiple, menu contextuel), panneau de
  propriétés, terminal, liste d'événements, barre d'état, thème clair/sombre, FR/EN.
- Glisser-déposer des équipements, câblage manuel (choix du port) ou automatique, notes, zones
  colorées redimensionnables, dupliquer, copier/coller (y compris entre projets), alignement, annuler /
  rétablir (50 niveaux), raccourcis clavier, export PNG / SVG / PDF, plein écran.
- Fenêtre d'équipement : Physique (alimentation, modules), Config (PC : IP ; IOS : import/export de
  configuration texte), CLI, Bureau (Configuration IP, Invite de commandes, Terminal console).
- Hôtes : configuration IPv4 statique ou DHCP, IPv6 statique/SLAAC/DHCPv6 et Wi-Fi. Points d'accès configurables ;
  les serveurs proposent DHCP, DNS, TFTP, HTTP(S), FTP, SMTP/POP3 et NTP simulés. Le navigateur intégré est sandboxé.
- Moteur dans un Web Worker ; sauvegarde automatique IndexedDB ; synchronisation cloud avec
  détection de conflit ; import/export `.netlab`.
- Modes Temps réel (avance rapide +30 s) et Simulation (PDU complexes ICMP/TCP/UDP, pas à pas,
  lecture, vitesse, animation, filtres, inspection OSI, cause de rejet et export PCAP Ethernet).
- Équipements phase 2 : téléphone IP et IoT configurables comme hôtes, modem et cloud comme ponts,
  pare-feu IOS avec ACL, routeur Wi-Fi domestique avec interface radio configurable.
- Terminal : édition de ligne avec curseur, Home/End, Ctrl+A/E/W, suppression avant/après et historique.
- ACL nommées, RIP v1/v2, OSPFv2/v3, NAT/PAT, DHCP/DHCPv6, DNS, TCP minimal, services applicatifs,
  IPv6 statique/autoconfigurée et connectivité sans fil ; voir les limites précises dans
  `COMPATIBILITY.md`.
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
- Network Incident : scénarios de dépannage à partir d'une topologie initiale et d'une solution de
  référence, correction par critères et attribution possible dans un devoir.
- Compétences réseau associables aux critères visibles ; progression élève calculée sur les meilleurs
  résultats publiés. Points et badges personnels sont calculés sans classement public.
- Bibliothèque communautaire : partage explicite par un enseignant, file de modération super-admin,
  catalogue public des ressources approuvées et ouverture des projets comme modèles locaux.
- TPacket Tutor : diagnostic déterministe disponible dans le simulateur et IA facultative, désactivée
  sans configuration serveur et contrôlée selon les règles du devoir.
- Éditeur visuel de critères avec essai local ; publication bloquée si la solution de référence
  n'obtient pas la note maximale.
- OpenAPI : `/api/docs`.

## Ce qui reste à développer
Voir `ROADMAP.md` pour le plan détaillé. Principaux manques :
- **Contenu pédagogique livré : 0 module, 0 cours, 0 exercice et 0 quiz** (objectif : 11 / 35 / 60 / 150).
- Cours, quiz, glossaire, calculateur de sous-réseaux, groupes et import CSV d'élèves.
- Activity Wizard et variantes d'exercices à graine.
- Fonctions d'identité avancées : vérification/réinitialisation par e-mail, 2FA, OIDC et LTI ;
  interfaces d'administration détaillées.
- Les mises à jour RIP et les messages Hello/LSA OSPFv2/v3 sont livrés sur L2 avec des minuteries
  périodiques ; l'installation des routes reste une projection de l'état convergé, sans dead timer,
  hold-down ni convergence progressive. TCP et les services applicatifs sont des sous-ensembles,
  pas des piles RFC complètes ; le routeur Wi-Fi ne propose pas de configuration de bridge/VLAN
  granulaire. Voir `COMPATIBILITY.md`.

## Limitations connues
- Docker n'est pas installé sur la machine de développement. Les images ont été construites et la
  stack lancée sur le serveur privé le 25 novembre ; les conteneurs API, web, PostgreSQL et Redis
  sont actifs et le contrôle de santé a répondu 200.
- La migration 0002 a été vérifiée montée/descendue/remontée sur SQLite puis appliquée avec succès
  sur le PostgreSQL du serveur (`0002`, tête Alembic).
- La migration 0003 et les tests API/web de la phase 6 n'ont pas pu être lancés sur la machine de
  développement : Python, Node.js et npm ne sont pas disponibles. Le diagnostic TypeScript de VS Code
  ne signale pas d'erreur sur les écrans modifiés.
- Le serveur est actuellement servi en HTTP sur le réseau local, sans TLS. Ne pas l'exposer à
  Internet avant d'ajouter un terminateur TLS et de configurer `NETLAB_COOKIE_SECURE=true`.
- Limitation de débit en mémoire de processus (une seule instance d'API) ; Redis prévu.
- RIP et OSPFv2/v3 représentent l'état convergé calculé : pas de paquets de routage ni de délai de
  convergence simulé. OSPFv3 ne prend en charge qu'un processus par routeur. DHCPv6 attribue un
  préfixe, mais le client n'utilise pas encore l'option DNS ; voir `COMPATIBILITY.md`.
- L'export PCAP est au format classique 2.4/Ethernet, préserve les tags 802.1Q et ne capture que les
  trames émises ; HDLC série n'est pas exporté.
- La collaboration conserve ses salons et son journal en mémoire du processus ; ce n'est pas un
  service partagé entre plusieurs instances d'API. Le fonctionnement de l'horloge collaborative
  doit encore être confirmé dans l'interface.
- La suite Playwright complète passe avec le compte administrateur partagé : inscription lors de la
  première spec, connexion si le compte existe déjà. Les tests de la suite peuvent partager la base
  temporaire de l'exécution.
- Le copier/coller inter-projets dépend des permissions presse-papiers du navigateur ; limite de 4 Mo.
- Pas de groupes d'équipements (zones uniquement).
- STP et CDP sont calculés (pas de BPDU/annonces simulés) ; le compteur « type 5 » n'est pas MD5-crypt.
- Pas de benchmark de performance publié (objectifs 100 / 500 équipements non mesurés).
- L'accessibilité WCAG 2.2 AA est un objectif : rôles ARIA et focus visibles en place, aucun audit réalisé.
