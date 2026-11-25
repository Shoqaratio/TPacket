# Sécurité

## Signaler une vulnérabilité
Ne pas ouvrir de ticket public. Contacter les mainteneurs en privé (adresse à définir par
l'établissement qui héberge l'instance). Réponse visée sous 5 jours ouvrés.

## Mesures en place

| Menace | Mesure | Test |
| --- | --- | --- |
| Vol de mots de passe | Argon2id (19 MiB, t=2), politique ≥ 10 caractères | `test_auth.py` |
| Force brute | Fenêtre glissante par IP+e-mail et par e-mail (10 / 15 min) | `test_wrong_password_and_brute_force_lockout` |
| Vol de session | Jeton 256 bits, stocké haché (SHA-256), cookie `HttpOnly`, `SameSite=Lax`, `Secure` en production | `test_session_cookie_is_httponly…` |
| CSRF | Jeton double-submit obligatoire sur toute requête non sûre | `test_csrf_required_for_state_changes` |
| IDOR / fuite inter-établissements | Filtrage par propriétaire / appartenance ; 404 pour les non-membres | `test_project_crud…`, `test_org_isolation_and_roles` |
| Élévation de privilèges | Rôles vérifiés côté serveur ; un enseignant ne peut pas créer d'invitation staff | `test_org_isolation_and_roles` |
| Manipulation des notes | Note calculée uniquement côté serveur à partir de l'instantané | `test_submission_is_graded_server_side…` |
| Fuite des tests cachés | Barème jamais envoyé à l'élève ; rapport filtré | idem |
| Modification après soumission | Instantané immuable : garde ORM + trigger PostgreSQL, SHA-256 | `test_snapshot_is_immutable` |
| Injection SQL | Requêtes paramétrées SQLAlchemy uniquement | — |
| XSS | React (pas de `dangerouslySetInnerHTML`), CSP stricte sans script inline (Nginx) | — |
| Documents malveillants | Validation structurelle bornée (`validateProject`), configuration rejouée par le parseur, tailles maximales ; fragments presse-papiers validés avant import et IDs/MAC régénérés | `validateProject rejects…`, `selectionClipboard.test.ts` |
| Épuisement du moteur | Budget d'événements, limite de sauts L2, timeout/CPU/heap du grader, limites de conteneur | `STP…`, budget |
| Connexions réelles | Le moteur n'ouvre aucune socket ; le conteneur API est sur un réseau Docker interne | — |
| WebSocket collaboratif | Cookie de session validé, contrôle d'origine navigateur, autorisations propriétaire/partage, rôle lecture/écriture et taille maximale des messages | `test_classes.py` |
| Lien de partage | Jeton aléatoire stocké sous forme hachée ; membre de l'établissement requis | `test_classes.py` |
| Suivi d'examen | Événements désactivés par défaut au niveau établissement et documentés comme informatifs, jamais comme preuve de fraude | `test_classes.py` |
| Tutor IA | Désactivé sans URL configurée, limitation par utilisateur en mémoire, règle du devoir vérifiée côté serveur | `test_classes.py` |
| Secrets | Aucun secret dans le dépôt ; `.env` ignoré ; `.env.example` sans valeurs | — |

## Points ouverts
- Limitation de débit en mémoire (à partager via Redis en multi-instances).
- Pas encore de vérification d'e-mail, de réinitialisation de mot de passe ni de 2FA.
- Les salons et journaux de collaboration sont en mémoire : le déploiement multi-instance nécessitera
  un transport et un stockage partagés. Les ticks de l'horloge collaborative doivent encore être
  vérifiés dans l'interface.
- L'IA n'est pas activée par défaut. Si elle est configurée, les questions et diagnostics sont envoyés
  à l'URL choisie par l'opérateur ; évaluer le fournisseur, les règles de conservation et l'accès
  réseau avant activation. Le réseau Docker interne peut empêcher l'accès à un fournisseur externe.
- La CSP autorise actuellement `ws:` et `wss:` dans `connect-src` ; restreindre cette directive à
  l'origine effective lors d'un déploiement exposé.
- La migration 0002 a été appliquée avec succès sur le PostgreSQL du serveur et l'API répond au
  contrôle de santé. La stack actuelle est toutefois en HTTP sans TLS ; ne pas l'exposer à Internet
  avant d'ajouter TLS et d'activer les cookies `Secure`.
- Isolation du grader : sous-processus + conteneur ; un bac à sable dédié (gVisor / nsjail) est recommandé
  pour les grandes instances.
- Aucun audit de sécurité externe réalisé.
