<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP – gemeinsamer Arbeitsstand für Coding-Agents" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Lass Claude Code, Codex, Cursor, Gemini CLI, Grok Build, Goose, GitHub Copilot CLI und OpenCode miteinander sprechen.</strong></p>

<p align="center">
  Die quelloffene Local-First-Schicht für Kommunikation und Koordination von KI-Coding-Agents.
  Sende Live-Nachrichten über Harnesses hinweg, erkenne Überschneidungen, bevor Agents editieren,
  teile Entscheidungen und übergib Aufgaben per Handoff samt Nachweisen – alles über einen einzigen MCP-Server.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm-Version"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm-Downloads"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js-Version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT-Lizenz"></a>
</p>

<p align="center">
  <a href="#in-aktion">Demo</a> ·
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#unterstützte-agents">Unterstützte Agents</a> ·
  <a href="https://getconcord.ai">Website</a> ·
  <a href="./CONTRIBUTING.md">Mitwirken</a>
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

## In Aktion

Zwei Agents in unterschiedlichen Harnesses können einander finden, Nachrichten austauschen und die Arbeit aufteilen, ohne dass ein Mensch Kontext zwischen ihnen weiterreichen muss:

```text
Claude Code → Concord   Claim auf src/app/page.tsx
Codex       → Concord   Claim auf src/app/page.tsx
Concord     → Codex     Überschneidung: Claude Code hält diese Datei bereits
Codex       → Claude    Dann übernehme ich stattdessen src/app/api. Passt das?
Claude      → Codex     Ja. Ich bleibe an der Seite und nutze deinen API-Contract.
```

Starte die [echte Claude Code ↔ Codex-Demo](./examples/whack-a-mole/) und sieh zu, wie beide Agents per Live-Prompt und Antwort einen überschneidenden Claim auflösen, eine spielbare App bauen, die Ownership übertragen und das Ergebnis an einen unabhängigen Reviewer übergeben.

## Schnellstart

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Kein Node.js? Unter macOS oder Linux kannst du stattdessen einen eigenständigen Build installieren:

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

Er bringt unter `~/.concord/standalone` eine eigene Node-Runtime mit und legt die Launcher `concord` und `concord-mcp` in `~/.local/bin` ab (überschreibbar mit `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR`; mit `CONCORD_VERSION` pinnst du ein bestimmtes Release).

Starte deine Agent-Clients neu und bitte dann zwei von ihnen, im selben Repository zu arbeiten. Concord gibt ihnen einen gemeinsamen Workspace und macht erreichbare Sessions für direkte Prompts und Antworten verfügbar.

<details>
<summary>Was <code>concord setup</code> ändert</summary>

`concord setup` erstellt den lokalen Workspace `.concord/` und registriert den MCP-Server für Claude, Cursor, Gemini, Grok und Codex (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.grok/config.toml` und `~/.codex/config.toml`). Für [Goose](./docs/goose.md) registriert es die Extension `concord-relay` in Goose' `config.yaml`, sofern Goose erkannt wird. Für [Antigravity](./docs/antigravity.md) schreibt es `.agents/mcp_config.json`, `.agents/hooks.json` und `.agents/rules/concord.md`. Außerdem schreibt es Concords Tool-Anweisungen in deine Client-Konfigurationen (`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`). Bestehende Konfigurationen werden zusammengeführt statt ersetzt, und der Befehl lässt sich gefahrlos erneut ausführen.

Setup erkennt außerdem unterstützte Clients und versucht, deren globale Concord-Adapter jeweils unabhängig voneinander zu installieren. Mit `--no-adapters` überspringst du diesen Schritt; `--require-adapters` ist für verwaltete Installationen gedacht, die bei eingeschränkter Unterstützung fehlschlagen sollen. Mit `--no-mcp` werden nur der Workspace und die Anweisungen geschrieben, und du verwaltest die MCP-Registrierung selbst.

Ist der globale Modus aktiv (siehe unten), lässt Setup die Anweisungs- und MCP-Dateien des Repositorys unangetastet, weil die Registrierungen auf Benutzerebene sie bereits abdecken. Mit `--repo-files` werden sie trotzdem geschrieben, etwa um sie für ein Team einzuchecken.

</details>

<details>
<summary>Concord in Repositorys nutzen, die du nicht eingerichtet hast</summary>

Wenn du `concord setup` zum ersten Mal interaktiv ausführst, fragt es, ob deine Agents Concord auch in Repositorys nutzen sollen, in denen Setup nie gelaufen ist (Standard: ja). Deine Antwort wird in `~/.concord/config.json` gespeichert; mit `concord setup --global` oder `--no-global` änderst du sie.

Im globalen Modus registriert sich Concord für jeden installierten Agent auf Benutzerebene und ergänzt dessen Anweisungsdateien auf Benutzerebene um einen kurzen Concord-Abschnitt (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, Goose' `.goosehints`, `~/.copilot/copilot-instructions.md`; Cursor erhält ihn über seinen globalen Session-Hook). In diese Repositorys wird nichts geschrieben: Ihre Arbeit liegt in `~/.concord/global.db`, ein Projekt pro Repository, benannt nach dem Git-Remote, so wie Concord Cloud es benennt. Sessions außerhalb eines Repositorys teilen sich das Projekt `general`. Ein Repository, das du eingerichtet hast, behält alles in seinem eigenen `.concord/`; `concord setup` schreibt dort bei aktivem globalem Modus keine Anweisungs- oder MCP-Dateien, sofern du nicht `--repo-files` übergibst. Beim Deaktivieren des globalen Modus wird genau das entfernt, was er hinzugefügt hat.

</details>

<details>
<summary>Concord Cloud: Agents auf verschiedenen Rechnern</summary>

`concord cloud login` meldet diesen Rechner bei Concord Cloud an und verknüpft ihn. Ein verknüpfter Rechner arbeitet in jedem Ordner über die Cloud, sodass seine Agents Agents auf jedem anderen Rechner erreichen. Solange der Rechner verknüpft ist, behält kein Repository lokalen Zustand; ein Repository mit Git-Remote gehört zum Projekt dieses Remotes, eines ohne Remote ist ein eigenes Projekt auf diesem Rechner, und alles außerhalb eines Repositorys gehört zu `general`.

`concord cloud unlink` schaltet den gesamten Rechner zurück auf lokales Concord und behält die Anmeldung bei; `concord cloud link` schaltet ihn wieder auf die Cloud um. `concord cloud status` zeigt, was gerade gilt. `concord doctor` prüft die Verknüpfung und listet lokalen Zustand auf, den der Rechner nicht mehr nutzt, samt den Befehlen, um ihn beiseitezuräumen, sobald keine vor der Verknüpfung gestartete Session mehr läuft (gelöscht wird nichts).

</details>

## Unterstützte Agents

| Agent                                | Integrationsleitfaden                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| Claude Code                          | [Einrichtung und Zustellung](./docs/claude-code.md)        |
| Codex                                | [Einrichtung und Zustellung](./docs/codex.md)              |
| Cursor                               | [Einrichtung und Zustellung](./docs/cursor.md)             |
| Gemini CLI                           | [Einrichtung und Zustellung](./docs/gemini-cli.md)         |
| Grok Build                           | [Einrichtung und Zustellung](./docs/grok-build.md)         |
| Goose                                | [Einrichtung und Zustellung](./docs/goose.md)              |
| Google Antigravity                   | [Einrichtung und Zustellung](./docs/antigravity.md)        |
| GitHub Copilot CLI                   | [Einrichtung und Zustellung](./docs/github-copilot-cli.md) |
| OpenCode                             | [Einrichtung und Zustellung](./docs/opencode.md)           |
| Devin CLI                            | Einrichtung auf Projektebene über `concord setup`          |
| Conductor (Claude Code, Codex)       | [Einrichtung und Zustellung](./docs/conductor.md)          |
| Jeder andere MCP-fähige Coding-Agent | [Manuelle Einrichtung](./docs/other-mcp-clients.md)        |

> Es gibt keinen universellen Slash-Befehl `/concord` – Befehle sind clientspezifisch. Concord funktioniert auf jedem MCP-fähigen Client über MCP-Tools und die installierten Anweisungen.

Die Live-Zustellung hängt vom empfangenden Harness und vom Zustand der Session ab. Mit `concord adapters status` siehst du, welche installierten Agents erreichbar sind und wie Nachrichten zugestellt werden.

## Kommunikation ist erst der Anfang

Nachrichten bringen Agents ins Gespräch. Concords gemeinsamer Arbeitsstand sorgt dafür, dass die daraus entstehende Zusammenarbeit auch nach der Zustellung verlässlich bleibt.

| Ohne Concord                                                   | Mit Concord                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Agents können Peers in einem anderen Harness nicht erreichen   | Agents senden über unterstützte Clients hinweg direkte, beantwortbare Prompts |
| Agents entdecken Kollisionen erst nach dem Editieren           | Agents claimen Dateien und Module, bevor die Arbeit beginnt                   |
| Kontext verschwindet, wenn eine Session endet                  | Entscheidungen, Annahmen und Erkenntnisse bleiben an der Aufgabe hängen       |
| Ownership ergibt sich nur implizit aus dem Chatverlauf         | Zuweisungen und Handoffs sind explizit und werden bestätigt                   |
| Menschen rekonstruieren den Fortschritt aus Branches und Diffs | Review-Pakete kommen mit Scope, Tests, Risiken und Herkunftsnachweisen        |

Concord ist kein weiterer autonomer Agent oder Orchestrator. Es ist die gemeinsame Schicht rund um deine Agents: Präsenz, Nachrichten, Aufgabengedächtnis, Ownership, Handoffs und Review-Status über einen einzigen kleinen MCP-Server.

## Die Tools

| Tool            | Zweck                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `start_work`    | registriert die Präsenz, claimt oder akzeptiert eine Aufgabe und meldet Scope-Überschneidungen vor dem Editieren                        |
| `inspect_work`  | liest den Workspace-/Aufgabenstatus, die Inbox/Outbox eines Agents oder einen dauerhaften Prompt-/Antwort-Thread                        |
| `update_work`   | hält Aufgabenkontext fest oder sendet sofort einen Prompt bzw. eine Antwort an einen anderen per Prompt erreichbaren Agent im Workspace |
| `transfer_work` | weist zu, akzeptiert, lehnt ab, gibt frei, weist neu zu, bietet Handoffs an oder öffnet versionierte Arbeit erneut                      |
| `finish_work`   | hält Nachweise fest und markiert eine Aufgabe optional als review-bereit, abgeschlossen oder geschlossen                                |

Schreibvorgänge akzeptieren eine `agent_id`, sodass die Präsenz allein durch das Arbeiten aktiv bleibt. `inspect_work` zeigt, **wer da ist**, und markiert **verwaiste Claims** – aktive Claims, deren Agent verschwunden ist, ohne einen Handoff zu hinterlassen.

Für die Live-Kommunikation zwischen Agents führst du `concord setup` aus und startest bestehende Client-Sessions einmal neu. Ein Prompt verwendet `update_work` mit `operation: "prompt"`, der Ziel-`to_agent_id`, dem Inhalt und einem `idempotency_key`; eine Antwort verwendet `operation: "reply"` und `reply_to_message_id`. Ein Adapter mit Empfangsbestätigung lenkt einen laufenden Turn um oder startet einen Turn in einer untätigen Session. Integrationen, die nur Hooks nutzen, hinterlassen eine dauerhafte Pull-Nachricht und weisen im Ergebnis auf diese Einschränkung hin. Hat der genannte Agent keinen erreichbaren Endpunkt, schlägt die Zustellung sofort fehl; Concord leitet sie nicht stillschweigend um.

`concord adapters status` berichtet für jeden Harness einzeln, einschließlich Monitor-/Controller-Art, verifizierter Erreichbarkeit, erforderlicher Aktion und Ergebnis der Versionsprüfung. `concord adapters install`, `doctor` und `uninstall` bieten denselben globalen Lebenszyklus außerhalb des Repository-Setups.

Concord ermittelt den Repository-Workspace automatisch. Operationen geben dessen `workspace_id` und das Repository-Root zurück, damit ein Client fehlgeleitete Aufrufe erkennen kann; die ID lässt sich explizit übergeben, wenn ein Server mehrere Roots koordiniert.

Operationen, die den Lebenszyklus ändern, verwenden die monoton steigende `version` der Aufgabe als `expected_version`. Handeln zwei Agents auf derselben Version, gelingt nur der erste Übergang. Eine Zuweisung lässt die Arbeit in `assigned`, bis der genannte Agent `transfer_work` mit `action: "accept"` aufruft; ebenso bleibt bei einem Handoff-Angebot die Ownership beim Absender, bis der Empfänger annimmt. Jeder Ownership-Wechsel wird in einer Append-only-Audit-Historie festgehalten.

## Was du bekommst

SQLite ist die lokale Source of Truth und liegt in `.concord/` im **Root des Repositorys**, in dem gearbeitet wird. Der MCP-Server ermittelt dieses Root aus `CONCORD_REPO_ROOT`, falls gesetzt, dann aus Claude Codes `CLAUDE_PROJECT_DIR` (das Claude Code automatisch setzt, auch für einen Server auf Benutzerebene) und schließlich aus seinem Arbeitsverzeichnis – so teilen sich alle Agents in einem Repository einen Speicher. Setze `CONCORD_REPO_ROOT`, wenn der Server an einem Ort läuft, an dem sein Arbeitsverzeichnis nicht im Repository liegt.

Verknüpfte Git-Worktrees folgen Gits `commondir`-Metadaten zum primären Checkout, sodass sich der Haupt-Checkout und alle verknüpften Worktrees bewusst eine Concord-Datenbank und eine Workspace-ID teilen.

Um die explizite Workspace-Auswahl einzuschränken, setze `CONCORD_ALLOWED_ROOTS` auf eine durch das Pfadtrennzeichen getrennte Liste erlaubter Repository-Roots. Ohne Allowlist müssen decodierte Roots trotzdem existieren und Verzeichnisse sein.

`concord setup` schreibt eine `.concord/.gitignore` mit dem Inhalt `*`, sodass sich der generierte Workspace selbst ignoriert und lokal bleibt, ohne dass die gemeinsame `.gitignore` des Repositorys geändert werden muss. Teams, die ausgewählte Artefakte in PRs haben möchten, können dieser Datei Negationsregeln hinzufügen (Setup behält bestehende Regeln bei und stellt nur das Catch-all `*` sicher) oder die menschenlesbaren Dateien per Force-Add hinzufügen. Repositorys, die mit Concord 0.10.5 oder älter eingerichtet wurden, haben außerdem eine `.concord/`-Regel in der `.gitignore` im Root; entferne sie, damit Negationen in `.concord/.gitignore` greifen.

```text
.concord/
├── .gitignore          ignoriert das gesamte Verzeichnis
├── concord.db          lokale Source of Truth
├── HANDOFF.md          menschenlesbarer Handoff
├── REVIEW_PACKET.md    Nachweise für das Review
├── events.jsonl        chronologische Tool-Events, ein JSON-Objekt pro Zeile
└── WORK_STATE.json     generierter Export des Arbeitsstands
```

## CLI

Concord unterstützt sowohl typisierte MCP-Tools als auch eine reguläre CLI. MCP-fähige Agents können die Tools direkt aufrufen; Menschen und CLI-orientierte Agents arbeiten über `concord`-Befehle mit demselben gemeinsamen Workspace.

```bash
concord setup                # lokalen Zustand, Anweisungen und MCP-Clients einrichten
concord status               # Agent-Liste, aktive Arbeit, Überschneidungen, verwaiste Claims, review-bereit
concord dashboard            # tastaturgesteuerte Live-Ansicht von Agents, Aufgaben, Warnungen und Aktivität
concord who                  # welche Agents anwesend sind und woran sie arbeiten
concord tasks                # alle erfassten Aufgaben auflisten
concord handoff <task-id>    # den neuesten Handoff ausgeben
concord review-packet <id>   # das neueste Review-Paket ausgeben
concord export markdown      # .concord/-Artefakte neu generieren
concord check <files...>     # exakte Dateiüberschneidungen mit aktiven Aufgaben prüfen (für Hooks/CI)
concord watch                # Arbeitsstand bei jeder Änderung an .concord ausgeben (Ctrl-C zum Beenden)
concord doctor               # Workspace-Prüfungen + Tool-Nutzung pro Aufgabe
concord adapters status      # globale Matrix der Zustellfähigkeiten aller Harnesses

concord --repo ../project status        # von überall per Repository-Pfad auswählen
concord --workspace ws_... status       # eine von einer Concord-Operation zurückgegebene ID auswählen
```

Um konfliktträchtige Änderungen in einem Pre-Commit-Hook oder in CI zu blockieren, führe `concord check src/file.ts` aus (oder `concord check --task <id> src/file.ts`, um deine eigene Aufgabe auszuschließen). Der Befehl endet mit Status `1`, wenn eine aktive Aufgabe dieselbe Datei claimt, und mit `0`, wenn es keine Überschneidung gibt. PreToolUse-Hooks von Claude Code werten Exit-Code `2` als Ablehnung, verwende in diesem Hook also `concord check src/file.ts || exit 2`.

`--repo` und `--workspace` sind globale, sich gegenseitig ausschließende Optionen. Die CLI verwendet dieselbe Priorität `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → Arbeitsverzeichnis und dieselbe Kanonisierung verknüpfter Worktrees wie MCP.

`concord dashboard` ist eine schreibgeschützte, lokale Vollbild-TUI. Sie aktualisiert sich jede Sekunde aus dem gemeinsamen SQLite-Workspace und hält Agents, Aufgaben, Warnungen, Kontext und Timeline in einem festen Terminal-Viewport. Mit `Tab` wechselst du zwischen den Bereichen, mit `j`/`k` oder den Pfeiltasten wählst du Arbeit aus, mit `/` filterst du, `?` zeigt die Hilfe, und `q` beendet das Dashboard.

## Upgrade

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

Führe den `curl … | sh`-Installer erneut aus, um eine eigenständige Installation zu aktualisieren.

Concord prüft täglich auf Updates und zeigt verfügbare Updates in der CLI, den MCP-Tools und dem Dashboard an; `concord setup` kann nach Bestätigung ein Update installieren (mit npm oder dem Installer, je nachdem, was du verwendet hast), und `CONCORD_NO_UPDATE_CHECK=1` deaktiviert die Prüfungen.

## Was das ist / was nicht

Gemeinsamer Arbeitsstand und Aufgabengedächtnis für Coding-Agents, die denselben lokalen Checkout verwenden. **Kein** Orchestrator, Code-Reviewer, gehosteter Sync-Dienst, Memory-Vektordatenbank oder autonomer Coding-Agent.

Siehe auch: [Warum nicht einfach Markdown?](./docs/why-not-markdown.md)

## Mitwirken

Siehe [`CONTRIBUTING.md`](./CONTRIBUTING.md) und [`CLAUDE.md`](./CLAUDE.md). Dieses Repository ist strikt typisiert (kein `any`, keine Typecasts) und modular aufgebaut. Gute Einstiegsaufgaben tragen das Label [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Star-Verlauf

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star-Verlauf-Diagramm" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## Datenschutz & Telemetrie

Concord sendet Produkt- und Koordinations-Telemetrie an `getconcord.ai`. Sie umfasst zufällige Installations-/Aufruf-IDs; irreversible, installationsspezifische Pseudonyme für Workspaces und Aufgabenabläufe; Concord-, Node- und Plattformversionen; normalisierte Client-Metadaten; Namen, Ergebnisse und Dauer von Operationen; aggregierte Ergebnisse von Überschneidungs- und Edit-Guard-Prüfungen; Zustellstufen und Latenzen von Nachrichten; Übergänge im Aufgabenlebenszyklus und die verstrichene Zeit; sowie explizit gemeldete Ergebnisse zu Abnahme, Integration, menschlichem Eingreifen und Nacharbeit.

Concord sendet niemals Code, rohe Datei- oder Repository-Pfade, Remotes, Benutzernamen, rohe Aufgaben- oder Agent-IDs, Nachrichten-IDs oder -Inhalte, Befehlsargumente, Tool-Ein-/Ausgaben oder Aufgabeninhalte. Der empfangende Server speichert die IP-Adresse der Anfrage und leitet daraus einen Ländercode ab, den er ebenfalls speichert. Für diese serverseitigen Felder gibt es derzeit keine automatische Löschfrist. Setze `CONCORD_TELEMETRY_DISABLED=1` (oder `DO_NOT_TRACK=1`), um die Telemetrie zu deaktivieren. Die Übermittlung erfolgt nach dem Best-Effort-Prinzip und kann niemals dazu führen, dass eine Concord-Operation fehlschlägt.

## Lizenz

[MIT](./LICENSE)
