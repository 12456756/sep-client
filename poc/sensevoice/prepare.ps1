$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $root 'resources/speech/sensevoice-int8'
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $directory 'manifest.json') | ConvertFrom-Json

function Test-Asset($path, $asset) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $path).Length -ne $asset.bytes) { return $false }
    if ($asset.sha256) {
        return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $asset.sha256
    }
    $gitHash = & git hash-object -- $path
    if ($LASTEXITCODE -ne 0) { throw 'git hash-object failed' }
    return $gitHash -eq $asset.gitSha1
}

foreach ($asset in $manifest.files) {
    $path = Join-Path $directory $asset.path
    if (Test-Asset $path $asset) {
        Write-Output "Verified: $($asset.path)"
        continue
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path)) | Out-Null
    $url = "$($manifest.repository)/resolve/$($manifest.revision)/$($asset.path)"
    Write-Output "Downloading developer asset: $($asset.path)"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$path.download" -TimeoutSec 900
    if (-not (Test-Asset "$path.download" $asset)) { throw "Checksum mismatch: $($asset.path)" }
    Move-Item -LiteralPath "$path.download" -Destination $path -Force
}
Write-Output 'Developer assets ready. Recognition itself never downloads assets.'
