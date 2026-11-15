# verify_timestamped.ps1
$ErrorActionPreference = "Stop"

$filePath = $env:VEYYON_OWNER_ONLY_ACL_PATH
if (-not $filePath) {
    Write-Error "VEYYON_OWNER_ONLY_ACL_PATH environment variable is required"
    exit 1
}

$item = Get-Item -LiteralPath $filePath -Force
$acl = Get-Acl -LiteralPath $filePath
$owner = $acl.Owner

$ownerIsLocalSystem = ($owner -eq "NT AUTHORITY\SYSTEM")

$invalidRules = @(
    $acl.Access | Where-Object {
        $identity = $_.IdentityReference.Value
        if ($identity -eq "NT AUTHORITY\SYSTEM") {
            return $false
        }
        if ($identity -eq $owner) {
            return $false
        }
        return $true
    }
)

$hasOwnerAllow = @(
    $acl.Access | Where-Object {
        $_.IdentityReference.Value -eq $owner -and
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
    }
).Count -gt 0

$isValid = ($invalidRules.Count -eq 0) -and ($hasOwnerAllow -or $ownerIsLocalSystem)

$endUtc = [DateTime]::UtcNow.ToString("o")
Write-Output "PS_SCRIPT_END:$endUtc"

if ($isValid) {
    Write-Output "OK"
    exit 0
} else {
    Write-Error "Invalid ACL"
    exit 1
}
