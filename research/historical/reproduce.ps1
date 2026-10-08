param(
    [string]$TaskPython = 'C:\Users\jun\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe',
    [string]$TaskNode = 'C:\Users\jun\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
)
$ErrorActionPreference = 'Stop'
$taskPreviousPythonPath = $env:PYTHONPATH
$taskRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$taskExtraLibraries = 'C:\Users\jun\.cache\cycle-algorithm-research-python'
Push-Location -LiteralPath $taskRepo
try {
    if (Test-Path -LiteralPath $taskExtraLibraries) {
        $env:PYTHONPATH = $taskExtraLibraries + $(if ($taskPreviousPythonPath) { ';' + $taskPreviousPythonPath } else { '' })
    }
    & $TaskPython research/historical/prepare.py
    if ($LASTEXITCODE -ne 0) { throw 'Cached data validation failed.' }
    & $TaskNode research/historical/run.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Historical replay failed.' }
    & $TaskPython research/historical/screen-equal-return.py
    if ($LASTEXITCODE -ne 0) { throw 'Equal-return screening failed.' }
    & $TaskPython research/historical/report.py
    if ($LASTEXITCODE -ne 0) { throw 'Report generation failed.' }
    & $TaskNode --test research/strategies.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Strategy tests failed.' }
} finally {
    $env:PYTHONPATH = $taskPreviousPythonPath
    Pop-Location
}
