# Política de Segurança

## Como o sistema trata os dados

O SOS Roupas guarda **dados pessoais de clientes** (nome, telefone, endereço, medidas, valores e histórico de serviços). Por isso foi desenhado para ser **local primeiro**:

- Não há servidor, conta de usuário, nuvem, analytics ou telemetria.
- Os dados ficam em `%APPDATA%\sos-roupas-app\sos_roupas.db` (SQLite), na máquina do usuário.
- Conexões externas possíveis: (1) fontes do Google, opcionais e sem dados de clientes; (2) link do WhatsApp (`wa.me`) aberto no navegador padrão **apenas quando o usuário clica** no botão. O telefone do cliente faz parte desse link.

## Proteções implementadas

| Proteção | O que faz |
|---|---|
| Content Security Policy (CSP) | Bloqueia scripts externos e qualquer envio de dados para fora da tela do app |
| Navegação e janelas bloqueadas | A tela nunca abre sites nem outras janelas; só mostra o conteúdo local |
| Permissões negadas | Câmera, microfone, localização, notificações etc. são sempre recusados |
| SQL parametrizado | Nenhum dado digitado é concatenado em comandos SQL |
| Texto escapado | Nomes e observações com HTML/JavaScript são exibidos como texto e não executam |
| Validação no processo principal | Totais, sinal, preços, empresas e status (da OS e das peças) são validados fora da tela |
| Restauração de backup segura | O arquivo é escolhido e validado pelo processo principal; a tela não consegue indicar outro caminho. Antes de restaurar, os dados atuais são guardados |
| Backup verificado | O arquivo gerado passa por verificação de integridade (`integrity_check`) |
| `.gitignore` | Evita publicar bancos, backups, exportações de clientes, chaves, logs e instaladores |

## Limitações de segurança conhecidas 

1. **Sem criptografia** do banco e dos backups. Quem tiver acesso ao Windows do usuário ou ao pendrive consegue ler os dados. Use **BitLocker** (inclusive BitLocker To Go no pendrive) e uma conta do Windows com senha.
2. **Sem senha de acesso** dentro do aplicativo.
3. O instalador **não é assinado digitalmente** (o Windows mostra um aviso na primeira execução).

## Como reportar uma vulnerabilidade

Use **Security → Report a vulnerability** neste repositório (relato privado do GitHub). Evite abrir uma *Issue* pública com detalhes de falhas.