<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP — état de travail partagé pour les agents de code" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Permettez à Claude Code, Codex, Cursor, Gemini CLI, Grok Build, Goose, GitHub Copilot CLI et OpenCode de se parler.</strong></p>

<p align="center">
  La couche de communication et de coordination open source et local-first pour les agents de code IA.
  Envoyez des messages en direct d'un harness à l'autre, détectez les chevauchements de travail avant que les agents ne modifient le code,
  partagez des décisions et effectuez des passations de tâches preuves à l'appui, le tout via un seul serveur MCP.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="version npm"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="téléchargements npm"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="version de Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="Licence MIT"></a>
</p>

<p align="center">
  <a href="#concord-en-action">Démo</a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#agents-pris-en-charge">Agents pris en charge</a> ·
  <a href="https://getconcord.ai">Site web</a> ·
  <a href="./CONTRIBUTING.md">Contribuer</a>
</p>

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.pt-BR.md">Português</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.ru.md">Русский</a>
</p>

## Concord en action

Deux agents exécutés dans des harness différents peuvent se découvrir, échanger des messages et se répartir le travail sans qu'un humain ait à leur relayer le contexte :

```text
Claude Code → Concord   Revendique src/app/page.tsx
Codex       → Concord   Revendique src/app/page.tsx
Concord     → Codex     Chevauchement : Claude Code possède déjà ce fichier
Codex       → Claude    Je prends src/app/api à la place. Ça te va ?
Claude      → Codex     Oui. Je garde la page et j'utilise ton contrat d'API.
```

Lancez la [vraie démo Claude Code ↔ Codex](./examples/whack-a-mole/) pour voir les deux agents résoudre un chevauchement de revendications grâce à un échange prompt/réponse en direct, construire une application jouable, transférer la propriété du travail et confier le résultat à un relecteur indépendant.

## Démarrage rapide

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Pas de Node.js ? Sous macOS ou Linux, installez plutôt une version autonome :

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

Elle embarque son propre runtime Node dans `~/.concord/standalone` et place les lanceurs `concord` et `concord-mcp` dans `~/.local/bin` (modifiable avec `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR` ; épinglez une version avec `CONCORD_VERSION`).

Redémarrez vos clients d'agents, puis demandez à deux d'entre eux de travailler dans le même dépôt. Concord leur fournit un espace de travail partagé et rend les sessions joignables accessibles aux prompts et réponses directs.

<details>
<summary>Ce que modifie <code>concord setup</code></summary>

`concord setup` crée l'espace de travail local `.concord/` et enregistre le serveur MCP pour Claude, Cursor, Gemini, Grok et Codex (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.grok/config.toml` et `~/.codex/config.toml`). Pour [Goose](./docs/goose.md), la commande enregistre l'extension `concord-relay` dans le `config.yaml` de Goose lorsqu'il est détecté. Pour [Antigravity](./docs/antigravity.md), elle écrit `.agents/mcp_config.json`, `.agents/hooks.json` et `.agents/rules/concord.md`. Elle écrit aussi les instructions d'utilisation des outils Concord dans les configurations de vos clients (`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`). Elle fusionne ses ajouts avec la configuration existante au lieu de la remplacer, et peut être relancée sans risque.

`concord setup` détecte également les clients pris en charge et tente d'installer leurs adaptateurs Concord globaux, indépendamment les uns des autres. Utilisez `--no-adapters` pour ignorer cette étape, ou `--require-adapters` pour les installations gérées qui doivent échouer si la prise en charge est dégradée. Passez `--no-mcp` pour n'écrire que l'espace de travail et les instructions, et gérer vous-même l'enregistrement MCP.

Lorsque le mode global est activé (voir ci-dessous), `concord setup` ne touche pas aux fichiers d'instructions et MCP du dépôt, car les enregistrements au niveau utilisateur les couvrent déjà ; passez `--repo-files` pour les écrire quand même, par exemple pour les versionner à l'intention d'une équipe.

</details>

<details>
<summary>Utiliser Concord dans des dépôts non configurés</summary>

La première fois que vous exécutez `concord setup` en mode interactif, la commande vous demande si vos agents doivent utiliser Concord dans les dépôts où `concord setup` n'a jamais été exécuté (oui par défaut). Votre réponse est enregistrée dans `~/.concord/config.json` ; `concord setup --global` ou `--no-global` permet de la modifier.

Lorsque le mode global est activé, Concord s'enregistre au niveau utilisateur pour chaque agent installé et ajoute une courte section Concord à ses fichiers d'instructions utilisateur (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, le `.goosehints` de Goose, `~/.copilot/copilot-instructions.md` ; Cursor la reçoit via son hook de session global). Rien n'est écrit dans ces dépôts : leur travail est conservé dans `~/.concord/global.db`, à raison d'un projet par dépôt, nommé d'après son remote git comme le fait Concord Cloud. Les sessions situées hors de tout dépôt partagent le projet `general`. Un dépôt que vous avez configuré conserve tout dans son propre `.concord/` ; tant que le mode global est activé, `concord setup` n'y écrit aucun fichier d'instructions ni fichier MCP, sauf si vous passez `--repo-files`. La désactivation du mode global supprime exactement ce qu'il avait ajouté.

</details>

<details>
<summary>Concord Cloud : des agents sur différentes machines</summary>

`concord cloud login` connecte cette machine à Concord Cloud et l'y associe. Une machine associée passe par le cloud dans tous les dossiers, si bien que ses agents peuvent joindre les agents de n'importe quelle machine. Tant que la machine est associée, aucun dépôt ne conserve d'état local : un dépôt doté d'un remote git correspond au projet de ce remote, un dépôt sans remote constitue un projet à part entière sur cette machine, et tout ce qui se trouve hors d'un dépôt relève de `general`.

`concord cloud unlink` repasse toute la machine en Concord local tout en conservant la connexion, et `concord cloud link` la rebascule sur le cloud. `concord cloud status` indique le mode en vigueur, et `concord doctor` vérifie l'association et liste l'état local que la machine n'utilise plus, avec les commandes permettant de le mettre de côté une fois qu'aucune session démarrée avant l'association n'est en cours d'exécution (rien n'est supprimé).

</details>

## Agents pris en charge

| Agent                                   | Guide d'intégration                                     |
| --------------------------------------- | ------------------------------------------------------- |
| Claude Code                             | [Configuration et remise](./docs/claude-code.md)        |
| Codex                                   | [Configuration et remise](./docs/codex.md)              |
| Cursor                                  | [Configuration et remise](./docs/cursor.md)             |
| Gemini CLI                              | [Configuration et remise](./docs/gemini-cli.md)         |
| Grok Build                              | [Configuration et remise](./docs/grok-build.md)         |
| Goose                                   | [Configuration et remise](./docs/goose.md)              |
| Google Antigravity                      | [Configuration et remise](./docs/antigravity.md)        |
| GitHub Copilot CLI                      | [Configuration et remise](./docs/github-copilot-cli.md) |
| OpenCode                                | [Configuration et remise](./docs/opencode.md)           |
| Devin CLI                               | Configuration au niveau du projet via `concord setup`   |
| Conductor (Claude Code, Codex)          | [Configuration et remise](./docs/conductor.md)          |
| Tout autre agent de code compatible MCP | [Configuration manuelle](./docs/other-mcp-clients.md)   |

> Il n'existe pas de commande slash `/concord` universelle : les commandes dépendent du client. Concord fonctionne via les outils MCP et les instructions installées sur tout client compatible MCP.

La remise en direct dépend du harness destinataire et de l'état de la session. Exécutez `concord adapters status` pour voir quels agents installés sont joignables et comment les messages leur seront remis.

## La communication n'est que le point de départ

La messagerie permet aux agents de se parler. L'état de travail partagé de Concord assure la fiabilité de la collaboration qui en découle, une fois le message remis.

| Sans Concord                                                              | Avec Concord                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Les agents ne peuvent pas contacter leurs pairs dans un autre harness     | Les agents s'envoient des prompts directs, avec réponse possible, entre clients pris en charge |
| Les agents découvrent les collisions après avoir modifié le code          | Les agents revendiquent les fichiers et modules avant de commencer                             |
| Le contexte disparaît à la fin d'une session                              | Les décisions, hypothèses et constats restent rattachés à la tâche                             |
| La propriété du travail se déduit de l'historique de discussion           | Les attributions et passations sont explicites et confirmées                                   |
| Les humains reconstituent l'avancement à partir des branches et des diffs | Les dossiers de revue arrivent avec le périmètre, les tests, les risques et la provenance      |

Concord n'est pas un agent autonome ou un orchestrateur de plus. C'est la couche partagée autour de vos agents : présence, messagerie, mémoire des tâches, propriété du travail, passations et état de revue, le tout via un petit serveur MCP.

## Les outils

| Outil           | Rôle                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_work`    | enregistre la présence, revendique ou accepte une tâche, et signale les chevauchements de périmètre avant toute modification                         |
| `inspect_work`  | lit l'état de l'espace de travail ou d'une tâche, la boîte de réception/d'envoi d'un agent, ou un fil durable de prompts/réponses                    |
| `update_work`   | consigne le contexte d'une tâche, ou envoie immédiatement un prompt/une réponse à un autre agent de l'espace de travail pouvant recevoir des prompts |
| `transfer_work` | attribue, accepte, décline, libère, réattribue, propose des passations ou rouvre un travail versionné                                                |
| `finish_work`   | consigne les preuves et marque éventuellement une tâche comme prête pour la revue, terminée ou fermée                                                |

Les écritures acceptent un `agent_id`, ce qui maintient la présence active par le simple fait de travailler. `inspect_work` montre **qui est là** et signale les **revendications obsolètes**, c'est-à-dire les revendications actives dont l'agent propriétaire est parti sans effectuer de passation.

Pour la communication en direct entre agents, exécutez `concord setup`, puis redémarrez une fois les sessions client existantes. Un prompt utilise `update_work` avec `operation: "prompt"`, le `to_agent_id` cible, le contenu et une `idempotency_key` ; une réponse utilise `operation: "reply"` et `reply_to_message_id`. Un adaptateur avec accusé de réception réoriente un tour en cours ou démarre un tour si la session est inactive. Les intégrations limitées aux hooks laissent un message durable à récupérer et signalent cette limite dans le résultat. La remise échoue immédiatement lorsque l'agent désigné n'a aucun point de terminaison joignable ; Concord ne le redirige jamais silencieusement.

`concord adapters status` rend compte de chaque harness séparément, notamment son type de moniteur/contrôleur, sa joignabilité vérifiée, l'action requise et le résultat de la détection de version. `concord adapters install`, `doctor` et `uninstall` offrent le même cycle de vie global en dehors de la configuration d'un dépôt.

Concord résout automatiquement l'espace de travail du dépôt. Les opérations renvoient son `workspace_id` et la racine du dépôt afin qu'un client puisse détecter un appel mal routé ; cet identifiant peut être passé explicitement lorsqu'un même serveur coordonne plusieurs racines.

Les opérations qui modifient le cycle de vie utilisent le numéro monotone `version` de la tâche comme `expected_version`. Si deux agents agissent sur la même version, seule la première transition réussit. Une attribution laisse le travail à l'état `assigned` jusqu'à ce que l'agent désigné utilise `transfer_work` avec `action: "accept"` ; de même, lors d'une proposition de passation, la propriété reste à l'expéditeur jusqu'à ce que le destinataire accepte. Chaque changement de propriété est conservé dans un historique d'audit en ajout seul.

## Ce que vous obtenez

SQLite est la source de vérité locale, conservée dans le `.concord/` à la **racine du dépôt** où le travail a lieu. Le serveur MCP résout cette racine à partir de `CONCORD_REPO_ROOT` si elle est définie, puis de `CLAUDE_PROJECT_DIR` de Claude Code (que Claude Code définit automatiquement, même pour un serveur au niveau utilisateur), puis de son répertoire de travail : ainsi, tous les agents d'un même dépôt partagent un seul stockage. Définissez `CONCORD_REPO_ROOT` lorsque vous exécutez le serveur depuis un répertoire de travail situé hors du dépôt.

Les worktrees Git liés suivent les métadonnées `commondir` de Git jusqu'au checkout principal : le checkout principal et tous les worktrees liés partagent donc volontairement une même base de données Concord et un même identifiant d'espace de travail.

Pour restreindre la sélection explicite d'un espace de travail, définissez `CONCORD_ALLOWED_ROOTS` avec une liste de racines de dépôts autorisées, séparées par le délimiteur de chemins du système. Sans liste d'autorisation, les racines décodées doivent tout de même exister et être des répertoires.

`concord setup` écrit un fichier `.concord/.gitignore` contenant `*` : l'espace de travail généré s'ignore donc lui-même et reste local sans modifier le `.gitignore` partagé du dépôt. Les équipes qui veulent inclure certains artefacts dans leurs PR peuvent ajouter des règles de négation à ce fichier (`concord setup` conserve les règles existantes et s'assure seulement de la présence du `*` global) ou forcer l'ajout des fichiers lisibles par des humains. Les dépôts configurés par Concord 0.10.5 ou une version antérieure ont aussi une règle `.concord/` dans le `.gitignore` racine ; supprimez-la pour que les négations de `.concord/.gitignore` prennent effet.

```text
.concord/
├── .gitignore          ignore tout le répertoire
├── concord.db          source de vérité locale
├── HANDOFF.md          passation lisible par des humains
├── REVIEW_PACKET.md    preuves prêtes pour la revue
├── events.jsonl        événements des outils par ordre chronologique, un objet JSON par ligne
└── WORK_STATE.json     export généré de l'état de travail
```

## CLI

Concord prend en charge à la fois des outils MCP typés et une CLI classique. Les agents compatibles MCP peuvent appeler les outils directement ; les humains et les agents orientés CLI peuvent travailler sur le même espace de travail partagé grâce aux commandes `concord`.

```bash
concord setup                # configure l'état local, les instructions et les clients MCP
concord status               # liste des agents, travail actif, chevauchements, revendications obsolètes, tâches prêtes pour la revue
concord dashboard            # vue en direct, pilotée au clavier, des agents, tâches, alertes et activités
concord who                  # quels agents sont présents et sur quoi ils travaillent
concord tasks                # liste toutes les tâches suivies
concord handoff <task-id>    # affiche la dernière passation
concord review-packet <id>   # affiche le dernier dossier de revue
concord export markdown      # régénère les artefacts de .concord/
concord check <files...>     # vérifie les chevauchements de fichiers exacts avec les tâches actives (pour hooks/CI)
concord watch                # affiche l'état de travail à chaque changement dans .concord (Ctrl-C pour arrêter)
concord doctor               # vérifications de l'espace de travail + adoption des outils par tâche
concord adapters status      # matrice globale des capacités de remise par harness

concord --repo ../project status        # sélectionne par chemin de dépôt depuis n'importe où
concord --workspace ws_... status       # sélectionne un identifiant renvoyé par une opération Concord
```

Pour bloquer les modifications conflictuelles dans un hook pre-commit ou en CI, exécutez `concord check src/file.ts` (ou `concord check --task <id> src/file.ts` pour exclure votre propre tâche). La commande se termine avec le code `1` lorsqu'une tâche active revendique le même fichier, et `0` en l'absence de chevauchement. Les hooks PreToolUse de Claude Code interprètent le code de sortie `2` comme un refus : utilisez donc `concord check src/file.ts || exit 2` dans ce hook.

`--repo` et `--workspace` sont des options globales mutuellement exclusives. La CLI utilise la même priorité `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → répertoire de travail et la même canonicalisation des worktrees liés que MCP.

`concord dashboard` est une TUI locale plein écran en lecture seule. Elle se rafraîchit chaque seconde à partir de l'espace de travail SQLite partagé tout en maintenant agents, tâches, alertes, contexte et chronologie dans une zone fixe du terminal. Utilisez `Tab` pour changer de panneau, `j`/`k` ou les touches fléchées pour sélectionner un travail, `/` pour filtrer, `?` pour l'aide et `q` pour quitter.

## Mise à jour

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

Relancez le programme d'installation `curl … | sh` pour mettre à jour une installation autonome.

Concord vérifie chaque jour les mises à jour disponibles et les signale dans la CLI, les outils MCP et le tableau de bord ; `concord setup` peut en installer une après confirmation (avec npm ou le programme d'installation, selon celui que vous avez utilisé), et `CONCORD_NO_UPDATE_CHECK=1` désactive ces vérifications.

## Ce que c'est / ce que ce n'est pas

Un état de travail partagé et une mémoire des tâches pour les agents de code qui utilisent le même checkout local. **Pas** un orchestrateur, un outil de revue de code, un service de synchronisation hébergé, une base de données vectorielle de mémoire ou un agent de code autonome.

Voir aussi : [Pourquoi ne pas simplement utiliser du markdown ?](./docs/why-not-markdown.md)

## Contribuer

Consultez [`CONTRIBUTING.md`](./CONTRIBUTING.md) et [`CLAUDE.md`](./CLAUDE.md). Ce dépôt est strictement typé (pas de `any`, pas de typecasts) et modulaire. Les bons points d'entrée pour débuter portent le label [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Historique des étoiles

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Graphique de l'historique des étoiles" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## Confidentialité et télémétrie

Concord envoie des données de télémétrie produit et de coordination à `getconcord.ai`. Elles comprennent des identifiants aléatoires d'installation et d'invocation ; des pseudonymes irréversibles, propres à chaque installation, pour l'espace de travail et le flux de tâches ; les versions de Concord, de Node et de la plateforme ; des métadonnées client normalisées ; les noms, résultats et durées des opérations ; des résultats agrégés sur les chevauchements et les garde-fous d'édition ; les étapes et latences de remise des messages ; les transitions du cycle de vie des tâches et le temps écoulé ; ainsi que les résultats explicitement signalés concernant l'acceptation, l'intégration, l'intervention humaine et les reprises de travail.

Concord n'envoie jamais de code, de chemins bruts de fichiers ou de dépôts, de remotes, de noms d'utilisateur, d'identifiants bruts de tâches ou d'agents, d'identifiants ou de contenu de messages, d'arguments de commande, d'entrées/sorties d'outils ni de contenu de tâches. Le serveur de réception stocke l'adresse IP de la requête et en déduit un code pays, qu'il stocke également. Ces champs côté serveur n'ont actuellement aucune expiration automatique. Définissez `CONCORD_TELEMETRY_DISABLED=1` (ou `DO_NOT_TRACK=1`) pour désactiver la télémétrie. L'envoi est effectué au mieux et ne peut jamais faire échouer une opération Concord.

## Licence

[MIT](./LICENSE)
