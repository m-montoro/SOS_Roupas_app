# Como gerar o instalador do SOS Roupas e instalar 

## 1. Gerar o instalador (no SEU computador, com internet)

**Jeito fácil:** dê dois cliques em `gerar-instalador.bat`.
Quando terminar, abre a pasta `dist` com o arquivo:

    Instalador-SOS-Roupas-1.1.0.exe

**Jeito manual** (terminal dentro da pasta do projeto):

    npm install
    npm run dist

A primeira vez demora alguns minutos (baixa ferramentas de empacotamento).
Para só testar sem gerar o instalador: `npm run pack` (cria `dist\win-unpacked\SOS Roupas.exe`).

## 2. Instalar no computador 

1. Copie `Instalador-SOS-Roupas-1.1.0.exe` para um pendrive.
2. No computador que deseja instalar, dê dois cliques no arquivo. Ele instala sozinho e abre o sistema.
   Cria atalho "SOS Roupas" na Área de Trabalho e no Menu Iniciar.
3. **Não precisa** instalar Node.js, npm nem nada.

Requisitos do computador: **Windows 10 ou 11, 64 bits**.

### Aviso azul do Windows ("O Windows protegeu o computador")
É normal: o instalador não tem assinatura digital paga. Clique em **Mais informações → Executar assim mesmo**.

## 3. Onde ficam os dados
`C:\Users\<usuário>\AppData\Roaming\sos-roupas-app\sos_roupas.db`
Desinstalar o programa NÃO apaga os dados. Use o botão **💾 Fazer backup** no Dashboard com frequência (pendrive).

## 4. Levar os dados do seu computador para outro
No seu: Dashboard → **Fazer backup** (salve no pendrive).
No outro: Dashboard → **Restaurar backup** → escolha o arquivo do pendrive.


## Problemas comuns
- **"Cannot create symbolic link"** ao gerar: ative o *Modo de Desenvolvedor* do Windows
  (Configurações → Sistema → Para desenvolvedores), apague `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` e rode de novo.
- **Falha de download**: confira a internet/antivírus e rode de novo.
- Não deixe o programa instalado e o `npm start` abertos ao mesmo tempo no mesmo computador (usam o mesmo banco).
