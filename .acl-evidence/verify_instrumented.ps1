$ErrorActionPreference = 'Stop'
$sw_total = [Diagnostics.Stopwatch]::StartNew()
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }

$sw_item = [Diagnostics.Stopwatch]::StartNew()
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
$sw_item.Stop()

if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACL target is a reparse point' }

$sw_acl_body = [Diagnostics.Stopwatch]::StartNew()
if ($item.PSProvider.Name -ne 'FileSystem') { throw 'ACL target is not a filesystem path' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier])
if (-not $owner.Equals($identity)) { throw 'ACL owner is not the current user' }
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is enabled' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'ACL does not contain exactly two access rules' }
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$expectedIdentities = @($identity, $system)
$expectedInheritance = [Security.AccessControl.InheritanceFlags]::None
if ($item.PSIsContainer) {
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
}
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'ACL contains an inherited access rule' }
  $principalAllowed = $false
  foreach ($expectedIdentity in $expectedIdentities) {
    if ($rule.IdentityReference.Equals($expectedIdentity)) { $principalAllowed = $true }
  }
  if (-not $principalAllowed) { throw 'ACL grants another identity access' }
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL principal rule is not an allow rule' }
  if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL principal rule is not exactly full control' }
  if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'ACL principal rule has unexpected propagation flags' }
  if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'ACL principal rule has unexpected inheritance flags' }
}
foreach ($expectedIdentity in $expectedIdentities) {
  $principalRules = @($rules | Where-Object { $_.IdentityReference.Equals($expectedIdentity) })
  if ($principalRules.Count -ne 1) { throw 'ACL is missing an expected principal rule' }
}
if ($item.PSIsContainer) {
  foreach ($rule in $rules) {
    if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'ACL directory principal rule does not protect descendants' }
  }
} elseif ($rules | Where-Object { $_.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None }) {
  throw 'ACL file principal rule has unexpected inheritance flags'
}
$sw_acl_body.Stop()
$sw_total.Stop()

$timing = [PSCustomObject]@{
    item_ms = [math]::Round($sw_item.Elapsed.TotalMilliseconds, 2)
    acl_body_ms = [math]::Round($sw_acl_body.Elapsed.TotalMilliseconds, 2)
    internal_total_ms = [math]::Round($sw_total.Elapsed.TotalMilliseconds, 2)
} | ConvertTo-Json -Compress
[Console]::Error.WriteLine("TIMING_BREAKDOWN:$timing")
[Console]::Out.Write('OK')
