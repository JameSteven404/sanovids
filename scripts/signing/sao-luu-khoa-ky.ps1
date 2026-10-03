#Requires -Version 5.1

<#
.SYNOPSIS
  Sao lưu khoá ký số SanoVids (chứng chỉ + khoá bí mật) ra một file .pfx có mật khẩu.

.DESCRIPTION
  Chỉ dành cho tác giả, trên máy đang giữ khoá ký:
    Kho        : Cert:\CurrentUser\My (tài khoản Windows đang dùng)
    Chủ sở hữu : CN=Nguyễn Giang Minh (Jame Steven), C=VN
    Dấu vân tay: 7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED

  - Bạn chọn nơi lưu file .pfx (hộp chọn nơi lưu, hoặc tham số -TepPfx). Script không ghi đè file có sẵn và không
    lưu vào thư mục nằm trong một kho git.
  - Bạn tự gõ mật khẩu 2 lần. Mật khẩu không hiện trên màn hình, không được ghi ra đâu cả.
  - File được mã hoá AES-256 (Windows 10 bản 1709 trở lên mới khôi phục được; Windows cũ hơn: TripleDES).

  File .pfx + mật khẩu = toàn quyền ký bản cài mang tên bạn. Hãy:
    - giữ 2 bản ở 2 nơi offline (ví dụ 2 USB), mật khẩu lưu riêng (trình quản lý mật khẩu);
    - KHÔNG BAO GIỜ đưa file lên GitHub, Google Drive, OneDrive, chat hay email.
  Mất khoá mà không có bản sao lưu: phải tạo chứng chỉ mới, mọi máy nội bộ phải tin cậy lại và SanoVids phải ghim
  thêm dấu vân tay mới (xem docs/SIGNING.md).

  Khôi phục trên máy khác: scripts/signing/khoi-phuc-khoa-ky.ps1

  Mã thoát: 0 = đã sao lưu, 1 = lỗi, 2 = bạn đã huỷ.

.PARAMETER TepPfx
  Đường dẫn file .pfx sẽ tạo. Bỏ trống thì script mở hộp chọn nơi lưu.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\sao-luu-khoa-ky.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\sao-luu-khoa-ky.ps1 -TepPfx "F:\SanoVids-khoa-ky.pfx"
#>
[CmdletBinding()]
param(
  [string]$TepPfx = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ScriptPath = $PSCommandPath

$PinnedThumbprint = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
$MinPasswordLength = 12

function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }

# Pause before the window closes when this powershell.exe was started just for this script ("Run with PowerShell").
function Wait-BeforeClose {
  try {
    if ($script:ScriptPath -and [Environment]::CommandLine.IndexOf($script:ScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      [void](Read-Host 'Nhấn Enter để đóng cửa sổ')
    }
  } catch { }
}

function Format-WindowsThumbprint([string]$Thumbprint) {
  return (($Thumbprint -split '(.{8})' | Where-Object { $_ }) -join ' ')
}

function Confirm-Continue([string]$Question) {
  $answer = Read-Host ("{0} Gõ C rồi Enter để đồng ý (chỉ Enter = huỷ)" -f $Question)
  if ($null -eq $answer) { return $false }
  return @('c', 'co', 'có', 'y', 'yes') -contains $answer.Trim().ToLowerInvariant()
}

# Constant-time comparison of two SecureStrings without turning them into managed strings.
function Test-SecureStringEqual([Security.SecureString]$A, [Security.SecureString]$B) {
  if ($A.Length -ne $B.Length) { return $false }
  $pa = [IntPtr]::Zero
  $pb = [IntPtr]::Zero
  try {
    $pa = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($A)
    $pb = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($B)
    $diff = 0
    for ($i = 0; $i -lt $A.Length; $i++) {
      $diff = $diff -bor ([Runtime.InteropServices.Marshal]::ReadInt16($pa, $i * 2) -bxor [Runtime.InteropServices.Marshal]::ReadInt16($pb, $i * 2))
    }
    return ($diff -eq 0)
  } finally {
    if ($pa -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pa) }
    if ($pb -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pb) }
  }
}

function Read-NewPassword {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $first = Read-Host -AsSecureString ("Đặt mật khẩu cho file .pfx (ít nhất {0} ký tự, không hiện khi gõ)" -f $MinPasswordLength)
    if ($first.Length -lt $MinPasswordLength) {
      $first.Dispose()
      Write-Warn ("Mật khẩu quá ngắn: cần ít nhất {0} ký tự (nên dùng một câu dài dễ nhớ)." -f $MinPasswordLength)
      continue
    }
    $second = Read-Host -AsSecureString 'Gõ lại mật khẩu'
    $same = Test-SecureStringEqual $first $second
    $second.Dispose()
    if ($same) { $first.MakeReadOnly(); return $first }
    $first.Dispose()
    Write-Warn 'Hai lần gõ không khớp. Gõ lại.'
  }
  throw 'Quá 3 lần thử. Chưa tạo file nào.'
}

function Select-SavePath([string]$DefaultName) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Title = 'Chọn nơi lưu file sao lưu khoá ký SanoVids (.pfx)'
    $dialog.Filter = 'Tệp PFX (*.pfx)|*.pfx'
    $dialog.DefaultExt = 'pfx'
    $dialog.AddExtension = $true
    $dialog.OverwritePrompt = $false
    $dialog.FileName = $DefaultName
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    try { $result = $dialog.ShowDialog($owner) } finally { $owner.Dispose() }
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.FileName }
    return ''
  } catch {
    return (Read-Host 'Nhập đường dẫn file .pfx sẽ tạo (ví dụ F:\SanoVids-khoa-ky.pfx)')
  }
}

function Get-GitRoot([string]$Directory) {
  $current = $Directory
  while ($current) {
    if (Test-Path -LiteralPath (Join-Path $current '.git')) { return $current }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

function Get-CloudFolderName([string]$Path) {
  foreach ($root in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($root -and $Path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return 'OneDrive' }
  }
  foreach ($name in @('OneDrive', 'Dropbox', 'Google Drive', 'GoogleDrive', 'My Drive', 'iCloudDrive', 'iCloud Drive')) {
    if ($Path -match ('\\' + [regex]::Escape($name) + '(\\|$)')) { return $name }
  }
  return $null
}

# $true / $false when the key's export policy can be read, $null when unknown (Export-PfxCertificate then decides).
function Test-KeyExportable($Cert) {
  $key = $null
  try {
    $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Cert)
    if ($key -is [System.Security.Cryptography.RSACng]) {
      $policy = $key.Key.ExportPolicy
      $allow = [System.Security.Cryptography.CngExportPolicies]::AllowExport -bor [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
      return (($policy -band $allow) -ne 0)
    }
    if ($key -is [System.Security.Cryptography.RSACryptoServiceProvider]) { return [bool]$key.CspKeyContainerInfo.Exportable }
  } catch {
  } finally {
    if ($key) { $key.Dispose() }
  }
  return $null
}

function Invoke-Main {
  $user = '{0}\{1}' -f [Environment]::UserDomainName, [Environment]::UserName
  $cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $PinnedThumbprint } | Select-Object -First 1
  if (-not $cert) {
    throw ("Không tìm thấy chứng chỉ ký SanoVids ({0}) trong Cert:\CurrentUser\My của tài khoản {1}. Máy / tài khoản này không giữ khoá ký nên không có gì để sao lưu." -f $PinnedThumbprint, $user)
  }
  if (-not $cert.HasPrivateKey) {
    throw 'Chứng chỉ có trên máy nhưng không kèm khoá bí mật: không sao lưu được. Dùng máy đang giữ khoá ký.'
  }
  if ((Test-KeyExportable $cert) -eq $false) {
    throw 'Khoá bí mật trên máy này được đánh dấu "không cho xuất" (khoi-phuc-khoa-ky.ps1 mặc định nhập như vậy): Windows không cho sao lưu từ máy này. Khoá vẫn ký được bình thường. Muốn thêm bản sao lưu, hãy chép file .pfx đang giữ.'
  }

  Write-Host ''
  Write-Host 'Khoá ký số SanoVids trên máy này:'
  Write-Host ("  Tài khoản   : {0}" -f $user)
  Write-Host ("  Chủ sở hữu  : {0}" -f $cert.Subject)
  Write-Host ("  Dấu vân tay : {0}" -f $cert.Thumbprint)
  Write-Host ("  Hiệu lực    : {0} - {1}" -f $cert.NotBefore.ToString('dd/MM/yyyy'), $cert.NotAfter.ToString('dd/MM/yyyy'))
  Write-Host ''

  $path = $TepPfx
  if (-not $path) { $path = Select-SavePath ('SanoVids-khoa-ky-{0}.pfx' -f (Get-Date).ToString('yyyy-MM-dd')) }
  if (-not $path -or -not $path.Trim()) { Write-Host 'Đã huỷ, chưa tạo file nào.'; return 2 }
  $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path.Trim().Trim('"'))
  if (@('.pfx', '.p12') -notcontains [System.IO.Path]::GetExtension($target).ToLowerInvariant()) { $target = $target + '.pfx' }

  $directory = Split-Path -Parent $target
  if (-not $directory -or -not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw ("Thư mục không tồn tại: {0}" -f $directory)
  }
  if (Test-Path -LiteralPath $target) {
    throw ("File đã có: {0}. Script không ghi đè, hãy chọn tên khác." -f $target)
  }
  $gitRoot = Get-GitRoot $directory
  if ($gitRoot) {
    throw ("Thư mục này nằm trong kho git {0}. Không bao giờ lưu khoá ký vào kho mã nguồn: chọn USB hoặc thư mục riêng tư khác." -f $gitRoot)
  }
  $cloud = Get-CloudFolderName $target
  if ($cloud) {
    Write-Warn ("Thư mục này có vẻ được đồng bộ lên mạng ({0}). Nên lưu khoá ký ở nơi offline như USB." -f $cloud)
    if (-not (Confirm-Continue 'Vẫn lưu ở đây?')) { Write-Host 'Đã huỷ, chưa tạo file nào.'; return 2 }
  }

  Write-Host ("Sẽ tạo: {0}" -f $target)
  $password = Read-NewPassword
  # Set right after Export-PfxCertificate succeeds: only a file THIS run created is ever deleted below.
  $created = $false
  try {
    $exportArgs = @{
      Cert        = $cert
      FilePath    = $target
      Password    = $password
      ChainOption = 'EndEntityCertOnly'
      NoClobber   = $true
    }
    $encryption = 'TripleDES-SHA1 (Windows không hỗ trợ AES cho PFX)'
    if ((Get-Command Export-PfxCertificate).Parameters.ContainsKey('CryptoAlgorithmOption')) {
      $exportArgs['CryptoAlgorithmOption'] = 'AES256_SHA256'
      $encryption = 'AES-256 / SHA-256'
    }
    [void](Export-PfxCertificate @exportArgs)
    $created = $true

    # Read the file back with the same password to prove the backup is usable (nothing is imported). A file that
    # fails this check still holds the private key: it is deleted right away instead of being left on disk.
    $problem = $null
    try {
      $data = Get-PfxData -FilePath $target -Password $password
      $thumbs = @($data.EndEntityCertificates | ForEach-Object { $_.Thumbprint.ToUpperInvariant() })
      if ($thumbs -notcontains $PinnedThumbprint) { $problem = 'file vừa tạo không chứa đúng chứng chỉ ký SanoVids' }
    } catch {
      $problem = ('không mở lại được file vừa tạo: {0}' -f $_.Exception.Message)
    }
    if ($problem) {
      $removed = $false
      if ($created) {
        try { Remove-Item -LiteralPath $target -Force; $removed = -not (Test-Path -LiteralPath $target) } catch { $removed = $false }
      }
      if ($removed) { Write-Warn ("Sao lưu KHÔNG đạt ({0}). Đã xoá file vừa tạo; chạy lại script." -f $problem) }
      else { Write-Warn ("Sao lưu KHÔNG đạt ({0}) và không xoá được file vừa tạo: hãy tự xoá {1} rồi chạy lại script." -f $problem, $target) }
      return 1
    }
  } finally {
    $password.Dispose()
  }

  $file = Get-Item -LiteralPath $target
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  Write-Host ''
  Write-Ok 'Đã sao lưu khoá ký và mở lại thử thành công.'
  Write-Host ("  File        : {0} ({1:N0} byte)" -f $file.FullName, $file.Length)
  Write-Host ("  Mã hoá      : {0}" -f $encryption)
  Write-Host ("  Dấu vân tay : {0}" -f (Format-WindowsThumbprint $PinnedThumbprint))
  Write-Host ("  SHA-256 file: {0}" -f $hash)
  Write-Host '                (dùng để so các bản chép: bản chép đúng có cùng mã này)'
  Write-Host ''
  Write-Host 'Việc cần làm tiếp:'
  Write-Host '  1. Chép file sang nơi thứ hai (USB khác). Giữ 2 bản ở 2 nơi, không để trên máy làm việc.'
  Write-Host '  2. Lưu mật khẩu trong trình quản lý mật khẩu, KHÔNG để chung chỗ với file.'
  Write-Host '  3. Không đưa file lên GitHub, Google Drive, OneDrive, chat hay email.'
  Write-Host '  4. Khôi phục trên máy mới: scripts\signing\khoi-phuc-khoa-ky.ps1'
  return 0
}

$exitCode = 1
try {
  $exitCode = Invoke-Main | Select-Object -Last 1
} catch {
  Write-Host ''
  Write-Host ("LỖI: {0}" -f $_.Exception.Message) -ForegroundColor Red
  $exitCode = 1
}
Wait-BeforeClose
exit $exitCode
