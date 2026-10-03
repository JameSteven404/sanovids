#Requires -Version 5.1

<#
.SYNOPSIS
  Khôi phục khoá ký số SanoVids từ file .pfx (đã tạo bằng sao-luu-khoa-ky.ps1) vào máy này.

.DESCRIPTION
  Nhập chứng chỉ + khoá bí mật trong file .pfx vào kho Cert:\CurrentUser\My của tài khoản Windows đang dùng, rồi
  hiện dấu vân tay để bạn kiểm tra. Chứng chỉ ký SanoVids chính thức:
    Chủ sở hữu : CN=Nguyễn Giang Minh (Jame Steven), C=VN
    Dấu vân tay: 7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED

  - Bạn chọn file .pfx (hộp chọn file, hoặc tham số -TepPfx) và tự gõ mật khẩu (không hiện khi gõ, không lưu).
  - Script mở thử file trước khi nhập: sai mật khẩu thì được gõ lại (tối đa 3 lần); file chứa chứng chỉ khác thì
    script hỏi lại trước khi nhập.
  - Mặc định khoá được nhập ở dạng KHÔNG cho xuất ra: vẫn ký bình thường, nhưng một chương trình chạy bằng tài
    khoản của bạn không chép được khoá ra file bằng một lệnh. File .pfx bạn đang giữ chính là bản sao lưu.
    Chỉ khi thật sự cần tạo bản sao lưu MỚI từ máy này (sao-luu-khoa-ky.ps1), thêm -ChoPhepSaoLuuLai.
  - Khoá đã có sẵn trên máy thì script không làm gì.
  Không cần quyền quản trị. Chỉ tài khoản Windows đang dùng mới ký được bằng khoá này.

  Mã thoát: 0 = đã khôi phục (hoặc đã có sẵn), 1 = lỗi, 2 = bạn đã huỷ.

.PARAMETER TepPfx
  Đường dẫn file .pfx. Bỏ trống thì script mở hộp chọn file.

.PARAMETER ChoPhepSaoLuuLai
  Nhập khoá ở dạng cho phép xuất ra (để chạy sao-luu-khoa-ky.ps1 trên máy này về sau). Mặc định: không cho xuất.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\khoi-phuc-khoa-ky.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\khoi-phuc-khoa-ky.ps1 -TepPfx "F:\SanoVids-khoa-ky.pfx"
#>
[CmdletBinding()]
param(
  [string]$TepPfx = '',
  [switch]$ChoPhepSaoLuuLai
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ScriptPath = $PSCommandPath

$PinnedThumbprint = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'

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

function Select-OpenPath {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Chọn file sao lưu khoá ký SanoVids (.pfx)'
    $dialog.Filter = 'Tệp PFX (*.pfx;*.p12)|*.pfx;*.p12'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    try { $result = $dialog.ShowDialog($owner) } finally { $owner.Dispose() }
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.FileName }
    return ''
  } catch {
    return (Read-Host 'Nhập đường dẫn file .pfx (ví dụ F:\SanoVids-khoa-ky.pfx)')
  }
}

function Find-SigningCert {
  return Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $PinnedThumbprint } | Select-Object -First 1
}

function Show-Cert($Cert, [string]$Title) {
  Write-Host $Title
  Write-Host ("  Chủ sở hữu   : {0}" -f $Cert.Subject)
  Write-Host ("  Dấu vân tay  : {0}" -f $Cert.Thumbprint)
  Write-Host ("  Windows ghi  : {0}" -f (Format-WindowsThumbprint $Cert.Thumbprint))
  Write-Host ("  Hiệu lực     : {0} - {1}" -f $Cert.NotBefore.ToString('dd/MM/yyyy'), $Cert.NotAfter.ToString('dd/MM/yyyy'))
}

function Invoke-Main {
  $user = '{0}\{1}' -f [Environment]::UserDomainName, [Environment]::UserName
  $existing = Find-SigningCert
  if ($existing -and $existing.HasPrivateKey) {
    Write-Host ''
    Show-Cert $existing ("Khoá ký SanoVids đã có sẵn trong Cert:\CurrentUser\My của tài khoản {0}:" -f $user)
    Write-Ok 'Không cần khôi phục.'
    return 0
  }

  $path = $TepPfx
  if (-not $path) { $path = Select-OpenPath }
  if (-not $path -or -not $path.Trim()) { Write-Host 'Đã huỷ, không thay đổi gì.'; return 2 }
  $source = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path.Trim().Trim('"'))
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ("Không thấy file: {0}" -f $source) }
  Write-Host ("File: {0}" -f $source)

  # Open the file first (nothing is imported yet) to check the password and see which certificate it holds.
  $password = $null
  $data = $null
  for ($attempt = 1; $attempt -le 3 -and -not $data; $attempt++) {
    $password = Read-Host -AsSecureString 'Mật khẩu của file .pfx (không hiện khi gõ)'
    try {
      $data = Get-PfxData -FilePath $source -Password $password
    } catch {
      $password.Dispose()
      $password = $null
      Write-Warn 'Không mở được file: sai mật khẩu, file hỏng, hoặc file mã hoá AES-256 trên Windows cũ (cần Windows 10 bản 1709 trở lên).'
    }
  }
  if (-not $data) { throw 'Quá 3 lần thử. Không thay đổi gì.' }

  try {
    $certs = @($data.EndEntityCertificates)
    if ($certs.Count -eq 0) { throw 'File không chứa chứng chỉ ký nào.' }
    $thumbs = @($certs | ForEach-Object { $_.Thumbprint.ToUpperInvariant() })
    Write-Host ''
    foreach ($c in $certs) { Show-Cert $c 'Chứng chỉ trong file:' }
    Write-Host ''
    if ($thumbs -notcontains $PinnedThumbprint) {
      Write-Warn ("File này KHÔNG chứa chứng chỉ ký SanoVids chính thức ({0})." -f (Format-WindowsThumbprint $PinnedThumbprint))
      Write-Warn 'SanoVids chỉ nhận bản cập nhật ký bằng các dấu vân tay đã ghim trong app.'
      if (-not (Confirm-Continue 'Vẫn nhập chứng chỉ này vào máy?')) { Write-Host 'Đã huỷ, không thay đổi gì.'; return 2 }
    }

    # Non-exportable unless asked: the offline .pfx already is the backup, and an exportable key can be copied out by
    # any process of this user with one Export-PfxCertificate call.
    $importArgs = @{ FilePath = $source; CertStoreLocation = 'Cert:\CurrentUser\My'; Password = $password }
    if ($ChoPhepSaoLuuLai) { $importArgs['Exportable'] = $true }
    $imported = @(Import-PfxCertificate @importArgs)
  } finally {
    if ($password) { $password.Dispose() }
  }

  Write-Host ''
  $restored = Find-SigningCert
  if ($restored -and $restored.HasPrivateKey) {
    Show-Cert $restored ("Đã khôi phục vào Cert:\CurrentUser\My của tài khoản {0}:" -f $user)
    Write-Ok 'Khoá ký SanoVids đã sẵn sàng: electron-builder ký bản cài bằng dấu vân tay này.'
    if ($ChoPhepSaoLuuLai) { Write-Warn 'Khoá được nhập ở dạng CHO PHÉP xuất ra (-ChoPhepSaoLuuLai): chỉ dùng trên máy riêng của tác giả, để tạo bản sao lưu mới.' }
    else { Write-Host '  Khoá không cho xuất ra: muốn có thêm bản sao lưu, hãy chép file .pfx đang giữ (không cần máy này).' }
  } else {
    foreach ($c in $imported) {
      $fresh = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $c.Thumbprint } | Select-Object -First 1
      if ($fresh) {
        Show-Cert $fresh 'Đã nhập vào Cert:\CurrentUser\My:'
        if (-not $fresh.HasPrivateKey) { Write-Warn 'Chứng chỉ đã nhập nhưng không kèm khoá bí mật: không ký được bằng nó.' }
      }
    }
    if ($imported.Count -eq 0) { throw 'Windows không nhập được chứng chỉ nào từ file.' }
    Write-Warn 'Đây không phải khoá ký SanoVids chính thức: bản cài ký bằng nó sẽ bị SanoVids từ chối khi tự cập nhật.'
  }
  Write-Host ''
  Write-Host 'Việc cần làm tiếp:'
  Write-Host '  - Cất file .pfx về lại nơi an toàn (USB). Đừng để bản chép nào trên Desktop / Downloads của máy này.'
  Write-Host '  - Kiểm tra: npm run release:check sau khi build để chắc bản cài được ký đúng.'
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
