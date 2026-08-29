@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI\"

REM Simple production launcher for Overlord server.
REM Builds the Tailwind CSS and server bundle, then runs the compiled executable.
REM Env overrides you can set before running:
REM   PORT=5173
REM   HOST=0.0.0.0
REM   OVERLORD_USER=admin
REM   OVERLORD_PASS=your-explicit-bootstrap-password
REM   LOG_LEVEL=info
REM   NODE_ENV=production

if not defined HOST set HOST=0.0.0.0
if not defined PORT set PORT=5173
if not defined LOG_LEVEL set LOG_LEVEL=info
if not defined NODE_ENV set NODE_ENV=production

pushd "%ROOT%Overlord-Server"
echo [build] installing deps (bun install)...
call bun install
if errorlevel 1 goto :err

echo [build] building Tailwind CSS...
call bun run build:css
if errorlevel 1 goto :err

echo [build] building server bundle...
call bun run build
if errorlevel 1 goto :err

echo [build] compiling Windows production executable...
call bun run build:prod:win
if errorlevel 1 goto :err

echo [build] copying Overlord-Client source for runtime builds...
robocopy "%ROOT%Overlord-Client" "%ROOT%Overlord-Server\dist\Overlord-Client" /E /XD build .git .vscode /NFL /NDL /NJH /NJS >nul
REM robocopy exit codes 0-7 are success
if errorlevel 8 goto :err

if defined PORT (
  echo [server] starting on port %PORT%...
) else (
  echo [server] starting on default port...
)
echo [server] running compiled executable...
set "OVERLORD_ROOT=%ROOT%Overlord-Server"
call "%ROOT%Overlord-Server\dist\overlord-server.exe"
popd

echo Server stopped.
endlocal
exit /b 0

:err
popd >nul 2>&1
echo [error] Build failed.
endlocal
exit /b 1
