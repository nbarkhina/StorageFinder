@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1

dotnet publish ".\src\StorageFinder.App" --configuration Release --output ".\artifacts\StorageFinder" --no-restore
set "buildExitCode=%errorlevel%"

popd
exit /b %buildExitCode%
