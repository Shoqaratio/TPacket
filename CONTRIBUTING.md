# Contribuer

## Règles du projet
- **Aucune fonctionnalité factice** : pas de bouton sans effet, pas de résultat réseau prédéfini. Une
  fonctionnalité non implémentée n'apparaît pas dans l'interface ; elle figure dans `ROADMAP.md`.
- Toute commande IOS acceptée modifie l'état ou est refusée avec un message IOS réaliste.
- Le moteur (`packages/engine`) reste **synchrone, déterministe et sans dépendance** : il est exécuté
  tel quel par le correcteur serveur. Pas de `Math.random`, pas d'horloge système, pas d'API DOM/Node
  (sauf `src/grading/cli.ts`).
- Toute ligne émise par `renderRunningConfig` doit être acceptée par le parseur (test d'aller-retour).
- Un changement de comportement du moteur incrémente `ENGINE_VERSION` (les notes y sont liées).

## Ajouter une commande IOS
1. Déclarer la syntaxe dans `packages/engine/src/ios/commands.ts` avec `def(tree, 'mot <ip> <1-4094>', handler, helps)`.
2. Modifier la structure `IosConfig` (`ios/config.ts`) et son rendu dans `renderRunningConfig`.
3. Faire agir le moteur (`sim/network.ts`) sur cette configuration.
4. Ajouter un test de comportement (pas seulement de syntaxe) et mettre à jour `COMPATIBILITY.md`.

## Vérifications avant une demande de fusion
```bash
npm run typecheck && npm test -w @netlab/engine
cd apps/api && .venv/bin/python -m pytest
cd apps/web && npx playwright test
```
Mettre à jour `PROGRESS.md`, `CHANGELOG.md` et, si besoin, `COMPATIBILITY.md`.
