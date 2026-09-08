#Requires -Version 7.0
param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$files = Get-Content -LiteralPath (Join-Path $root 'release-files.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $root 'dist/manifest.json') -Raw | ConvertFrom-Json
if (-not $ValidateOnly -and ($package.license -ne 'PolyForm-Noncommercial-1.0.0' -or -not (Test-Path -LiteralPath (Join-Path $root 'LICENSE')))) { throw 'License is missing or unconfirmed. No archive may be released.' }
if ($manifest.version -ne $package.version -or $manifest.status -notin @('candidate', 'released')) { throw 'Manifest version/status mismatch.' }
if ($manifest.license -ne $package.license) { throw 'Manifest license mismatch.' }
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
if (@($files | Sort-Object -Unique).Count -ne $files.Count) { throw 'Duplicate archive paths.' }
$paths = @{}
$contents = @{}
foreach ($file in $files) {
    if ([System.IO.Path]::IsPathRooted($file) -or $file -match '(^|[/\\])\.\.([/\\]|$)|\\') { throw 'Unsafe archive path.' }
    $absolute = [System.IO.Path]::GetFullPath((Join-Path $root $file))
    if (-not $absolute.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes root.' }
    $item = Get-Item -LiteralPath $absolute
    if ($item.PSIsContainer) { throw 'Archive entries must be files.' }
    for ($check = $item; $check -and $check.FullName -ne $root; $check = $check.Parent ?? $check.Directory) {
        if (($check.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Links are not allowed in release inputs.' }
    }
    $paths[$file] = $absolute
    $contents[$file] = [System.IO.File]::ReadAllBytes($absolute)
}
function Get-BytesHash([byte[]]$Bytes) {
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
if ((Get-BytesHash $contents['LICENSE']) -ne $manifest.licenseSha256 -or
    (Get-BytesHash $contents['NOTICE']) -ne $manifest.noticeSha256) { throw 'License or required notice changed since build.' }
if (@($manifest.files.PSObject.Properties.Name | Sort-Object) -join ',' -ne 'index.js,offline.json,online-fixed.json,online-latest.json') { throw 'Unexpected manifest artifacts.' }
foreach ($property in $manifest.files.PSObject.Properties) {
    $key = "dist/$($property.Name)"
    if (-not $contents.ContainsKey($key)) { throw 'Manifest artifact is not allowlisted.' }
    $actual = Get-BytesHash $contents[$key]
    if ($actual -ne $property.Value.sha256) { throw 'Artifact changed since build.' }
    if ($contents[$key].Length -ne $property.Value.bytes) { throw 'Artifact size mismatch.' }
}
if ((Get-BytesHash $contents['patches/shujuku-scope-binding-patch.js']) -ne $manifest.sourceSha256 -or
    (Get-BytesHash $contents['dist/index.js']) -ne $manifest.sourceSha256) { throw 'Source changed since build.' }
$memory = [System.IO.MemoryStream]::new()
$zip = [System.IO.Compression.ZipArchive]::new($memory, [System.IO.Compression.ZipArchiveMode]::Create, $true)
try {
    foreach ($file in ($files | Sort-Object -CaseSensitive)) {
        $entry = $zip.CreateEntry($file, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $entry.ExternalAttributes = 0
        $stream = $entry.Open()
        try { $bytes = $contents[$file]; $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
} finally { $zip.Dispose() }
$memory.Position = 0
$zip = [System.IO.Compression.ZipArchive]::new($memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
try {
    if ($zip.Entries.Count -ne $files.Count) { throw 'Archive file count mismatch.' }
    foreach ($entry in $zip.Entries) {
        if (-not $paths.ContainsKey($entry.FullName)) { throw 'Unexpected archive entry.' }
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
        if ($hash.ToLowerInvariant() -ne (Get-BytesHash $contents[$entry.FullName])) { throw 'Archive content mismatch.' }
    }
} finally { $zip.Dispose() }
foreach ($file in $files) {
    if ((Get-FileHash -LiteralPath $paths[$file] -Algorithm SHA256).Hash.ToLowerInvariant() -ne (Get-BytesHash $contents[$file])) { throw 'Input changed during packaging.' }
}
$archiveBytes = $memory.ToArray()
$memory.Dispose()
if ($ValidateOnly) {
    [ordered]@{ mode = 'validation-only'; entries = $files.Count; bytes = $archiveBytes.Length; sha256 = (Get-BytesHash $archiveBytes); archiveWritten = $false } | ConvertTo-Json -Compress
    return
}
$output = Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $output -Force | Out-Null
if (((Get-Item -LiteralPath $output).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Output directory cannot be a link.' }
$suffix = if ($manifest.status -eq 'candidate') { '-candidate' } else { '' }
$name = "shujuku-scope-binding-v$($package.version)$suffix.zip"
$destination = Join-Path $output $name
$temporary = Join-Path $output "$name.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    [System.IO.File]::WriteAllBytes($temporary, $archiveBytes)
    Move-Item -LiteralPath $temporary -Destination $destination -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
Write-Output "$name verified: $($files.Count) allowlisted entries. No Git or network operation performed."
