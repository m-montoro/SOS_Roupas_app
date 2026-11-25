@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gerando o instalador do SOS Roupas

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

echo.
echo [1/2] Instalando as ferramentas (precisa de internet)...
call npm install
if errorlevel 1 goto erro

echo.
echo [2/2] Gerando o instalador (a primeira vez demora alguns minutos)...
call npm run dist
if errorlevel 1 goto erro

echo.
echo PRONTO! O instalador esta na pasta "dist":
echo     Instalador-SOS-Roupas-1.1.0.exe
echo Copie esse arquivo para um pendrive e instale no computador da sua mae.
start "" "%~dp0dist"
pause
exit /b 0

:erro
echo.
echo ===== DEU ERRO =====
echo Leia a mensagem acima. Se aparecer "Cannot create symbolic link":
echo   1) Ative o Modo de Desenvolvedor: Configuracoes ^> Sistema ^> Para desenvolvedores
echo   2) Apague a pasta  %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
echo   3) Rode este arquivo de novo (ou rode como Administrador).
pause
exit /b 1
