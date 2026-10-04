# Reports how the "dyposcloud" hostname is currently bound on Cloudflare.
$ErrorActionPreference = 'Stop'

$cfg = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
$token = $null
foreach ($line in Get-Content $cfg) {
  if ($line -match '^oauth_token\s*=\s*"(.+)"') { $token = $Matches[1] }
}
if (-not $token) { throw 'No wrangler OAuth token found' }

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$accountId = 'ce1007ca229319e79c9305f0b954536a'

# Worker custom domains
$w = Invoke-RestMethod -Headers $headers -Uri `
  "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/domains"
Write-Host 'worker domains:'
foreach ($d in @($w.result)) {
  Write-Host ("  {0,-34} service={1} zone={2}" -f $d.hostname, $d.service, $d.zone_name)
}

# DNS record for the hostname, so we can see if it has actually been created.
$zoneId = '27bbfbac5c7c0dd7c244bb19e084a2b3'
$dns = Invoke-RestMethod -Headers $headers -Uri `
  "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?name=dyposcloud.smartportssoft.com"
Write-Host 'dns records:'
foreach ($r in @($dns.result)) {
  Write-Host ("  {0}  type={1} content={2}" -f $r.name, $r.type, $r.content)
}
if (@($dns.result).Count -eq 0) { Write-Host '  (none yet)' }