@echo off
setlocal
cd /d "%~dp0"

echo  WheelRing — сборка EXE через PyInstaller
echo.

where pyinstaller >nul 2>nul
if errorlevel 1 (
    echo  Пакет pyinstaller не найден. Устанавливаю...
    python -m pip install pyinstaller || (
        echo  Не удалось установить pyinstaller. Установите его вручную:
        echo    python -m pip install pyinstaller
        pause
        exit /b 1
    )
)

python -m PyInstaller --onefile --windowed --name WheelRing --noconfirm --clean wheel_ring.py
if errorlevel 1 (
    echo.
    echo  Ошибка сборки. Проверьте вывод выше.
    pause
    exit /b 1
)

echo.
echo  Готово: dist\WheelRing.exe
echo  Переносимый EXE также запустится сам без Python.
pause
endlocal
