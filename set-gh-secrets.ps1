# One-time: seed GitHub Actions secrets/vars from the local .env so the
# gated deploy (which needs DATABASE_URL + session secret + CF credentials)
# can finally run. CLOUDFLARE_API_TOKEN / ACCOUNT_ID are NOT in .env and must
# be supplied once by the account owner.
$ErrorActionPreference = 'Stop'
$repo = 'dynamicyemen24-hash/dyna'
$envPath = 'd:\SulationDy\dyposcloud\.env'

$map = @{}
foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $map[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
}

function Set-SecretIfPresent($name, $key) {
    if ($map.ContainsKey($key) -and $map[$key]) {
        $map[$key] | gh secret set $name --repo $repo
        Write-Host "SECRET $name <- set"
    } else {
        Write-Host "SECRET $name <- MISSING in .env ($key)"
    }
}

Set-SecretIfPresent 'DATABASE_URL' 'DATABASE_URL'
Set-SecretIfPresent 'DYPOS_SESSION_SECRET' 'DYPOS_SESSION_SECRET'

# DEFAULT_TENANT is a plain variable, not a secret.
'royal-global-hq' | gh variable set DEFAULT_TENANT --repo $repo
Write-Host "VAR DEFAULT_TENANT <- set"

Write-Host "`n=== CLOUDFLARE (must be set by owner) ==="
foreach ($n in 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID') {
    $exists = gh secret list --repo $repo | Select-String $n
    Write-Host ("{0}: {1}" -f $n, ($(if ($exists) { 'PRESENT' } else { 'MISSING' })))
}
