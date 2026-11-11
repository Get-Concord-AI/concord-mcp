<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP: estado de trabajo compartido para agentes de programación" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Haz que Claude Code, Codex, Cursor, Gemini CLI, Grok Build, Goose, GitHub Copilot CLI y OpenCode hablen entre sí.</strong></p>

<p align="center">
  La capa de comunicación y coordinación de código abierto y local-first para agentes de programación con IA.
  Envía mensajes en vivo entre entornos distintos, detecta el trabajo solapado antes de que los agentes editen,
  comparte decisiones y traspasa tareas con evidencia, todo a través de un único servidor MCP.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="versión de npm"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="descargas de npm"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="versión de Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="Licencia MIT"></a>
</p>

<p align="center">
  <a href="#míralo-en-acción">Demo</a> ·
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#agentes-compatibles">Agentes compatibles</a> ·
  <a href="https://getconcord.ai">Sitio web</a> ·
  <a href="./CONTRIBUTING.md">Contribuir</a>
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

## Míralo en acción

Dos agentes en entornos distintos pueden descubrirse, intercambiar mensajes y repartirse el trabajo sin que una persona tenga que transmitir el contexto entre ellos:

```text
Claude Code → Concord   Reservar src/app/page.tsx
Codex       → Concord   Reservar src/app/page.tsx
Concord     → Codex     Solapamiento: Claude Code ya es propietario de este archivo
Codex       → Claude    Entonces me encargo de src/app/api. ¿Te parece bien?
Claude      → Codex     Sí. Me quedo con la página y uso tu contrato de API.
```

Ejecuta la [demo real de Claude Code ↔ Codex](./examples/whack-a-mole/) para ver cómo ambos agentes resuelven una reserva solapada mediante un intercambio en vivo de prompt y respuesta, construyen una aplicación jugable, transfieren la propiedad y entregan el resultado a un revisor independiente.

## Inicio rápido

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

¿No tienes Node.js? En macOS o Linux, instala en su lugar una compilación autónoma:

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

Incluye su propio entorno de ejecución de Node en `~/.concord/standalone` y coloca los lanzadores `concord` y `concord-mcp` en `~/.local/bin` (puedes cambiar las rutas con `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR` y fijar una versión con `CONCORD_VERSION`).

Reinicia tus clientes de agentes y luego pide a dos de ellos que trabajen en el mismo repositorio. Concord les proporciona un espacio de trabajo compartido y hace que las sesiones accesibles puedan recibir prompts y respuestas directos.

<details>
<summary>Qué cambia <code>concord setup</code></summary>

`concord setup` crea el espacio de trabajo local `.concord/` y registra el servidor MCP para Claude, Cursor, Gemini, Grok y Codex (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.grok/config.toml` y `~/.codex/config.toml`). Para [Goose](./docs/goose.md), registra la extensión `concord-relay` en el `config.yaml` de Goose cuando lo detecta. Para [Antigravity](./docs/antigravity.md), escribe `.agents/mcp_config.json`, `.agents/hooks.json` y `.agents/rules/concord.md`. También escribe las instrucciones de las herramientas de Concord en las configuraciones de tus clientes (`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`). Combina los cambios con la configuración existente en lugar de reemplazarla, y es seguro volver a ejecutarlo.

`concord setup` también detecta los clientes compatibles e intenta instalar sus adaptadores globales de Concord de forma independiente. Usa `--no-adapters` para omitir ese paso o `--require-adapters` en instalaciones gestionadas que deban fallar si la compatibilidad queda degradada. Pasa `--no-mcp` para escribir solo el espacio de trabajo y las instrucciones, y gestionar tú mismo el registro de MCP.

Con el modo global activado (ver más abajo), `concord setup` no toca los archivos de instrucciones ni los de MCP del repositorio, porque los registros a nivel de usuario ya los cubren; pasa `--repo-files` para escribirlos de todos modos, por ejemplo, para incluirlos en el control de versiones para un equipo.

</details>

<details>
<summary>Usar Concord en repositorios que no has configurado</summary>

La primera vez que ejecutas `concord setup` de forma interactiva, te pregunta si tus agentes deben usar Concord en repositorios donde nunca se ejecutó la configuración (de forma predeterminada, sí). Tu respuesta se guarda en `~/.concord/config.json`; `concord setup --global` o `--no-global` la cambian.

Con el modo global activado, Concord se registra a nivel de usuario para cada agente instalado y añade una breve sección de Concord a sus archivos de instrucciones de usuario (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, el `.goosehints` de Goose, `~/.copilot/copilot-instructions.md`; Cursor la recibe de su hook global de sesión). No se escribe nada en esos repositorios: su trabajo se guarda en `~/.concord/global.db`, con un proyecto por repositorio, nombrado según su git remote igual que en Concord Cloud. Las sesiones fuera de cualquier repositorio comparten el proyecto `general`. Un repositorio que sí configuraste conserva todo en su propio `.concord/`; mientras el modo global esté activado, `concord setup` no escribe allí archivos de instrucciones ni de MCP, a menos que pases `--repo-files`. Al desactivar el modo global se elimina exactamente lo que se añadió.

</details>

<details>
<summary>Concord Cloud: agentes en distintas máquinas</summary>

`concord cloud login` inicia sesión en Concord Cloud desde esta máquina y la vincula. Una máquina vinculada trabaja a través de la nube en todas las carpetas, de modo que sus agentes pueden comunicarse con agentes de cualquier máquina. Ningún repositorio conserva estado local mientras la máquina esté vinculada; un repositorio con git remote corresponde al proyecto de ese remote, uno sin remote es un proyecto propio en esta máquina y todo lo que esté fuera de un repositorio pertenece a `general`.

`concord cloud unlink` devuelve toda la máquina al Concord local sin cerrar la sesión, y `concord cloud link` vuelve a activar la nube. `concord cloud status` indica cuál de los dos modos se aplica, y `concord doctor` comprueba el vínculo y enumera el estado local que la máquina ya no usa, junto con los comandos para apartarlo cuando ya no quede en ejecución ninguna sesión iniciada antes de la vinculación (no se elimina nada).

</details>

## Agentes compatibles

| Agente                                                   | Guía de integración                                        |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Claude Code                                              | [Configuración y entrega](./docs/claude-code.md)           |
| Codex                                                    | [Configuración y entrega](./docs/codex.md)                 |
| Cursor                                                   | [Configuración y entrega](./docs/cursor.md)                |
| Gemini CLI                                               | [Configuración y entrega](./docs/gemini-cli.md)            |
| Grok Build                                               | [Configuración y entrega](./docs/grok-build.md)            |
| Goose                                                    | [Configuración y entrega](./docs/goose.md)                 |
| Google Antigravity                                       | [Configuración y entrega](./docs/antigravity.md)           |
| GitHub Copilot CLI                                       | [Configuración y entrega](./docs/github-copilot-cli.md)    |
| OpenCode                                                 | [Configuración y entrega](./docs/opencode.md)              |
| Devin CLI                                                | Configuración a nivel de proyecto mediante `concord setup` |
| Conductor (Claude Code, Codex)                           | [Configuración y entrega](./docs/conductor.md)             |
| Cualquier otro agente de programación compatible con MCP | [Configuración manual](./docs/other-mcp-clients.md)        |

> No existe un comando de barra `/concord` universal: los comandos dependen de cada cliente. Concord funciona mediante herramientas MCP junto con las instrucciones instaladas en cualquier cliente compatible con MCP.

La entrega en vivo depende del entorno receptor y del estado de la sesión. Ejecuta `concord adapters status` para ver qué agentes instalados son accesibles y cómo se entregarán los mensajes.

## La comunicación es el punto de partida

Los mensajes ponen a los agentes a hablar. El estado de trabajo compartido de Concord mantiene la fiabilidad de la colaboración resultante una vez entregado el mensaje.

| Sin Concord                                                     | Con Concord                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Los agentes no pueden contactar con sus pares en otro entorno   | Los agentes envían prompts directos que admiten respuesta entre clientes compatibles |
| Los agentes descubren las colisiones después de editar          | Los agentes reservan archivos y módulos antes de empezar a trabajar                  |
| El contexto desaparece cuando termina una sesión                | Las decisiones, suposiciones y hallazgos permanecen vinculados a la tarea            |
| La propiedad se deduce del historial del chat                   | Las asignaciones y los traspasos son explícitos y se confirman                       |
| Las personas reconstruyen el progreso a partir de ramas y diffs | Los paquetes de revisión llegan con alcance, pruebas, riesgos y procedencia          |

Concord no es otro agente autónomo ni un orquestador. Es la capa compartida que rodea a tus agentes: presencia, mensajería, memoria de tareas, propiedad, traspasos y estado de revisión a través de un pequeño servidor MCP.

## Las herramientas

| Herramienta     | Propósito                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `start_work`    | registra la presencia, reserva o acepta una tarea e informa de los solapamientos de alcance antes de editar                               |
| `inspect_work`  | lee el estado del espacio de trabajo o de una tarea, la bandeja de entrada/salida de un agente o un hilo duradero de prompts y respuestas |
| `update_work`   | registra el contexto de la tarea o envía de inmediato un prompt o una respuesta a otro agente del espacio de trabajo que admita prompts   |
| `transfer_work` | asigna, acepta, rechaza, libera, reasigna, ofrece traspasos o reabre trabajo versionado                                                   |
| `finish_work`   | registra evidencia y, opcionalmente, marca una tarea como lista para revisión, completada o cerrada                                       |

Las escrituras aceptan un `agent_id`, de modo que la presencia se mantiene activa con solo trabajar. `inspect_work` muestra **quién está aquí** y señala las **reservas obsoletas**: reservas activas cuyo agente propietario se ha ido sin hacer un traspaso.

Para la comunicación en vivo entre agentes, ejecuta `concord setup` y luego reinicia una vez las sesiones de cliente existentes. Un prompt usa `update_work` con `operation: "prompt"`, el `to_agent_id` de destino, el contenido y una `idempotency_key`; una respuesta usa `operation: "reply"` y `reply_to_message_id`. Un adaptador con confirmación de recepción redirige un turno en curso o inicia un turno si el agente está inactivo. Las integraciones que solo usan hooks dejan un mensaje duradero que el destinatario debe recuperar e indican esa limitación en el resultado. La entrega falla de inmediato cuando el agente indicado no tiene ningún endpoint accesible; Concord no la redirige silenciosamente.

`concord adapters status` informa de cada entorno por separado, incluido su tipo de monitor/controlador, la accesibilidad verificada, la acción requerida y el resultado de la comprobación de versión. `concord adapters install`, `doctor` y `uninstall` ofrecen el mismo ciclo de vida global fuera de la configuración del repositorio.

Concord resuelve automáticamente el espacio de trabajo del repositorio. Las operaciones devuelven su `workspace_id` y la raíz del repositorio para que un cliente pueda detectar una llamada mal dirigida; el id se puede pasar explícitamente cuando un servidor coordina varias raíces.

Las operaciones que cambian el ciclo de vida usan la `version` monótona de la tarea como `expected_version`. Si dos agentes actúan sobre la misma versión, solo la primera transición tiene éxito. La asignación deja el trabajo en `assigned` hasta que el agente indicado use `transfer_work` con `action: "accept"`; del mismo modo, una oferta de traspaso mantiene la propiedad en el remitente hasta que el destinatario la acepte. Cada cambio de propiedad se conserva en un historial de auditoría de solo anexado.

## Qué obtienes

SQLite es la fuente de verdad local y se guarda en el directorio `.concord/` de la **raíz del repositorio** donde se realiza el trabajo. El servidor MCP resuelve esa raíz a partir de `CONCORD_REPO_ROOT` si está definida, luego de `CLAUDE_PROJECT_DIR` de Claude Code (que Claude Code define automáticamente, incluso para un servidor a nivel de usuario) y, por último, de su directorio de trabajo, de modo que todos los agentes de un repositorio comparten un mismo almacén. Define `CONCORD_REPO_ROOT` cuando ejecutes el servidor en un lugar cuyo directorio de trabajo no esté dentro del repositorio.

Los worktrees de Git vinculados siguen los metadatos `commondir` de Git hasta el checkout principal, por lo que el checkout principal y todos los worktrees vinculados comparten intencionadamente una misma base de datos de Concord y un mismo id de espacio de trabajo.

Para restringir la selección explícita del espacio de trabajo, define `CONCORD_ALLOWED_ROOTS` como una lista de raíces de repositorio permitidas, separadas por el delimitador de rutas del sistema. Sin una lista de permitidos, las raíces decodificadas deben existir y ser directorios.

`concord setup` escribe un `.concord/.gitignore` que contiene `*`, de modo que el espacio de trabajo generado se ignora a sí mismo y permanece local sin editar el `.gitignore` compartido del repositorio. Los equipos que quieran incluir determinados artefactos en los PR pueden añadir reglas de negación a ese archivo (`concord setup` conserva las reglas existentes y solo se asegura de que esté el comodín `*`) o forzar la adición de los archivos legibles por personas. Los repositorios configurados con Concord 0.10.5 o anterior también tienen una regla `.concord/` en el `.gitignore` de la raíz; elimínala para que las negaciones de `.concord/.gitignore` surtan efecto.

```text
.concord/
├── .gitignore          ignora todo el directorio
├── concord.db          fuente de verdad local
├── HANDOFF.md          traspaso legible por personas
├── REVIEW_PACKET.md    evidencia lista para revisión
├── events.jsonl        eventos de herramientas en orden cronológico, un objeto JSON por línea
└── WORK_STATE.json     exportación generada del estado de trabajo
```

## CLI

Concord admite tanto herramientas MCP tipadas como una CLI convencional. Los agentes compatibles con MCP pueden llamar directamente a las herramientas; las personas y los agentes orientados a la CLI pueden trabajar con el mismo espacio de trabajo compartido mediante los comandos `concord`.

```bash
concord setup                # configura el estado local, las instrucciones y los clientes MCP
concord status               # lista de agentes, trabajo activo, solapamientos, reservas obsoletas, listo para revisión
concord dashboard            # vista en vivo manejada con el teclado de agentes, tareas, alertas y actividad
concord who                  # qué agentes están presentes y en qué están trabajando
concord tasks                # lista todas las tareas registradas
concord handoff <task-id>    # imprime el traspaso más reciente
concord review-packet <id>   # imprime el paquete de revisión más reciente
concord export markdown      # regenera los artefactos de .concord/
concord check <files...>     # comprueba solapamientos exactos de archivos con tareas activas (para hooks/CI)
concord watch                # imprime el estado de trabajo cada vez que cambia .concord (Ctrl-C para detener)
concord doctor               # comprobaciones del espacio de trabajo + adopción de herramientas por tarea
concord adapters status      # matriz global de capacidades de entrega por entorno

concord --repo ../project status        # selecciona por ruta de repositorio desde cualquier lugar
concord --workspace ws_... status       # selecciona un id devuelto por una operación de Concord
```

Para bloquear ediciones conflictivas en un hook de pre-commit o en CI, ejecuta `concord check src/file.ts` (o `concord check --task <id> src/file.ts` para excluir tu propia tarea). El comando termina con el estado `1` cuando una tarea activa tiene reservado el mismo archivo, y con `0` cuando no hay solapamiento. Los hooks PreToolUse de Claude Code tratan el código de salida `2` como una denegación, así que usa `concord check src/file.ts || exit 2` en ese hook.

`--repo` y `--workspace` son opciones globales mutuamente excluyentes. La CLI usa la misma prioridad `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → directorio de trabajo y la misma canonicalización de worktrees vinculados que MCP.

`concord dashboard` es una TUI local de pantalla completa y de solo lectura. Se actualiza cada segundo desde el espacio de trabajo SQLite compartido y mantiene los agentes, las tareas, las alertas, el contexto y la línea de tiempo dentro de una ventana fija de la terminal. Usa `Tab` para cambiar de panel, `j`/`k` o las teclas de flecha para seleccionar trabajo, `/` para filtrar, `?` para ver la ayuda y `q` para salir.

## Actualización

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

Vuelve a ejecutar el instalador `curl … | sh` para actualizar una instalación autónoma.

Concord comprueba a diario si hay actualizaciones y las muestra en la CLI, las herramientas MCP y el dashboard; `concord setup` puede instalar una previa confirmación (con npm o con el instalador, según lo que hayas usado), y `CONCORD_NO_UPDATE_CHECK=1` desactiva las comprobaciones.

## Qué es / qué no es

Estado de trabajo compartido y memoria de tareas para agentes de programación que usan el mismo checkout local. **No** es un orquestador, un revisor de código, un servicio de sincronización alojado, una base de datos vectorial de memoria ni un agente de programación autónomo.

Consulta también: [¿Por qué no usar simplemente markdown?](./docs/why-not-markdown.md)

## Contribuir

Consulta [`CONTRIBUTING.md`](./CONTRIBUTING.md) y [`CLAUDE.md`](./CLAUDE.md). Este repositorio es estrictamente tipado (sin `any` ni conversiones de tipo) y modular. Las issues adecuadas para empezar llevan la etiqueta [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Historial de estrellas

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Gráfico del historial de estrellas" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## Privacidad y telemetría

Concord envía telemetría de producto y de coordinación a `getconcord.ai`. Incluye identificadores aleatorios de instalación e invocación; seudónimos irreversibles por instalación para el espacio de trabajo y el flujo de tareas; versiones de Concord, Node y la plataforma; metadatos normalizados del cliente; nombres, resultados y duraciones de las operaciones; resultados agregados de solapamientos y de la protección de edición; etapas y latencias de entrega de mensajes; transiciones del ciclo de vida de las tareas y tiempo transcurrido; y resultados informados explícitamente sobre aceptación, integración, intervención humana y retrabajo.

Concord nunca envía código, rutas sin procesar de archivos o repositorios, remotes, nombres de usuario, identificadores sin procesar de tareas o agentes, identificadores o contenido de mensajes, argumentos de comandos, entradas o salidas de herramientas ni contenido de tareas. El servidor receptor almacena la dirección IP de la solicitud y deriva y almacena un código de país. Actualmente, esos campos del lado del servidor no tienen caducidad automática. Define `CONCORD_TELEMETRY_DISABLED=1` (o `DO_NOT_TRACK=1`) para desactivar la telemetría. La entrega se realiza con el mejor esfuerzo posible y nunca puede hacer que falle una operación de Concord.

## Licencia

[MIT](./LICENSE)
