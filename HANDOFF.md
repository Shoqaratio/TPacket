# Handoff — TPacket (état au 25/11/2026, travail interrompu à la demande de l'utilisateur)

Lire d'abord : `ARCHITECTURE.md`, puis ce fichier. Les résumés et plans dans `PROGRESS.md`,
`COMPATIBILITY.md`, `ROADMAP.md`, `CHANGELOG.md`, `README.md` et `SECURITY.md` ont été actualisés
pour refléter le travail de la 2e session. Les vérifications en attente et les limites connues
restent listées ci-dessous.

## Contexte
- Demande d'origine : cahier des charges très large en français (simulateur réseau type Packet Tracer + plateforme pédagogique BTS SIO). L'utilisateur parle français.
- 2e demande (en cours) : implémenter protocoles (RIP, OSPF, DHCP, DNS, NAT, IPv6, TCP + services), partie pédagogique (espaces élève/prof, éditeur d'exercices), collaboration, mode examen, TPacket Tutor, équipements sans fil.
- Dépôt git initialisé, **aucun commit** (ne committer que si l'utilisateur le demande).

## Architecture (rappel)
- `packages/engine` : moteur TS déterministe, synchrone, sans dépendance. Tourne dans un Web Worker (navigateur) ET côté serveur via `dist/grader.mjs` (bundle esbuild, `node build-grader.mjs`). La config IOS est persistée en texte et rejouée par le parseur CLI.
- `apps/web` : React 19 + Vite 8 + Tailwind 4 + React Flow + xterm + Zustand. `src/sim/worker.ts` héberge le moteur.
- `apps/api` : FastAPI + SQLAlchemy 2 + Alembic. Venv : `apps/api/.venv` (Python 3.12). Grading = sous-processus Node.

## Fait pendant la 2e session (tout testé sauf mention contraire)
### Moteur (`npm test -w @netlab/engine` → 76/76)
- `sim/routing.ts` : RIP v1/v2 (Bellman-Ford, split horizon, passive, auto-summary, compat. versions) et OSPF (adjacences via domaine de diffusion L2 réel, même aire/masque, router-id dupliqué, DR/BDR, SPF). **Calculés (état convergé), pas de paquets RIP/OSPF simulés ni délai de convergence** — à documenter dans COMPATIBILITY.
- `Network.broadcastDomain()` : parcourt câbles/hubs/AP/switchs (VLAN, trunk, STP).
- `sim/apps.ts` : DHCP (pools IOS, service Serveur, relais `ip helper-address`), DNS, TFTP, HTTP/HTTPS, écoute Telnet/SSH sur VTY. `sim/nat.ts` : NAT statique, pool, PAT overload, `show ip nat translations`.
- TCP minimal (SYN/SYN-ACK/PSH-ACK/RST) avec retransmissions ; UDP request avec retransmissions ; client DHCP (`dhcpRenew`, APIPA).
- IPv6 : adresses statiques, link-local EUI-64, NDP, ICMPv6, routage statique, `ipv6 unicast-routing` (pas de SLAAC/OSPFv3).
- Sans fil : `AccessPoint-PT`, `Smartphone`, `Tablet`, `Laptop` (Wireless0) ; association SSID/WPA2/portée (`WIFI_RANGE=400`).
- CLI : `ios/commands-l3.ts` (router rip/ospf, ip dhcp pool/excluded-address, ip nat…, ipv6…, copy run/tftp), modes `config-router`/`config-dhcp`, sessions VTY (`IosSession.openVty`), show ip protocols / ip ospf neighbor / ip dhcp binding / ipv6 interface brief / ipv6 route.
- PC : `ipconfig /renew /release`, `nslookup`, ping par nom et IPv6, `telnet`, `ssh -l`, navigateur (`browse()`).
- Correcteur : nouveaux critères `dhcp_client`, `service_access`, `dns_resolution`, `ipv6_connectivity`, `route_exists via rip|ospf`.
- `tutor/tutor.ts` : diagnostic déterministe aller+retour, 5 niveaux d'indices FR/EN, suggestion de commande.

### API (`cd apps/api && .venv/bin/python -m pytest --timeout 60` → 18/18)
- Modèles + migration `alembic/versions/0002_…` (vérifiée up/down/up sur SQLite) : classes, class_members, assignments, extensions, starts, exam_events, grade_history, announcements, project_shares ; `organizations.exam_monitoring`, `submissions.assignment_id/attempt`, `org_invites.class_id`.
- `routers/classes.py` : classes, codes d'inscription de classe, annonces, devoirs/examens (fenêtre, durée, tentatives, temps supplémentaire, visibilité des résultats), vérification intermédiaire (critères publics), soumission, révision de note avec historique, événements d'examen (stockés seulement si l'établissement l'active), tableaux de bord élève/prof.
- `routers/collab.py` : WebSocket `/api/ws/projects/{id}` (journal d'opérations ordonné, ticks d'horloge serveur 1/s, rôles read/write, chat, curseurs, `save`), partage par lien `/api/projects/{id}/share`. Test via vrai uvicorn (le TestClient met chaque WS dans une boucle différente).
- `routers/tutor.py` : IA facultative (OpenAI-compatible, `NETLAB_AI_URL/KEY/MODEL`), désactivée par défaut, refusée si le devoir interdit le tutor.
- `requirements-dev.txt` : ajout pytest-timeout, websockets.

### Web (`npx tsc --noEmit -p apps/web` OK, `npx vite build` OK)
- Formulaire hôte (statique/DHCP réel, IPv6, Wi-Fi), onglet Config du point d'accès, onglet Services du serveur, navigateur web (iframe sandboxée), liens Wi-Fi sur le canevas.
- `pages/Teacher.tsx`, `pages/Student.tsx`, `components/AssignmentBar.tsx` (chrono, auto-soumission, vérifier/rendre, signalement d'onglet), `components/ExerciseEditor.tsx` (éditeur visuel de critères, test local, publication seulement si la solution a la note max), `components/TutorPanel.tsx`, `components/CollabPanel.tsx`, `collab.ts` (interception des requêtes d'état via `intercept.route` dans `sim/client.ts`).
- Playwright : `apps/web/playwright.config.ts` démarre **l'API (SQLite temporaire) + Vite**. Specs : `lab.spec.ts` (3), `platform.spec.ts` (2), `collab.spec.ts` (1). Suite complète relancée le 25/11 : **6/6 passent**. Les deux specs plateforme/collaboration créent maintenant l'administrateur à la première inscription, puis se connectent explicitement si une autre spec l'a déjà créé (HTTP 409).

## Problèmes connus / à vérifier en priorité
1. **Horloge en session collaborative** : sur la capture `apps/web/test-results/collab.png`, la barre d'état affiche `00:00:00`. Les ticks serveur (`op.kind === 'tick'`) sont censés appeler `direct({method:'tick'})` dans `collab.ts/apply` : vérifier qu'ils arrivent et que la vue est republiée.
2. En collaboration, la console d'une session CLI est clé `${actor}|${session}` : les messages système (`onConsole`) sont diffusés par appareil, donc visibles par tous — acceptable mais à confirmer.
3. Déploiement Docker du 25/11 sur le serveur privé terminé : `/opt/netlab`, conteneurs API/web/PostgreSQL/Redis actifs, `/api/health` répond `200` et Alembic est à `0002 (head)` sur PostgreSQL. Le `.env` existant a été conservé et son SHA-256 vérifié. L'instance est en HTTP sans TLS ; ne pas l'exposer à Internet avant d'ajouter un terminateur TLS et de régler `NETLAB_COOKIE_SECURE=true`. Pour les prochains transferts depuis macOS, préférer `rsync` (en excluant `.env`, `.git`, `node_modules`, `.venv` et `dist`) : une archive tar contenant des métadonnées xattr a créé des fichiers AppleDouble `._*.py` que Alembic a interprétés comme des migrations. Deux dossiers de sauvegarde pré-déploiement sont conservés à côté de `/opt/netlab`.
4. `infra/nginx.conf` a reçu un bloc `/api/ws/` (upgrade WebSocket) et `connect-src 'self' ws: wss:` (à resserrer).
5. Si l'API tourne sur le réseau Docker `backend` interne, une IA externe (`NETLAB_AI_URL`) est injoignable : prévoir un service Ollama dans compose ou un réseau sortant.

## Non fait (reste du cahier des charges)
- Contenu pédagogique (0 cours, 0 exercice livré, glossaire, quiz, calculateur de sous-réseaux), éditeur de cours, quiz.
- Compétences, gamification, bibliothèque communautaire, Network Incident, variantes d'exercices à graine.
- Import CSV d'élèves, groupes, années scolaires (seul un champ `academic_year`), admin d'établissement/super-admin UI, e-mail (vérification/réinitialisation), 2FA, OIDC, LTI.
- Routeur Wi-Fi domestique, téléphone IP, cloud, modem, pare-feu, IoT ; SLAAC/DHCPv6/OSPFv3 ; ACL nommées ; FTP/SMTP/POP3/NTP ; export PCAP ; PDU complexes.
- Mise à jour de toute la documentation (voir en-tête).

## Commandes utiles
```bash
npm install && npm run build -w @netlab/engine
npm test -w @netlab/engine
cd apps/api && .venv/bin/python -m pytest -q --timeout 60
cd apps/web && npx tsc --noEmit -p . && npx playwright test   # lance API + Vite
```
