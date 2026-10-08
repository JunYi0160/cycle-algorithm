param([string]$TaskPython = 'C:\Users\jun\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
$ErrorActionPreference='Stop'
$taskOldPythonPath=$env:PYTHONPATH
$taskRepo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Push-Location -LiteralPath $taskRepo
try {
    $taskLibraries='C:\Users\jun\.cache\cycle-algorithm-research-python'
    if (Test-Path -LiteralPath $taskLibraries) {
        $env:PYTHONPATH=$taskLibraries+$(if ($taskOldPythonPath) {';'+$taskOldPythonPath} else {''})
    }
    & $TaskPython research/v2/test_engine.py
    if ($LASTEXITCODE -ne 0) {throw 'Strategy verification failed.'}
    & $TaskPython research/v2/run.py
    if ($LASTEXITCODE -ne 0) {throw 'Frozen batch replay failed.'}
    & $TaskPython research/v2/report.py
    if ($LASTEXITCODE -ne 0) {throw 'Research report generation failed.'}
} finally {
    $env:PYTHONPATH=$taskOldPythonPath
    Pop-Location
}
