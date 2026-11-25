@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Instalando dependencias, aguarde...
  call npm install
)

call npm start
if errorlevel 1 (
  echo.
  echo O sistema fechou com erro. Leia a mensagem acima e me envie.
  pause
)
