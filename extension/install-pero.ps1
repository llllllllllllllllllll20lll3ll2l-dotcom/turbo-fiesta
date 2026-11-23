param([string]$ExtensionDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Model = 'qwen3:4b-instruct-2507-q4_K_M'
$Api = 'http://127.0.0.1:11434/api/version'

function Find-Ollama {
    $known = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $known -PathType Leaf) { return $known }
    $command = Get-Command 'ollama.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Test-OllamaApi {
    try {
        $response = Invoke-RestMethod -Uri $Api -Method Get -TimeoutSec 3
        return [bool]$response.version
    } catch { return $false }
}

function Install-Ollama {
    $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host 'Пробую установить Ollama через WinGet (официальный пакет Ollama.Ollama)...'
        try {
            & $winget.Source install --id Ollama.Ollama --exact --source winget --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -eq 0 -and (Find-Ollama)) { return }
            Write-Warning 'WinGet не завершил установку; попробую официальный установщик.'
        } catch {
            Write-Warning 'WinGet недоступен; попробую официальный установщик.'
        }
    }

    $download = 'https://ollama.com/download/OllamaSetup.exe'
    $installer = Join-Path $env:TEMP ('Pero-OllamaSetup-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host ('Скачиваю установщик только с ' + $download)
        Invoke-WebRequest -Uri $download -OutFile $installer -UseBasicParsing -MaximumRedirection 5
        if ((Get-Item -LiteralPath $installer).Length -lt 1000000) { throw 'Скачанный файл слишком мал.' }
        $signature = Get-AuthenticodeSignature -FilePath $installer
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Ollama Inc\.(,|$)') {
            throw 'Подпись установщика не подтверждена (Ollama Inc.). Файл НЕ запускался.'
        }
        Write-Host 'Цифровая подпись Ollama Inc. проверена. Запускаю установку...'
        $process = Start-Process -FilePath $installer -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw ('Установщик завершился с кодом ' + $process.ExitCode) }
    } finally {
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
    }
}

function Start-OllamaIfNeeded([string]$Exe) {
    if (Test-OllamaApi) { return }
    $app = Join-Path (Split-Path -Parent $Exe) 'Ollama app.exe'
    if (Test-Path -LiteralPath $app -PathType Leaf) {
        Write-Host 'Запускаю Ollama из установленного приложения...'
        Start-Process -FilePath $app
    } else {
        Write-Host 'Запускаю локальный сервер Ollama...'
        Start-Process -FilePath $Exe -ArgumentList 'serve' -WindowStyle Minimized
    }
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-OllamaApi) { return }
        Start-Sleep -Seconds 1
    }
    throw 'Ollama не ответила на 127.0.0.1:11434. Проверьте значок в трее, антивирус и порт 11434, затем запустите батник ещё раз.'
}

function Prepare-Extension([string]$Source) {
    $manifest = Join-Path $Source 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        Write-Warning 'manifest.json не найден. Ollama и модель готовы, но для расширения нужен полный ZIP Перо.'
        return $null
    }
    $default = Join-Path $env:LOCALAPPDATA 'PeroExtension'
    Write-Host ''
    Write-Host 'Если Перо уже установлено, укажите ТУ ЖЕ папку с manifest.json, иначе изменится ID расширения.'
    Write-Host ('Новая установка по умолчанию: ' + $default)
    $choice = Read-Host 'Папка расширения (Enter = по умолчанию, - = пропустить копирование)'
    if ($choice -eq '-') { return $null }
    $target = if ([string]::IsNullOrWhiteSpace($choice)) { $default } else { [Environment]::ExpandEnvironmentVariables($choice.Trim().Trim('"')) }
    $target = [IO.Path]::GetFullPath($target)
    $sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    $targetPath = $target.TrimEnd('\')
    if ($targetPath.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Папка назначения не должна быть внутри исходной папки (риск рекурсивного копирования).'
    }
    if (-not $targetPath.Equals($sourcePath, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $targetPath) -and (Get-ChildItem -LiteralPath $targetPath -Force | Select-Object -First 1) -and
            -not (Test-Path -LiteralPath (Join-Path $targetPath 'manifest.json') -PathType Leaf)) {
            throw 'Выбранная папка не пуста и не содержит manifest.json. Выберите пустую папку или прежнюю папку Перо.'
        }
        if (Test-Path -LiteralPath (Join-Path $targetPath 'manifest.json')) {
            $old = Get-Content -LiteralPath (Join-Path $targetPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($old.name -notlike 'Перо*') { throw 'В выбранной папке находится другое расширение. Копирование отменено.' }
        }
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        foreach ($item in (Get-ChildItem -LiteralPath $sourcePath -Force)) {
            Copy-Item -LiteralPath $item.FullName -Destination $targetPath -Recurse -Force
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $targetPath 'manifest.json') -PathType Leaf)) {
        throw 'Копирование расширения не удалось: manifest.json отсутствует.'
    }
    Write-Host ('Расширение подготовлено: ' + $targetPath)
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $targetPath + '"') } catch { }
    return $targetPath
}

function Open-ExtensionPage {
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $candidates = @(
        @{ Name = 'Chrome'; Path = (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'); Url = 'chrome://extensions/' },
        @{ Name = 'Chrome'; Path = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'); Url = 'chrome://extensions/' },
        @{ Name = 'Edge'; Path = (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'); Url = 'edge://extensions/' },
        @{ Name = 'Яндекс Браузер'; Path = (Join-Path $env:LOCALAPPDATA 'Yandex\YandexBrowser\Application\browser.exe'); Url = 'browser://extensions/' },
        @{ Name = 'Яндекс Браузер'; Path = (Join-Path $env:ProgramFiles 'Yandex\YandexBrowser\Application\browser.exe'); Url = 'browser://extensions/' }
    )
    if ($pf86) {
        $candidates += @{ Name = 'Chrome'; Path = (Join-Path $pf86 'Google\Chrome\Application\chrome.exe'); Url = 'chrome://extensions/' }
        $candidates += @{ Name = 'Edge'; Path = (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe'); Url = 'edge://extensions/' }
        $candidates += @{ Name = 'Яндекс Браузер'; Path = (Join-Path $pf86 'Yandex\YandexBrowser\Application\browser.exe'); Url = 'browser://extensions/' }
    }
    $available = @($candidates | Where-Object { Test-Path -LiteralPath $_.Path -PathType Leaf })
    if (-not $available.Count) { Write-Host 'Откройте chrome://extensions/, edge://extensions/ или browser://extensions/ вручную.'; return }
    Write-Host 'Какую страницу расширений открыть?'
    for ($i = 0; $i -lt $available.Count; $i++) { Write-Host (('{0}. {1}' -f ($i + 1), $available[$i].Name)) }
    $selection = Read-Host 'Номер (Enter = не открывать автоматически)'
    if (-not $selection) { return }
    $number = 0
    if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $available.Count) {
        Write-Warning 'Неверный номер. Откройте страницу расширений вручную.'
        return
    }
    try { Start-Process -FilePath $available[$number - 1].Path -ArgumentList $available[$number - 1].Url }
    catch { Write-Warning 'Браузер не удалось открыть автоматически; откройте страницу расширений вручную.' }
}

function Configure-ExtensionOrigin {
    Write-Host ''
    Write-Host 'После загрузки расширения откройте его карточку в chrome://extensions/ или edge://extensions/.'
    Write-Host 'Скопируйте ID расширения (32 буквы a-p). Пустой ввод пропускает настройку.'
    $id = (Read-Host 'ID Перо').Trim().ToLowerInvariant()
    if (-not $id) {
        Write-Host 'Пропущено: если Перо не подключится, задайте OLLAMA_ORIGINS командой в его настройках.'
        return
    }
    if ($id -cnotmatch '^[a-p]{32}$') { throw 'Некорректный ID. Ничего в OLLAMA_ORIGINS не изменено.' }
    $origin = 'chrome-extension://' + $id
    $current = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
    $items = @($current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($items -notcontains $origin -and $items -notcontains 'chrome-extension://*') {
        $updated = (@($items) + $origin) -join ','
        [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', $updated, 'User')
        Write-Host ('Добавлен только origin этого расширения: ' + $origin)
    } else { Write-Host 'Разрешение для этого расширения уже есть.' }
    Write-Host 'ВАЖНО: полностью выйдите из Ollama через значок в трее и откройте её снова из меню Пуск.'
    Write-Host 'Затем в панели Перо нажмите Настройки -> Обновить список моделей. Уже запущенный процесс не получает новые переменные автоматически.'
}

try {
    Write-Host '=== Установка Перо: Ollama + локальная Qwen3 + расширение ==='
    Write-Host ('Модель: ' + $Model + ' (~2.5 ГБ; нужен интернет и свободное место)')
    if ($env:OLLAMA_HOST -match '0\.0\.0\.0') {
        Write-Warning 'OLLAMA_HOST содержит 0.0.0.0: Ollama может быть доступна в локальной сети. Батник это не меняет.'
    }
    $ollamaExe = Find-Ollama
    if (-not $ollamaExe) {
        Install-Ollama
        $ollamaExe = Find-Ollama
        if (-not $ollamaExe) { throw 'Ollama не найдена после установки. Проверьте установщик и запустите батник снова. Официальная страница: https://ollama.com/download/windows' }
    } else { Write-Host ('Ollama уже найдена: ' + $ollamaExe) }
    Start-OllamaIfNeeded $ollamaExe
    $models = (& $ollamaExe list 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw ('Не удалось получить список моделей: ' + $models) }
    if ($models -match '(?im)^qwen3:4b-instruct-2507-q4_K_M\s') {
        Write-Host 'Нужная модель уже установлена. Повторно не скачиваю.'
    } else {
        Write-Host 'Скачиваю локальную модель (это может занять некоторое время)...'
        & $ollamaExe pull $Model
        if ($LASTEXITCODE -ne 0) { throw 'Загрузка модели не завершилась. Проверьте интернет и свободное место; повторный запуск продолжит загрузку.' }
    }
    $models = (& $ollamaExe list 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $models -notmatch '(?im)^qwen3:4b-instruct-2507-q4_K_M\s') { throw 'Ollama не подтвердила наличие нужной модели.' }
    Write-Host 'Модель проверена через ollama list.'
    $installed = Prepare-Extension $ExtensionDir
    if ($installed) {
        Write-Host ('В браузере включите Режим разработчика -> Загрузить распакованное расширение -> ' + $installed)
        Write-Host 'Если расширение уже загружено из этой папки, нажмите Обновить на его карточке.'
        Open-ExtensionPage
        Configure-ExtensionOrigin
    }
    Write-Host ''
    Write-Host 'Готово: Ollama и модель установлены. Проверьте подключение в панели Перо.'
    exit 0
} catch {
    Write-Host ''
    Write-Host ('Установка остановлена: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Если ошибка связана с подписью, скачанный установщик не запускался.'
    Write-Host 'Официальная страница для ручной установки: https://ollama.com/download/windows'
    exit 1
}
