$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{
    CpuLoadPercent = $cpu
    FreePhysicalMemoryKB = $os.FreePhysicalMemory
    TotalVisibleMemorySizeKB = $os.TotalVisibleMemorySize
    ProcessCount = (Get-Process).Count
} | ConvertTo-Json -Compress
