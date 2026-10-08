$ErrorActionPreference = 'Stop'
$taskPython = 'C:\Users\jun\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$taskLibraries = 'C:\Users\jun\.cache\cycle-algorithm-research-python'
$taskPreviousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = $taskLibraries
    foreach ($taskScript in @('download.py', 'run.py', 'report.py')) {
        & $taskPython (Join-Path $PSScriptRoot $taskScript)
        if ($LASTEXITCODE -ne 0) { throw "Research script failed: $taskScript" }
    }
} finally {
    $env:PYTHONPATH = $taskPreviousPythonPath
}
