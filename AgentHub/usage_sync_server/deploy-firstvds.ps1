[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SshKey,
    [Parameter(Mandatory)][string]$Server,
    [string]$RemoteDir = '/opt/agenthub-usage-sync',
    [string]$Service = 'agenthub-usage-sync.service',
    [string]$HealthUrl = '',
    [switch]$SkipHealthCheck
)

$ErrorActionPreference = 'Stop'
if (-not $SkipHealthCheck -and [string]::IsNullOrWhiteSpace($HealthUrl)) {
    throw 'Specify -HealthUrl for this deployment, or explicitly choose -SkipHealthCheck.'
}

function Invoke-CheckedProcess {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory)]
        [string]$FailureMessage
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Invoke-HealthCheck {
    param([Parameter(Mandatory)][string]$Url)

    $request = @{
        Uri = $Url
        Method = 'POST'
        Body = '{}'
        ContentType = 'application/json'
        TimeoutSec = 15
    }
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $request.SkipCertificateCheck = $true
    }

    try {
        $response = Invoke-WebRequest @request
        $statusCode = [int]$response.StatusCode
    } catch {
        if ($null -eq $_.Exception.Response) {
            throw
        }
        $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -ne 403) {
        throw "Unexpected health status $statusCode from $Url. Expected 403 for unsigned enrollment-code request."
    }
}

$scriptPath = Join-Path $PSScriptRoot 'agenthub_usage_sync_server.py'
$requirementsPath = Join-Path $PSScriptRoot 'requirements.txt'

if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Source server script not found: $scriptPath"
}
if (-not (Test-Path -LiteralPath $requirementsPath)) {
    throw "Requirements file not found: $requirementsPath"
}
if (-not (Test-Path -LiteralPath $SshKey)) {
    throw "SSH key not found: $SshKey"
}
if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw 'ssh.exe was not found in PATH.'
}
if (-not (Get-Command scp.exe -ErrorAction SilentlyContinue)) {
    throw 'scp.exe was not found in PATH.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteStage = "/tmp/agenthub-usage-sync-deploy-$stamp"
$sshBaseArgs = @(
    '-i', $SshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    $Server
)
$scpBaseArgs = @(
    '-q',
    '-i', $SshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes'
)

$remoteScript = @"
set -eu
stage='$remoteStage'
remote_dir='$RemoteDir'
service='$Service'
timestamp=`$(date -u +%Y%m%dT%H%M%SZ)

python3 -m py_compile "`$stage/agenthub_usage_sync_server.py"
sudo -n install -o root -g root -m 755 -d "`$remote_dir"
if [ -f "`$remote_dir/agenthub_usage_sync_server.py" ]; then
  sudo -n cp -a "`$remote_dir/agenthub_usage_sync_server.py" "`$remote_dir/agenthub_usage_sync_server.py.bak.`$timestamp"
fi
sudo -n install -o root -g root -m 755 "`$stage/agenthub_usage_sync_server.py" "`$remote_dir/agenthub_usage_sync_server.py"
sudo -n install -o root -g root -m 644 "`$stage/requirements.txt" "`$remote_dir/requirements.txt"
sudo -n systemctl restart "`$service"
sudo -n systemctl is-active --quiet "`$service"
sudo -n systemctl status "`$service" --no-pager -l | sed -n '1,18p'
rm -rf "`$stage"
"@

$target = "${Server}:$remoteStage/"
if ($PSCmdlet.ShouldProcess($Server, "Deploy Agent Hub usage-sync server to $RemoteDir and restart $Service")) {
    Invoke-CheckedProcess -FilePath 'ssh.exe' -ArgumentList ($sshBaseArgs + @("mkdir -p '$remoteStage'")) `
        -FailureMessage "Could not create remote staging directory $remoteStage."

    try {
        Invoke-CheckedProcess -FilePath 'scp.exe' -ArgumentList ($scpBaseArgs + @($scriptPath, $requirementsPath, $target)) `
            -FailureMessage 'Could not upload usage-sync server files.'

        Invoke-CheckedProcess -FilePath 'ssh.exe' -ArgumentList ($sshBaseArgs + @($remoteScript)) `
            -FailureMessage "Could not install or restart $Service."
    } finally {
        & ssh.exe @sshBaseArgs "rm -rf '$remoteStage'" | Out-Null
    }

    if (-not $SkipHealthCheck) {
        Invoke-HealthCheck -Url $HealthUrl
    }

    Write-Output "Agent Hub usage-sync server deployed to $Server and $Service is active."
}
