$ErrorActionPreference = 'SilentlyContinue'
$res = [PSCustomObject]@{ Status = $null; Error = $null }
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $res.Status = [PSCustomObject]@{
        AntivirusEnabled = $mp.AntivirusEnabled
        RealTimeProtectionEnabled = $mp.RealTimeProtectionEnabled
        IoavProtectionEnabled = $mp.IoavProtectionEnabled
        AntispywareEnabled = $mp.AntispywareEnabled
        BehaviorMonitorEnabled = $mp.BehaviorMonitorEnabled
        OnAccessProtectionEnabled = $mp.OnAccessProtectionEnabled
        AMServiceEnabled = $mp.AMServiceEnabled
        AntivirusSignatureLastUpdated = if ($mp.AntivirusSignatureLastUpdated) { $mp.AntivirusSignatureLastUpdated.ToString("o") } else { $null }
        EngineVersion = $mp.EngineVersion
        AntivirusSignatureVersion = $mp.AntivirusSignatureVersion
    }
} catch {
    $res.Error = $_.Exception.Message
}
$res | ConvertTo-Json -Compress
