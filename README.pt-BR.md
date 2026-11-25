<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP — estado de trabalho compartilhado para agentes de programação" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Faça o Claude Code, o Codex, o Cursor, o Gemini CLI, o Grok Build, o Goose, o GitHub Copilot CLI e o OpenCode conversarem entre si.</strong></p>

<p align="center">
  A camada de comunicação e coordenação open source e local-first para agentes de programação com IA.
  Envie mensagens em tempo real entre harnesses, detecte sobreposições de trabalho antes que os agentes editem,
  compartilhe decisões e repasse tarefas com evidências — tudo por meio de um único servidor MCP.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="versão no npm"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="downloads no npm"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="versão do Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="Licença MIT"></a>
</p>

<p align="center">
  <a href="#veja-em-ação">Demonstração</a> ·
  <a href="#início-rápido">Início rápido</a> ·
  <a href="#agentes-compatíveis">Agentes compatíveis</a> ·
  <a href="https://getconcord.ai">Site</a> ·
  <a href="./CONTRIBUTING.md">Como contribuir</a>
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

## Veja em ação

Dois agentes em harnesses diferentes conseguem se descobrir, trocar mensagens e dividir o trabalho sem que um humano precise repassar o contexto entre eles:

```text
Claude Code → Concord   Reservar src/app/page.tsx
Codex       → Concord   Reservar src/app/page.tsx
Concord     → Codex     Sobreposição: Claude Code já é dono deste arquivo
Codex       → Claude    Então fico com src/app/api. Pode ser?
Claude      → Codex     Sim. Fico com a página e uso o seu contrato de API.
```

Execute a [demonstração real de Claude Code ↔ Codex](./examples/whack-a-mole/) para ver os dois agentes resolverem uma sobreposição de reservas por meio de prompt e resposta em tempo real, criarem um app jogável, transferirem a posse do trabalho e entregarem o resultado a um revisor independente.

## Início rápido

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Não tem Node.js? No macOS ou no Linux, instale uma versão independente:

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

Ela inclui o próprio runtime do Node em `~/.concord/standalone` e coloca os inicializadores `concord` e `concord-mcp` em `~/.local/bin` (altere com `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR`; fixe uma versão com `CONCORD_VERSION`).

Reinicie seus clientes de agente e peça a dois deles que trabalhem no mesmo repositório. O Concord oferece a eles um workspace compartilhado e deixa as sessões alcançáveis disponíveis para prompts e respostas diretos.

<details>
<summary>O que o <code>concord setup</code> altera</summary>

O `concord setup` cria o workspace local `.concord/` e registra o servidor MCP para Claude, Cursor, Gemini, Grok e Codex (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.grok/config.toml` e `~/.codex/config.toml`). Para o [Goose](./docs/goose.md), ele registra a extensão `concord-relay` no `config.yaml` do Goose, quando detectado. Para o [Antigravity](./docs/antigravity.md), ele grava `.agents/mcp_config.json`, `.agents/hooks.json` e `.agents/rules/concord.md`. Ele também grava as instruções das ferramentas do Concord nas configurações dos seus clientes (`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`). Ele mescla com a configuração existente em vez de substituí-la, e pode ser executado novamente com segurança.

O setup também detecta os clientes compatíveis e tenta instalar os adaptadores globais do Concord de cada um, de forma independente. Use `--no-adapters` para pular essa etapa ou `--require-adapters` em instalações gerenciadas que devem falhar quando o suporte estiver degradado. Passe `--no-mcp` para gravar apenas o workspace e as instruções, gerenciando o registro do MCP por conta própria.

Com o modo global ativado (veja abaixo), o setup não mexe nos arquivos de instruções e de MCP do repositório, porque os registros no nível do usuário já os cobrem; passe `--repo-files` para gravá-los mesmo assim, por exemplo, para versioná-los para a equipe.

</details>

<details>
<summary>Usando o Concord em repositórios que você não configurou</summary>

Na primeira vez que você executa `concord setup` de forma interativa, ele pergunta se seus agentes devem usar o Concord em repositórios nos quais o setup nunca foi executado (o padrão é sim). Sua resposta fica salva em `~/.concord/config.json`; `concord setup --global` ou `--no-global` a altera.

Com o modo global ativado, o Concord se registra no nível do usuário para cada agente instalado e adiciona uma seção curta sobre o Concord aos arquivos de instruções do usuário (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, o `.goosehints` do Goose, `~/.copilot/copilot-instructions.md`; o Cursor a recebe pelo hook global de sessão). Nada é gravado nesses repositórios: o trabalho deles fica em `~/.concord/global.db`, com um projeto por repositório, nomeado a partir do git remote da mesma forma que no Concord Cloud. Sessões fora de qualquer repositório compartilham o projeto `general`. Um repositório que você configurou mantém tudo no próprio `.concord/`; com o modo global ativado, `concord setup` nele não grava arquivos de instruções nem de MCP, a menos que você passe `--repo-files`. Desativar o modo global remove exatamente o que ele adicionou.

</details>

<details>
<summary>Concord Cloud: agentes em máquinas diferentes</summary>

`concord cloud login` faz o login desta máquina no Concord Cloud e a vincula. Uma máquina vinculada trabalha pela nuvem em todas as pastas, de modo que seus agentes alcançam agentes em qualquer máquina. Nenhum repositório mantém estado local enquanto a máquina estiver vinculada; um repositório com git remote é o projeto desse remote, um repositório sem remote é um projeto próprio nesta máquina, e tudo o que estiver fora de um repositório fica em `general`.

`concord cloud unlink` faz a máquina inteira voltar ao Concord local, mantendo o login, e `concord cloud link` a vincula novamente. `concord cloud status` informa qual modo está em uso, e `concord doctor` verifica o vínculo e lista o estado local que a máquina não usa mais, com os comandos para movê-lo para outro lugar quando não houver mais nenhuma sessão iniciada antes do vínculo em execução (nada é excluído).

</details>

## Agentes compatíveis

| Agente                                                  | Guia de integração                                     |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code                                             | [Configuração e entrega](./docs/claude-code.md)        |
| Codex                                                   | [Configuração e entrega](./docs/codex.md)              |
| Cursor                                                  | [Configuração e entrega](./docs/cursor.md)             |
| Gemini CLI                                              | [Configuração e entrega](./docs/gemini-cli.md)         |
| Grok Build                                              | [Configuração e entrega](./docs/grok-build.md)         |
| Goose                                                   | [Configuração e entrega](./docs/goose.md)              |
| Google Antigravity                                      | [Configuração e entrega](./docs/antigravity.md)        |
| GitHub Copilot CLI                                      | [Configuração e entrega](./docs/github-copilot-cli.md) |
| OpenCode                                                | [Configuração e entrega](./docs/opencode.md)           |
| Devin CLI                                               | Configuração no nível do projeto com `concord setup`   |
| Conductor (Claude Code, Codex)                          | [Configuração e entrega](./docs/conductor.md)          |
| Qualquer outro agente de programação compatível com MCP | [Configuração manual](./docs/other-mcp-clients.md)     |

> Não existe um comando de barra `/concord` universal — os comandos variam de cliente para cliente. O Concord funciona por meio de ferramentas MCP e das instruções instaladas em qualquer cliente compatível com MCP.

A entrega em tempo real depende do harness de destino e do estado da sessão. Execute `concord adapters status` para ver quais agentes instalados estão alcançáveis e como as mensagens serão entregues.

## A comunicação é o ponto de partida

As mensagens colocam os agentes para conversar. O estado de trabalho compartilhado do Concord mantém a colaboração confiável depois que a mensagem é entregue.

| Sem o Concord                                                | Com o Concord                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Agentes não conseguem contatar colegas em outro harness      | Agentes enviam prompts diretos, que aceitam resposta, entre os clientes compatíveis |
| Agentes descobrem colisões depois de editar                  | Agentes reservam arquivos e módulos antes de começar o trabalho                     |
| O contexto desaparece quando uma sessão termina              | Decisões, premissas e descobertas ficam vinculadas à tarefa                         |
| A posse fica implícita no histórico do chat                  | Atribuições e repasses são explícitos e confirmados                                 |
| Humanos reconstroem o progresso a partir de branches e diffs | Pacotes de revisão chegam com escopo, testes, riscos e procedência                  |

O Concord não é mais um agente autônomo nem um orquestrador. Ele é a camada compartilhada em torno dos seus agentes: presença, mensagens, memória de tarefas, posse, repasses e estado de revisão por meio de um único e pequeno servidor MCP.

## As ferramentas

| Ferramenta      | Finalidade                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `start_work`    | registra a presença, reserva ou aceita uma tarefa e informa sobreposições de escopo antes da edição                      |
| `inspect_work`  | lê o estado do workspace/da tarefa, a caixa de entrada/saída de um agente ou uma conversa persistente de prompt/resposta |
| `update_work`   | registra o contexto da tarefa ou envia imediatamente um prompt/resposta a outro agente do workspace que aceita prompts   |
| `transfer_work` | atribui, aceita, recusa, libera, reatribui, oferece repasses ou reabre trabalho versionado                               |
| `finish_work`   | registra evidências e, opcionalmente, marca uma tarefa como pronta para revisão, concluída ou encerrada                  |

As operações de escrita aceitam um `agent_id`, o que mantém a presença ativa pelo simples fato de trabalhar. `inspect_work` mostra **quem está aqui** e sinaliza **reservas obsoletas** — uma reserva ativa cujo agente dono foi embora sem fazer o repasse.

Para ter comunicação em tempo real entre agentes, execute `concord setup` e reinicie uma vez as sessões de cliente existentes. Um prompt usa `update_work` com `operation: "prompt"`, o `to_agent_id` de destino, o conteúdo e uma `idempotency_key`; uma resposta usa `operation: "reply"` e `reply_to_message_id`. Um adaptador com confirmação de recebimento redireciona um turno em andamento ou inicia um turno quando a sessão está ociosa. Integrações que usam apenas hooks deixam uma mensagem persistente para consulta (pull) e informam essa limitação no resultado. A entrega falha imediatamente quando o agente indicado não tem um endpoint alcançável; o Concord não a redireciona silenciosamente.

`concord adapters status` informa cada harness separadamente, incluindo o tipo de monitor/controlador, a alcançabilidade verificada, a ação necessária e o resultado da verificação de versão. `concord adapters install`, `doctor` e `uninstall` oferecem o mesmo ciclo de vida global fora da configuração do repositório.

O Concord resolve o workspace do repositório automaticamente. As operações retornam o `workspace_id` e a raiz do repositório para que o cliente possa detectar uma chamada mal direcionada; o id pode ser passado explicitamente quando um servidor coordena várias raízes.

Operações que alteram o ciclo de vida usam o `version` monotônico da tarefa como `expected_version`. Se dois agentes atuarem sobre a mesma versão, apenas a primeira transição terá sucesso. A atribuição mantém o trabalho em `assigned` até que o agente indicado use `transfer_work` com `action: "accept"`; da mesma forma, uma oferta de repasse mantém a posse com o remetente até que o destinatário aceite. Toda mudança de posse fica registrada em um histórico de auditoria append-only.

## O que você recebe

O SQLite é a fonte da verdade local, mantida em `.concord/` na **raiz do repositório** em que o trabalho está acontecendo. O servidor MCP resolve essa raiz a partir de `CONCORD_REPO_ROOT`, se definida, depois de `CLAUDE_PROJECT_DIR` do Claude Code (que o Claude Code define automaticamente, mesmo para um servidor no escopo do usuário) e, por fim, do seu diretório de trabalho — assim, todos os agentes de um repositório compartilham o mesmo armazenamento. Defina `CONCORD_REPO_ROOT` ao executar o servidor em um local cujo diretório de trabalho não esteja dentro do repositório.

Worktrees do Git vinculadas seguem os metadados `commondir` do Git até o checkout principal, de modo que o checkout principal e todas as worktrees vinculadas compartilham intencionalmente um único banco de dados e id de workspace do Concord.

Para restringir a seleção explícita de workspace, defina `CONCORD_ALLOWED_ROOTS` como uma lista de raízes de repositório permitidas, separadas pelo delimitador de caminhos do sistema. Sem uma lista de permissões, as raízes decodificadas ainda precisam existir e ser diretórios.

O `concord setup` grava um `.concord/.gitignore` contendo `*`, de modo que o workspace gerado ignora a si mesmo e permanece local sem editar o `.gitignore` compartilhado do repositório. Equipes que queiram incluir determinados artefatos em PRs podem adicionar regras de negação a esse arquivo (o setup mantém as regras existentes, garantindo apenas o curinga `*`) ou forçar a adição dos arquivos legíveis por humanos. Repositórios configurados pelo Concord 0.10.5 ou anterior também têm uma regra `.concord/` no `.gitignore` da raiz; remova-a para que as negações em `.concord/.gitignore` tenham efeito.

```text
.concord/
├── .gitignore          ignora o diretório inteiro
├── concord.db          fonte da verdade local
├── HANDOFF.md          repasse legível por humanos
├── REVIEW_PACKET.md    evidências prontas para revisão
├── events.jsonl        eventos das ferramentas em ordem cronológica, um objeto JSON por linha
└── WORK_STATE.json     exportação gerada do estado de trabalho
```

## CLI

O Concord oferece tanto ferramentas MCP tipadas quanto uma CLI comum. Agentes compatíveis com MCP podem chamar as ferramentas diretamente; humanos e agentes orientados a CLI podem trabalhar no mesmo workspace compartilhado por meio dos comandos `concord`.

```bash
concord setup                # configura o estado local, as instruções e os clientes MCP
concord status               # lista de agentes, trabalho ativo, sobreposições, reservas obsoletas, itens prontos para revisão
concord dashboard            # visão em tempo real, navegável pelo teclado, de agentes, tarefas, alertas e atividade
concord who                  # quais agentes estão presentes e no que estão trabalhando
concord tasks                # lista todas as tarefas rastreadas
concord handoff <task-id>    # imprime o repasse mais recente
concord review-packet <id>   # imprime o pacote de revisão mais recente
concord export markdown      # regenera os artefatos de .concord/
concord check <files...>     # verifica sobreposições exatas de arquivos com tarefas ativas (para hooks/CI)
concord watch                # imprime o estado de trabalho sempre que .concord muda (Ctrl-C para parar)
concord doctor               # verificações do workspace + adoção das ferramentas por tarefa
concord adapters status      # matriz global de capacidades de entrega dos harnesses

concord --repo ../project status        # seleciona pelo caminho do repositório, de qualquer lugar
concord --workspace ws_... status       # seleciona um id retornado por uma operação do Concord
```

Para bloquear edições conflitantes em um hook de pre-commit ou na CI, execute `concord check src/file.ts` (ou `concord check --task <id> src/file.ts` para excluir sua própria tarefa). O comando termina com status `1` quando uma tarefa ativa reserva o mesmo arquivo e `0` quando não há sobreposição. Os hooks PreToolUse do Claude Code tratam o código de saída `2` como negação, portanto use `concord check src/file.ts || exit 2` nesse hook.

`--repo` e `--workspace` são opções globais mutuamente exclusivas. A CLI usa a mesma prioridade `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → diretório de trabalho e a mesma canonicalização de worktrees vinculadas que o MCP.

`concord dashboard` é uma TUI local somente leitura em tela cheia. Ela é atualizada a cada segundo a partir do workspace SQLite compartilhado, mantendo agentes, tarefas, alertas, contexto e linha do tempo dentro de uma área fixa do terminal. Use `Tab` para alternar entre painéis, `j`/`k` ou as setas para selecionar o trabalho, `/` para filtrar, `?` para obter ajuda e `q` para sair.

## Atualização

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

Execute novamente o instalador `curl … | sh` para atualizar uma instalação independente.

O Concord verifica atualizações diariamente e as exibe na CLI, nas ferramentas MCP e no dashboard; o `concord setup` pode instalar uma atualização mediante confirmação (com o npm ou o instalador, conforme o que você usou), e `CONCORD_NO_UPDATE_CHECK=1` desativa as verificações.

## O que é / o que não é

Estado de trabalho compartilhado e memória de tarefas para agentes de programação que usam o mesmo checkout local. **Não** é um orquestrador, um revisor de código, um serviço de sincronização hospedado, um banco de dados vetorial de memória nem um agente de programação autônomo.

Veja também: [Por que não usar apenas markdown?](./docs/why-not-markdown.md)

## Como contribuir

Consulte [`CONTRIBUTING.md`](./CONTRIBUTING.md) e [`CLAUDE.md`](./CLAUDE.md). Este repositório é estritamente tipado (sem `any`, sem typecasts) e modular. Boas issues para começar estão marcadas com [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Histórico de estrelas

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Gráfico do histórico de estrelas" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## Privacidade e telemetria

O Concord envia telemetria de produto e de coordenação para `getconcord.ai`. Ela inclui identificadores aleatórios de instalação/invocação; pseudônimos irreversíveis, por instalação, de workspace e de fluxo de tarefas; versões do Concord, do Node e da plataforma; metadados normalizados do cliente; nomes, resultados e durações de operações; resultados agregados de sobreposição e de proteção de edição; etapas e latências de entrega de mensagens; transições do ciclo de vida das tarefas e tempo decorrido; e resultados informados explicitamente sobre aceitação, integração, intervenção humana e retrabalho.

O Concord nunca envia código, caminhos brutos de arquivos ou repositórios, remotes, nomes de usuário, identificadores brutos de tarefas ou agentes, identificadores ou conteúdo de mensagens, argumentos de comandos, entradas/saídas de ferramentas ou conteúdo de tarefas. O servidor receptor armazena o endereço IP da requisição e deriva e armazena um código de país. Atualmente, esses campos do lado do servidor não têm expiração automática. Defina `CONCORD_TELEMETRY_DISABLED=1` (ou `DO_NOT_TRACK=1`) para desativar a telemetria. A entrega é feita no modelo de melhor esforço e nunca faz uma operação do Concord falhar.

## Licença

[MIT](./LICENSE)
