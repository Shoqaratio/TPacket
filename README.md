# TPacket

Simulateur réseau **100 % web** inspiré de Cisco Packet Tracer et plateforme pédagogique pour le
BTS SIO. Aucun logiciel Cisco n'est inclus : l'émulation IOS est un interpréteur indépendant.

> **État : v0.1.0 — version initiale enrichie dans l'arbre de travail.** Le simulateur comprend
> maintenant un sous-ensemble de RIP/OSPFv2/OSPFv3 (messages de contrôle périodiques sur L2), ACL
> nommées, DHCP/DHCPv6, DNS, NAT/PAT, TCP, FTP, SMTP/POP3, NTP, IPv6 statique/SLAAC et Wi-Fi.
> Le mode Simulation comprend les PDU complexes
> ICMP/TCP/UDP et l'export PCAP Ethernet. Les espaces élève/professeur, devoirs/examens, éditeur de critères,
> collaboration et tutorat sont également présents. Le Campus fournit six modèles de TP installables.
> La phase 2 ajoute des modèles d'équipement, l'édition de ligne CLI et le
> copier/coller inter-projets. Les capacités et limites précises sont détaillées dans
> [PROGRESS.md](PROGRESS.md) et [COMPATIBILITY.md](COMPATIBILITY.md).

## Démarrage rapide (développement)

Prérequis : Node.js ≥ 20, Python 3.12.

```bash
npm install                       # moteur + web
npm run build -w @netlab/engine   # produit packages/engine/dist/grader.mjs (correcteur serveur)
npm run dev                       # http://localhost:5173 — le simulateur fonctionne sans serveur

# API (comptes, cloud, correction)
cd apps/api
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli create-admin vous@exemple.fr   # super-admin (mot de passe demandé)
.venv/bin/uvicorn app.main:app --reload   # /api/docs
```

Le serveur de développement Vite relaie `/api` vers `localhost:8000`.

## TPacket Campus

Connectez-vous, puis choisissez **Campus** dans l’Académie ou ouvrez `/campus`. Le hall donne accès à
douze salles. Les déplacements sont possibles avec ZQSD, WASD, les flèches, un clic ou les commandes tactiles.
Le plan (`M`) permet de choisir une destination à pied. Approchez-vous d’un écran turquoise et appuyez sur
`E` pour ouvrir les missions de la salle.

Les enseignants choisissent une classe, ouvrent **Gestion**, puis installent les TP proposés ou affectent un
devoir existant à une salle. Les examens de la classe apparaissent dans la salle d’examen. Les missions
ouvrent le simulateur TPacket, avec sa sauvegarde et son correcteur habituels. **Retour au campus** revient
au même endroit après sauvegarde locale.

Docker Compose configure Redis pour les salons Campus. En développement, `NETLAB_CAMPUS_REDIS_URL`
est facultative et le mode sans Redis utilise la mémoire d’une seule instance API. Appliquez la migration
`0005` avec `alembic upgrade head`.

## Déploiement (auto-hébergement)

```bash
cp .env.example .env    # renseigner POSTGRES_PASSWORD…
docker compose up -d --build   # http://localhost:8080 (placer un terminateur TLS devant)
docker compose exec api python -m app.cli create-admin vous@exemple.fr   # premier super-admin
```

Les droits super-administrateur ne s'obtiennent jamais par l'inscription : utilisez
`python -m app.cli create-admin|promote-admin|demote-admin EMAIL` sur le serveur (actions journalisées).

> Build et lancement Docker vérifiés sur le serveur privé le 25 novembre. L'instance actuelle est
> en HTTP sur le réseau local, sans TLS : ne pas l'exposer à Internet avant d'ajouter un terminateur
> TLS et de configurer `NETLAB_COOKIE_SECURE=true`.

Sur le dépôt GitHub, chaque push sur `main` est déployé après la réussite de CI. Le runner privé
`tpacket-deploy` est installé sur l'hôte Docker (l'adresse du serveur est privée et n'est pas
joignable depuis les runners GitHub hébergés). Pendant la reconstruction et le redémarrage, la
passerelle affiche la progression par étapes, puis réactive le site après vérification de l'API et du
frontend. Les conteneurs API et web sont redémarrés; la passerelle, PostgreSQL et Redis restent actifs.
Une connexion ou la création d'un compte est nécessaire pour accéder à l'interface et aux projets.
En cas d'échec, la page reste affichée pour éviter de présenter un service incomplet.

## Tests

```bash
npm test -w @netlab/engine                               # comportement réseau, CLI, correcteur
cd apps/api && .venv/bin/python -m pytest -q --timeout 60 # API, plateforme et collaboration
cd apps/web && npx tsc --noEmit -p .                     # types web
cd apps/web && npx playwright test                       # API temporaire + Vite + Chromium
```

La suite inclut des tests Campus de navigation, de permissions et de charge WebSocket à 35 élèves
avec Redis. Les résultats et les limites de validation figurent dans [PROGRESS.md](PROGRESS.md).

## Structure

```
packages/engine   moteur de simulation + interpréteur IOS + correcteur (TypeScript, sans dépendance)
apps/web          interface React (Vite, Tailwind, React Flow, xterm.js, Web Worker, PWA)
apps/api          API FastAPI (PostgreSQL, SQLAlchemy, Alembic) — exécute le correcteur du moteur
infra             configuration Nginx
docs              formats de fichiers
```

Documentation : [ARCHITECTURE](ARCHITECTURE.md) · [ROADMAP](ROADMAP.md) · [PROGRESS](PROGRESS.md) ·
[COMPATIBILITY](COMPATIBILITY.md) · [SECURITY](SECURITY.md) · [CONTRIBUTING](CONTRIBUTING.md) ·
[CHANGELOG](CHANGELOG.md) · [Format .netlab](docs/FORMATS.md)

« Cisco », « IOS », « Catalyst » et « Packet Tracer » sont des marques de Cisco Systems, Inc.,
citées uniquement pour décrire la compatibilité. TPacket n'est ni affilié ni approuvé par Cisco.
