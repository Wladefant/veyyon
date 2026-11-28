param([Parameter(Mandatory = $true)][string]$ScratchRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-appcontainer.cs')

function Assert-Win32Failure([scriptblock]$operation, [int]$expected) {
    try {
        & $operation
    } catch {
        $failure = $_.Exception.GetBaseException()
        if ($failure -is [System.ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq $expected) {
            return
        }
        throw
    }
    throw "Expected Win32 error $expected"
}

$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
$descriptor = $acl.GetSecurityDescriptorBinaryForm()

$id = [Guid]::NewGuid()
$directory = Join-Path $ScratchRoot $id.ToString('N')
$marker = Join-Path $directory 'fixture.txt'
$handle = $null
try {
    $handle = [SecondaryScratch]::Create($ScratchRoot, $id, $descriptor)
    $actual = Get-Acl -LiteralPath $directory
    if (-not $actual.AreAccessRulesProtected -or $actual.Access.Count -ne 1) {
        throw 'The new scratch directory did not get its private DACL at creation.'
    }
    Write-Output '[PASS] Scratch is private at creation'

    [System.IO.File]::WriteAllText($marker, 'keep')
    Assert-Win32Failure {
        $unexpected = [SecondaryScratch]::Create($ScratchRoot, $id, $descriptor)
        $unexpected.Dispose()
    } 183 # ERROR_ALREADY_EXISTS
    if ((Get-Acl -LiteralPath $directory).Sddl -ne $actual.Sddl) {
        throw 'Failed creation changed the existing directory DACL.'
    }
    Write-Output '[PASS] Creation never reuses an existing directory'

    Assert-Win32Failure { [SecondaryScratch]::DeleteEmpty($handle) } 145 # ERROR_DIR_NOT_EMPTY
    if ([System.IO.File]::ReadAllText($marker) -ne 'keep') {
        throw 'Cleanup changed an entry in the nonempty directory.'
    }
    Write-Output '[PASS] Cleanup does not recurse into nonempty scratch'
} finally {
    if ($handle) {
        try {
            [System.IO.File]::Delete($marker)
            [SecondaryScratch]::DeleteEmpty($handle)
        } finally {
            $handle.Dispose()
        }
    }
}
if (Test-Path -LiteralPath $directory) {
    throw 'The bound scratch directory was not removed.'
}
Write-Output '[PASS] Empty scratch is removed when its handle closes'
