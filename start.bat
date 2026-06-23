@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"

echo.
echo Future Headlines local launcher
echo ===============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)

if not exist "%BACKEND%\package.json" (
  echo [ERROR] Cannot find backend package at "%BACKEND%".
  pause
  exit /b 1
)

if not exist "%FRONTEND%\package.json" (
  echo [ERROR] Cannot find frontend package at "%FRONTEND%".
  pause
  exit /b 1
)

if not exist "%BACKEND%\.env" (
  echo [ERROR] Missing backend\.env.
  echo Create it from backend\.env.example, then rerun this file.
  pause
  exit /b 1
)

set "DOCKER=docker"
set "DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin"
set "DOCKER_AVAILABLE=0"
where docker >nul 2>nul
if not errorlevel 1 (
  set "DOCKER_AVAILABLE=1"
) else (
  if exist "%DOCKER_BIN%\docker.exe" (
    set "PATH=%DOCKER_BIN%;%PATH%"
    set "DOCKER=%DOCKER_BIN%\docker.exe"
    set "DOCKER_AVAILABLE=1"
  )
)

set "LOCAL_DATABASE_URL=postgres://postgres:postgres@localhost:5432/future_headlines"
set "DB_PLACEHOLDER=0"
set "DB_LOCAL_DOCKER=0"
set "STARTED_LOCAL_DB=0"
findstr /C:"DATABASE_URL=postgres://USER:PASS@HOST:5432/DBNAME" "%BACKEND%\.env" >nul 2>nul
if not errorlevel 1 set "DB_PLACEHOLDER=1"
findstr /C:"DATABASE_URL=%LOCAL_DATABASE_URL%" "%BACKEND%\.env" >nul 2>nul
if not errorlevel 1 set "DB_LOCAL_DOCKER=1"

echo [1/6] Preparing database...
if "%DB_PLACEHOLDER%"=="1" (
  if "%DOCKER_AVAILABLE%"=="0" (
    echo [ERROR] backend\.env has a placeholder DATABASE_URL and Docker was not found.
    echo Install/start Docker Desktop, or edit backend\.env with your PostgreSQL connection string.
    pause
    exit /b 1
  )

  echo DATABASE_URL is a placeholder. Starting local PostgreSQL with Docker Compose...
  call :start_local_db
  if errorlevel 1 (
    pause
    exit /b 1
  )

  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$path = '%BACKEND%\.env';" ^
    "$content = Get-Content -LiteralPath $path -Raw;" ^
    "$content = $content -replace 'DATABASE_URL=postgres://USER:PASS@HOST:5432/DBNAME', 'DATABASE_URL=%LOCAL_DATABASE_URL%';" ^
    "Set-Content -LiteralPath $path -Value $content -NoNewline"
  if errorlevel 1 (
    echo [ERROR] Failed to update DATABASE_URL in backend\.env.
    pause
    exit /b 1
  )
  echo backend\.env DATABASE_URL set to %LOCAL_DATABASE_URL%
) else if "%DB_LOCAL_DOCKER%"=="1" (
  if "%DOCKER_AVAILABLE%"=="0" (
    echo [ERROR] backend\.env points at the local Docker database, but Docker was not found.
    echo Start Docker Desktop or edit backend\.env with another PostgreSQL connection string.
    pause
    exit /b 1
  )

  echo DATABASE_URL points at the local Docker PostgreSQL database.
  call :start_local_db
  if errorlevel 1 (
    pause
    exit /b 1
  )
) else (
  echo Using DATABASE_URL from backend\.env.
)

if "%STARTED_LOCAL_DB%"=="1" (
  call :wait_for_db
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo [2/6] Checking backend dependencies...
if not exist "%BACKEND%\node_modules" (
  pushd "%BACKEND%"
  call npm install
  if errorlevel 1 (
    popd
    echo [ERROR] Backend npm install failed.
    pause
    exit /b 1
  )
  popd
) else (
  echo Backend dependencies already installed.
)

echo.
echo [3/6] Checking frontend dependencies...
if not exist "%FRONTEND%\node_modules" (
  pushd "%FRONTEND%"
  call npm install
  if errorlevel 1 (
    popd
    echo [ERROR] Frontend npm install failed.
    pause
    exit /b 1
  )
  popd
) else (
  echo Frontend dependencies already installed.
)

echo.
echo [4/6] Applying database migrations...
pushd "%BACKEND%"
call npm run migrate
if errorlevel 1 (
  popd
  echo.
  echo [ERROR] Database migration failed.
  echo Check DATABASE_URL in backend\.env and make sure the database is reachable.
  pause
  exit /b 1
)
popd

echo.
echo [5/6] Starting backend on http://localhost:3001 ...
start "Future Headlines Backend" /D "%BACKEND%" cmd /k npm run dev

echo [6/6] Starting frontend on http://localhost:5173 ...
start "Future Headlines Frontend" /D "%FRONTEND%" cmd /k npm run dev

echo.
echo Started.
echo Open http://localhost:5173 in your browser.
echo.
echo Leave the two server windows open while using the app.
pause
exit /b 0

:wait_for_db
echo Waiting for PostgreSQL to accept connections...
for /L %%i in (1,1,30) do (
  "%DOCKER%" exec future-headlines-postgres pg_isready -U postgres -d future_headlines >nul 2>nul
  if not errorlevel 1 (
    echo PostgreSQL is ready.
    exit /b 0
  )
  timeout /t 2 /nobreak >nul
)
echo [ERROR] PostgreSQL container did not become ready.
exit /b 1

:start_local_db
"%DOCKER%" compose version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker is installed, but Docker Compose is not available.
  exit /b 1
)

pushd "%ROOT%"
"%DOCKER%" compose up -d postgres
if errorlevel 1 (
  popd
  echo [ERROR] Failed to start PostgreSQL container.
  exit /b 1
)
popd
set "STARTED_LOCAL_DB=1"
exit /b 0
