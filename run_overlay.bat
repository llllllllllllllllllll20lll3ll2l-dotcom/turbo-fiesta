@echo off
setlocal
cd /d "%~dp0"

REM Приоритет: готовый EXE из папки dist\, иначе скрипт через Python.
if exist "dist\WheelRing.exe" (
    start "" "dist\WheelRing.exe"
    exit /b 0
)

where python >nul 2>nul
if errorlevel 1 (
    echo Python не найден. Установите Python 3.9+ с tkinter:
    echo   https://www.python.org/downloads/  (в галере согласно установщику)
    echo  Либо соберите EXE через build_exe.bat
    pause
    exit /b 1
)

echo  Запуск WheelRing (колесо мыши = показать/скрыть оверлей)
echo  Закрывать через ⏻ в шапке окна.
python wheel_ring.py
endlocal
