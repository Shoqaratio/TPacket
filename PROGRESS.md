# Avancement — 26 novembre 2026

L'application reste en version `0.1.0`, mais a évolué depuis sa première livraison. Les fondations
(phase 1), le simulateur fondamental (phase 2) et le périmètre prévu du simulateur avancé (phase 3)
sont livrés. La phase 6 dispose de scénarios Network Incident, du suivi des compétences, de
récompenses personnelles et d’une bibliothèque communautaire modérée. Les phases 4 et 5 restent
**partiellement livrées**. Le Campus livre les premiers TP prêts à affecter.

## Ce qui fonctionne (vérifié)

| Suite | Résultat | Commande |
| --- | --- | --- |
| Moteur (Vitest) | 88 tests réussis | `npm test -w @netlab/engine` |
| Web (Vitest) | 9 tests réussis | `npm test -w @netlab/web` |
| API (Pytest) | 37 tests réussis avec Redis local | `cd apps/api && .venv/bin/python -m pytest -q --timeout 65` |
| Bout en bout (Playwright, Chromium, 1366×768, fr-FR) | 14/14 tests réussis | `cd apps/web && npx playwright test` |
| Typechecks engine + web | OK | `npm run typecheck` |
| Builds grader + web | OK | `npm run build` |
| Migrations Alembic montée/descendue/remontée (SQLite) | OK jusqu’à `0005` | `alembic upgrade head`, `alembic downgrade base`, `alembic upgrade head` |
| Migration PostgreSQL 0002 + santé API sur serveur Docker | OK | migration `0002 (head)`, `/api/health` répond `200` |

La configuration Playwright démarre l’API avec une base SQLite temporaire et Vite. Le scénario
multi-instance Pytest utilise `TPACKET_TEST_CAMPUS_REDIS_URL` pour joindre le Redis de test.

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
- Cours d'établissement : création enseignant/admin avec objectifs, durée estimée et leçons ; visibles
  aux membres de l'établissement dans l'Académie.
- TPacket Tutor : diagnostic déterministe disponible dans le simulateur et IA facultative, désactivée
  sans configuration serveur et contrôlée selon les règles du devoir.
- Éditeur visuel de critères avec essai local ; publication bloquée si la solution de référence
  n'obtient pas la note maximale.
- OpenAPI : `/api/docs`.

## Ce qui reste à développer
Voir `ROADMAP.md` pour le plan détaillé. Principaux manques :
- Le programme complet de l’Académie reste à constituer (objectif : 11 modules, 35 cours, 60 exercices
  et 150 quiz). Le Campus livre six modèles de TP installables par classe.
- Contenu de cours/quiz, glossaire, calculateur de sous-réseaux, groupes et import CSV d'élèves.
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
- La migration PostgreSQL `0005` est incluse dans la vérification CI. Elle reste à vérifier sur
  l’instance d’établissement.
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

## TPacket Campus

Le parcours de jeu comprend un hall, douze salles, des guides avec indices progressifs, un avatar
personnalisable, la navigation clavier/tactile/A*, les emotes et un mode économique à 30 images/s.
Les instances de classe proposent chat, annonces, assistance, signal de fin de travail, invitations
aux projets et présence pendant l’utilisation du simulateur. L’amphithéâtre présente une leçon de
l’Académie au rythme de l’enseignant. Le personnel peut placer des devoirs,
ouvrir ou fermer des salles, suspendre le chat d’un élève, déclencher un incident programmé et
exporter les résultats d’une mission en CSV.

Six TP sont livrés, chacun vérifié sur le moteur réel avec sa topologie initiale et une solution
fonctionnelle. Ils couvrent IPv4, IPv6, VLAN, routage statique, DNS et DHCP. Les examens, sauvegardes,
soumissions et rapports réutilisent les fonctions existantes. La progression Campus comprend XP,
niveaux et trois tenues à débloquer, avec accès aux badges et compétences de l’Académie.

Le test WebSocket local à 35 élèves couvre présence, déplacements et réception du chat. Il est exécuté
sur une instance API puis sur deux instances reliées par Redis. Cela mesure le parcours réseau sur la
machine de développement. La tenue continue sur réseau d’établissement, PostgreSQL en déploiement et
le rendu sur les postes des lycées restent à valider. Le test Playwright Campus couvre exploration,
ouverture d’un TP, correction serveur, XP et reprise du fichier de travail.

Restent à développer les sessions et activités ciblées sur des groupes, les quiz en direct, les
escape games, les quêtes et défis hebdomadaires, ainsi que les outils d’observation
fine pendant un incident. La carte source est éditable dans Tiled.
