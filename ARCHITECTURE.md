# Architecture de TPacket

## Vue d'ensemble

```
┌──────────────────────────── Navigateur ────────────────────────────┐
│  apps/web (React 19, TypeScript strict, Vite, Tailwind, Zustand)    │
│   ├─ UI : éditeur React Flow, panneaux, xterm.js, fenêtres d'équip. │
│   ├─ IndexedDB : sauvegarde locale prioritaire (hors ligne, PWA)    │
│   └─ Web Worker ──► @netlab/engine  (simulation déterministe)       │
└───────────────┬─────────────────────────────────────────────────────┘
                │ HTTPS /api (cookie de session + jeton CSRF)
┌───────────────▼──────────── Serveur ───────────────────────────────┐
│ Nginx (SPA + reverse proxy, CSP)                                    │
│ apps/api  FastAPI + SQLAlchemy 2 + Alembic ── PostgreSQL            │
│   └─ correction : sous-processus Node ──► engine/dist/grader.mjs    │
│        (même code que le navigateur, limites CPU/mémoire/délai)     │
│ Redis (prévu : limitation de débit partagée et salons multi-instance)│
└─────────────────────────────────────────────────────────────────────┘
```

## Décisions structurantes

### 1. Un seul moteur de simulation, exécuté des deux côtés
`packages/engine` est une bibliothèque TypeScript **sans dépendance, synchrone et déterministe**
(aucun `Math.random`, aucune horloge système : le temps est une horloge simulée en ms).
- Dans le navigateur, elle tourne dans un **Web Worker** (`apps/web/src/sim/worker.ts`) : l'interface
  ne reçoit que des *view models* ; le thread principal reste fluide.
- Sur le serveur, `build-grader.mjs` la compile en un unique fichier `dist/grader.mjs` exécuté par
  l'API dans un sous-processus Node. **Le serveur ne fait jamais confiance au client** : il reconstruit
  le réseau à partir de l'instantané soumis et rejoue la simulation.

Cette approche évite deux implémentations divergentes (TS + Python) et garantit la reproductibilité :
une note est liée à `engine_version` et à une version précise de l'exercice.

### 2. La configuration IOS est persistée en **texte**
Les équipements Cisco sont enregistrés avec leur `running-config` et leur `startup-config` texte
(voir `docs/FORMATS.md`). Au chargement, le texte est **rejoué par l'interpréteur CLI** — le même
que celui de l'élève. Conséquences :
- une seule autorité sur la sémantique des commandes (pas de double modèle JSON/CLI) ;
- un document hostile ne peut injecter qu'une configuration que la CLI accepte ; toute ligne refusée
  est signalée (`loadErrors`), jamais ignorée silencieusement ;
- import/export de configurations Cisco texte sans code supplémentaire ;
- sémantique fidèle : `copy running-config startup-config`, `reload`, `erase startup-config`,
  coupure d'alimentation (la running-config est perdue).

`vlan.dat` (base VLAN des switchs) et les clés RSA sont stockés à part, comme sur le matériel réel
(ils survivent à `erase startup-config`).

### 3. Simulation événementielle
`Network` (`sim/network.ts`) maintient une file d'événements triée (temps, séquence). Chaque trame
traverse réellement : câble (compatibilité, brochage MDI/MDI‑X, état administratif, vitesse,
horloge DCE série) → commutateur (VLAN, 802.1Q, STP, table CAM) → pile IP (ARP, proxy ARP,
LPM, TTL, ACL entrée/sortie, ICMP). Un ping n'est réussi que si une réponse ICMP revient
effectivement à la source. Les rejets portent un **code de cause** (`no_route`, `acl_out`,
`stp_blocking`…) traduit dans l'interface et affiché dans le mode Simulation.

- Mode **temps réel** : l'horloge avance d'une seconde par seconde ; les commandes (ping…) traitent
  la file jusqu'à la réponse ou au délai d'expiration.
- Mode **Simulation** : l'horloge est figée ; « Pas à pas » traite les événements d'un même instant ;
  les trames émises sont animées sur les liens.
- STP : l'arbre 802.1D (PVST, un calcul par VLAN) est **calculé** à partir de la topologie (résultat de
  convergence des BPDU) ; les temporisations écoute/apprentissage (2 × 15 s) sont appliquées à partir
  des instants de changement de rôle. CDP est également dérivé de la topologie. Ces simplifications
  sont listées dans `COMPATIBILITY.md`.
- Garde-fous : limite de sauts L2, budget de 200 000 événements par exécution (tempête de diffusion).

### 4. Stockage local d'abord
Chaque modification déclenche une sauvegarde IndexedDB (600 ms), puis une synchronisation cloud
(PUT avec `base_version` : un conflit renvoie 409, l'utilisateur peut enregistrer une copie).

### 5. Sécurité de la correction
- Les barèmes (critères cachés compris) ne quittent jamais le serveur ; l'élève reçoit les critères
  publics sans valeurs attendues.
- La soumission crée un `submission_snapshot` immuable (garde ORM + trigger PostgreSQL) avec son
  SHA-256, puis une tâche `grading_job` exécutée en arrière-plan.
- Le grader s'exécute avec un environnement vide, `RLIMIT_CPU`, un tas V8 limité, un délai, et
  dans un conteneur en lecture seule sur un réseau Docker interne sans accès Internet.

## Modules

| Chemin | Rôle |
| --- | --- |
| `packages/engine/src/model` | Catalogue d'équipements, câbles, document projet, validation des entrées non fiables |
| `packages/engine/src/sim` | Réseau, files d'événements, STP, paquets |
| `packages/engine/src/ios` | Parseur générique (trie, abréviations, `?`, TAB), commandes, rendu `show` et running-config, session CLI |
| `packages/engine/src/host` | Invite de commandes des PC (ipconfig, ping, tracert, arp) |
| `packages/engine/src/grading` | Correcteur déterministe et point d'entrée Node |
| `apps/web/src/sim` | Worker et client RPC typé |
| `apps/web/src/components` | Espace de travail (menu, outils, bibliothèque, canevas, propriétés, terminal, événements, fenêtres) |
| `apps/api/app` | FastAPI : auth, établissements, projets, exercices, soumissions, correction |

## Modèle de données (implémenté)

`users`, `organizations`, `organization_members` (rôle : student / teacher / org_admin),
`org_invites` (codes hachés), `sessions` (jetons hachés + CSRF), `projects`, `project_versions`
(30 dernières), `exercises`, `exercise_versions` (énoncé, projet initial, barème secret),
`submissions`, `submission_snapshots`, `grading_jobs`, `grading_results`, `audit_logs`,
`classes`, `class_members`, `assignments`, `assignment_extensions`, `assignment_starts`,
`exam_events`, `grade_history`, `announcements`, `project_shares` et `community_publications`.
Les versions d'exercice distinguent les incidents réseau et conservent une association critères-compétences.
Les compétences sont un catalogue applicatif ; points et badges sont dérivés des résultats visibles,
pas stockés comme classement. Les publications communautaires restent invisibles jusqu'à validation
super-admin. Ces fonctions ne constituent pas encore un système complet de cours/quiz.

Isolation : toute ressource d'établissement est filtrée par appartenance ; un non-membre reçoit
**404** (et non 403) pour ne pas révéler l'existence d'une ressource. La collaboration ordonne les
opérations côté serveur, mais les salons et leur journal restent en mémoire d'un processus ; chaque
participant rejoue les opérations dans son moteur déterministe local. Les ticks serveur font avancer
le worker de chaque participant ; l'horloge affichée utilise le temps du worker. Les cours et quiz
restent planifiés dans `ROADMAP.md`.
