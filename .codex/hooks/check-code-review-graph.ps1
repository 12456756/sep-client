$null = [Console]::In.ReadToEnd()

if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
  exit 0
}

$repoRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
  exit 0
}

uvx code-review-graph status --repo $repoRoot 2>$null | Out-Null
exit 0
