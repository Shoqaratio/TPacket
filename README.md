# TPacket

Simulateur réseau **100 % web** inspiré de Cisco Packet Tracer et plateforme pédagogique pour le
BTS SIO. Aucun logiciel Cisco n'est inclus : l'émulation IOS est un interpréteur indépendant.

> **État : v0.1.0 — version initiale enrichie dans l'arbre de travail.** Le simulateur comprend
> maintenant un sous-ensemble de RIP/OSPFv2/OSPFv3, ACL nommées, DHCP/DHCPv6, DNS, NAT/PAT, TCP,
> services applicatifs, IPv6 statique/SLAAC et Wi-Fi. Le mode Simulation comprend les PDU complexes
> ICMP/TCP/UDP et l'export PCAP Ethernet. Les espaces élève/professeur, devoirs/examens, éditeur de critères,
> collaboration et tutorat sont également présents. Le contenu de cours, d'exercices et de quiz
> n'est pas encore livré. La phase 2 ajoute des modèles d'équipement, l'édition de ligne CLI et le
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
NETLAB_BOOTSTRAP_ADMIN_EMAIL=vous@exemple.fr .venv/bin/alembic upgrade head
NETLAB_BOOTSTRAP_ADMIN_EMAIL=vous@exemple.fr .venv/bin/uvicorn app.main:app --reload   # /api/docs
```

Le serveur de développement Vite relaie `/api` vers `localhost:8000`.

## Déploiement (auto-hébergement)

```bash
cp .env.example .env    # renseigner POSTGRES_PASSWORD, NETLAB_BOOTSTRAP_ADMIN_EMAIL…
docker compose up -d --build   # http://localhost:8080 (placer un terminateur TLS devant)
```

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

Dernière vérification consignée : 84 tests moteur, 9 tests web, 18 tests API, typechecks/builds
réussis et 11/11 tests Playwright réussis dans la suite complète. Consulter [PROGRESS.md](PROGRESS.md) pour les limites de
validation et de déploiement.

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
