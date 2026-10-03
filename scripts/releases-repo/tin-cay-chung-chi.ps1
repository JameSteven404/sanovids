#Requires -Version 5.1

<#
.SYNOPSIS
  Tin cậy chứng chỉ ký số của SanoVids (tác giả Nguyễn Giang Minh (Jame Steven)) trên máy này.

.DESCRIPTION
  Bản cài SanoVids chính thức được ký số bằng chứng chỉ tự ký của tác giả:
    Chủ sở hữu : CN=Nguyễn Giang Minh (Jame Steven), C=VN
    Dấu vân tay: 7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED (SHA-1)

  Script thêm chứng chỉ đó (chỉ phần CÔNG KHAI, đã gắn sẵn trong script) vào hai kho của Windows:
    - Trusted Root Certification Authorities (Root)
    - Trusted Publishers (TrustedPublisher)
  Sau đó Windows hiện "Nhà phát hành đã xác minh: Nguyễn Giang Minh (Jame Steven)" và chữ ký trên bản cài
  ở trạng thái hợp lệ (Valid).

  - Mặc định chỉ cho tài khoản Windows đang dùng (CurrentUser). Khi thêm vào kho Root, chính Windows hiện hộp
    "Security Warning" để bạn xác nhận: so dấu vân tay (Thumbprint) với dấu vân tay ở trên rồi mới bấm Yes.
  - -TatCaNguoiDung: cho mọi tài khoản trên máy (LocalMachine). Cần mở PowerShell bằng "Run as administrator".
  - -Go: gỡ chứng chỉ này khỏi các kho trên (chỉ đúng chứng chỉ có dấu vân tay ở trên, không đụng gì khác).
  - -KiemTra: chỉ xem trạng thái, không thay đổi gì.
  Chạy lại nhiều lần vẫn an toàn: kho nào đã có thì bỏ qua.

  KHÔNG cần tin cậy chứng chỉ để dùng hay tự cập nhật SanoVids. Chỉ tin cậy khi bạn ở trong nhóm được tác giả
  cho phép và dấu vân tay khớp với trang tải về chính thức.

  Mã thoát: 0 = xong (hoặc không cần làm gì), 1 = lỗi, 2 = bạn đã huỷ / chọn No trong hộp xác nhận.

.PARAMETER TatCaNguoiDung
  Thêm / gỡ cho mọi tài khoản trên máy (LocalMachine). Cần quyền quản trị.

.PARAMETER Go
  Gỡ chứng chỉ thay vì thêm.

.PARAMETER KiemTra
  Chỉ xem chứng chỉ đang được tin cậy ở đâu. Không thay đổi gì.

.PARAMETER TepChungChi
  (Tuỳ chọn) Dùng file .cer thay cho chứng chỉ gắn sẵn trong script. File phải mang đúng dấu vân tay ở trên,
  nếu không script dừng và không thay đổi gì.

.PARAMETER KhongHoi
  Không hỏi "Tiếp tục?" và không chờ Enter ở cuối (dùng khi cài hàng loạt bằng quyền quản trị).
  Hộp xác nhận của Windows vẫn hiện khi thêm / gỡ khỏi kho Root của tài khoản đang dùng.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tin-cay-chung-chi.ps1
  Tin cậy cho tài khoản đang dùng.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tin-cay-chung-chi.ps1 -TatCaNguoiDung
  Tin cậy cho mọi tài khoản (chạy trong PowerShell mở bằng "Run as administrator").

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tin-cay-chung-chi.ps1 -Go
  Gỡ tin cậy khỏi tài khoản đang dùng.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tin-cay-chung-chi.ps1 -KiemTra
  Xem trạng thái.
#>
[CmdletBinding()]
param(
  [switch]$TatCaNguoiDung,
  [switch]$Go,
  [switch]$KiemTra,
  [string]$TepChungChi = '',
  [switch]$KhongHoi
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ScriptPath = $PSCommandPath

# Pinned identity of the SanoVids signing certificate (public part only, DER, base64). Rotating the certificate
# means a new version of this script: replace both values, build/signing/SanoVids-NguyenGiangMinh.cer and the copies
# in scripts/releases-repo/. scripts/__tests__/signingFiles.test.mjs checks that they all agree.
$PinnedThumbprint = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
$CertBase64 = @'
MIIEQjCCAqqgAwIBAgIQbG7zjq8qBL5GSiBzMyJJqDANBgkqhkiG9w0BAQsFADA5MQswCQYDVQQG
EwJWTjEqMCgGA1UEAwwhTmd1eeG7hW4gR2lhbmcgTWluaCAoSmFtZSBTdGV2ZW4pMB4XDTI2MTAw
MzAxMTU1MloXDTM2MTAwMzAxMjU1MlowOTELMAkGA1UEBhMCVk4xKjAoBgNVBAMMIU5ndXnhu4Vu
IEdpYW5nIE1pbmggKEphbWUgU3RldmVuKTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCCAYoCggGB
ALsDO+xUwcpeWkLvmOtoNVMJZL6SDJy30g6Nn5LUrstr82kLAKVqN6g7tjPMJynguueb8DRgxafB
lxujqJY5I0g+IOSkW7WKDneFJiAWww2YiXTX7WcdmXelvN4GDZQy9/keoax+/6piYTCSKdiqixTl
e4h2NdshB8ZZhoYvukQwffbUyCq3zqVADwfrmOTZTA2o52bTRcjavA1LJ/ZPqCBR0h5FnZfH5Vkc
duD3fCXKCZQJQ/gOCcxoCnHN1F3OIFg4La3MmJ0BXiSkLSllnVt/513vClJyjm/CWGaIM+L0QQfJ
FYkJJl1STaTLYpKEHxa2yTvzDxFS7+fA7A+LCgcnB07Azp+wdeNhrW1p5OTR6oD8xnmtLOdKuY31
349Fm9SRuzq1wkpf9ea8M5oMpoqQ0y8bQtiRAJyKqmMvjdNGDaVrrOqbRZuR7bvtscS1uJ31pRzl
3ywr14VAOYbglR1WP2H2Iq+UyIFwp85FQYUGvmcOntagdGeYnZmcSUPLcQIDAQABo0YwRDAOBgNV
HQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwMwHQYDVR0OBBYEFHtmXRLC0TZ2bxyMXczI
9F7SVgrtMA0GCSqGSIb3DQEBCwUAA4IBgQCSqjdoqJDry/GrwYOdGa5bgNuInY2MRuJcJmIrTRQ3
/vqhq2wB48+DxB1maeuaksU/QLP8UK8bRSrBC5efXCsf8cRn5yKe/OGDCCAeLb3XZ+xNxHl/1hqD
hsEZiuQvjYx7rPAdrFLtUrY3G1Ml0qUbk7a7IUP8Gg8DiAeDgxkWK4lO59n0hSaa8l0ZFeE5kvfF
/Wzsu0PC1/um8shZla547ztlLNb6s1BVkd9nQ1lv+qzuPWZeYTxpEx+AyCp0uPgrREqkfh/0173Q
e37G6xqhBhbUMvIYYlVWUlYQ2sO+mlQ2PycdriCY9PGe8PvmmM5UovKsICgcZP5wqQLp9S6eiY1B
RqJLuFya/9oRKf+Yp4k5zw3kkGy5QQGYub5rvpLn5pMYsNpnGUOQDsXr+e7tvkbeJwT3QlzwfPNy
1CCgF9HbwrkPjkNBBr1+oNkwG3m6BaAhDhgJsJipM+AUWIP5VjXPlAn283lB37mxYAD7yNyAQC2T
RpACgf6U9xj/ykM=
'@

# Root first: TrustedPublisher alone does not make the self-signed chain trusted, so it is only added after Root.
$StoreOrder = @('Root', 'TrustedPublisher')
$StoreLabels = @{
  Root             = 'Trusted Root Certification Authorities (Root)'
  TrustedPublisher = 'Trusted Publishers (TrustedPublisher)'
}

function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Skip([string]$Text) { Write-Host "  [--] $Text" }
function Write-Warn([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }
function Write-Hint([string]$Text) { Write-Host "       $Text" -ForegroundColor Cyan }

# Pause before the window closes, but only when this powershell.exe was started just for this script
# (Explorer "Run with PowerShell", double-click shortcuts): the script path is then on the process command line.
function Wait-BeforeClose {
  if ($KhongHoi) { return }
  try {
    if ($script:ScriptPath -and [Environment]::CommandLine.IndexOf($script:ScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      [void](Read-Host 'Nhấn Enter để đóng cửa sổ')
    }
  } catch { }
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Format-WindowsThumbprint([string]$Thumbprint) {
  # The Windows "Security Warning" dialog prints the SHA-1 thumbprint in groups of 8.
  return (($Thumbprint -split '(.{8})' | Where-Object { $_ }) -join ' ')
}

# Physical presence, read from where Windows keeps each system store. The logical CurrentUser stores also show the
# LocalMachine certificates, so X509Store alone cannot tell who installed what.
function Test-InStore([string]$Location, [string]$StoreName) {
  if ($Location -eq 'CurrentUser') {
    $paths = @(
      "HKCU:\Software\Microsoft\SystemCertificates\$StoreName\Certificates\$PinnedThumbprint",
      (Join-Path $env:APPDATA "Microsoft\SystemCertificates\$StoreName\Certificates\$PinnedThumbprint")
    )
  } else {
    $paths = @("HKLM:\SOFTWARE\Microsoft\SystemCertificates\$StoreName\Certificates\$PinnedThumbprint")
  }
  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { return $true } }
  return $false
}

# Certificates pushed by Group Policy / enterprise stores (cannot be changed by this script).
function Test-InManagedStore([string]$StoreName) {
  $paths = @(
    "HKLM:\SOFTWARE\Policies\Microsoft\SystemCertificates\$StoreName\Certificates\$PinnedThumbprint",
    "HKCU:\Software\Policies\Microsoft\SystemCertificates\$StoreName\Certificates\$PinnedThumbprint",
    "HKLM:\SOFTWARE\Microsoft\EnterpriseCertificates\$StoreName\Certificates\$PinnedThumbprint"
  )
  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { return $true } }
  return $false
}

function Get-SanoVidsCertificate {
  if ($TepChungChi) {
    $full = (Resolve-Path -LiteralPath $TepChungChi).ProviderPath
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $source = $full
  } else {
    $bytes = [Convert]::FromBase64String(($CertBase64 -replace '\s', ''))
    $source = 'gắn sẵn trong script'
  }
  # Refuse anything that is not a plain public certificate before parsing it (a .pfx would carry a private key).
  $type = [System.Security.Cryptography.X509Certificates.X509Certificate2]::GetCertContentType([byte[]]$bytes)
  if ($type -ne [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert) {
    throw "File không phải chứng chỉ công khai (.cer) mà là: $type. Không dùng file này."
  }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, [byte[]]$bytes)
  if ($cert.Thumbprint.ToUpperInvariant() -cne $PinnedThumbprint) {
    throw ("Dấu vân tay của chứng chỉ ({0}) KHÁC dấu vân tay chính thức của SanoVids ({1}). Không tin cậy chứng chỉ này." -f $cert.Thumbprint, $PinnedThumbprint)
  }
  return @{ Cert = $cert; Source = $source }
}

function Show-Certificate($Cert, [string]$Source) {
  Write-Host ''
  Write-Host ("Chứng chỉ ký số SanoVids (nguồn: {0})" -f $Source)
  Write-Host ("  Chủ sở hữu      : {0}" -f $Cert.Subject)
  Write-Host ("  Dấu vân tay     : {0}" -f $Cert.Thumbprint)
  Write-Host ("  Windows hiển thị: {0}" -f (Format-WindowsThumbprint $Cert.Thumbprint))
  Write-Host ("  Hiệu lực        : {0} - {1}" -f $Cert.NotBefore.ToString('dd/MM/yyyy'), $Cert.NotAfter.ToString('dd/MM/yyyy'))
  if ($Cert.NotAfter -lt (Get-Date)) {
    Write-Warn 'Chứng chỉ đã hết hạn. Bản cài ký trước ngày hết hạn (có dấu thời gian) vẫn hợp lệ; bản mới sẽ dùng chứng chỉ mới.'
  }
  Write-Host ''
}

function Show-Status($Cert) {
  Write-Host 'Trạng thái trên máy này:'
  foreach ($name in $StoreOrder) {
    $label = $StoreLabels[$name]
    $where = @()
    if (Test-InStore 'CurrentUser' $name) { $where += 'tài khoản đang dùng (CurrentUser)' }
    if (Test-InStore 'LocalMachine' $name) { $where += 'mọi người dùng (LocalMachine)' }
    if (Test-InManagedStore $name) { $where += 'Group Policy / doanh nghiệp' }
    if ($where.Count -gt 0) { Write-Ok ("{0}: có - {1}" -f $label, ($where -join ', ')) }
    else { Write-Skip ("{0}: chưa có" -f $label) }
  }
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $trusted = $chain.Build($Cert)
  $chain.Reset()
  if ($trusted) { Write-Ok 'Windows tin cậy chứng chỉ này: chữ ký trên bản cài SanoVids hiện là hợp lệ (Valid).' }
  else { Write-Skip 'Windows chưa tin cậy chứng chỉ này (bình thường nếu chưa chạy script; SanoVids vẫn dùng và tự cập nhật được).' }
}

function Add-ToStore([string]$Location, [string]$StoreName, $Cert) {
  $label = $StoreLabels[$StoreName]
  if (Test-InStore $Location $StoreName) { Write-Skip ("{0}: đã có - bỏ qua." -f $label); return $true }
  if ($Location -eq 'CurrentUser' -and (Test-InStore 'LocalMachine' $StoreName)) {
    Write-Skip ("{0}: đã được tin cậy cho mọi người dùng (LocalMachine) - bỏ qua." -f $label); return $true
  }
  if (Test-InManagedStore $StoreName) { Write-Skip ("{0}: đã được tin cậy qua Group Policy - bỏ qua." -f $label); return $true }
  if ($Location -eq 'CurrentUser' -and $StoreName -eq 'Root') {
    Write-Hint 'Windows sắp hiện hộp "Security Warning". So dòng Thumbprint với "Windows hiển thị" ở trên:'
    Write-Hint 'khớp thì bấm Yes, khác thì bấm No.'
  }
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $StoreName, ([System.Security.Cryptography.X509Certificates.StoreLocation]$Location)
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($Cert)
  } catch {
    # "No" in the Windows dialog or access denied: the re-check below reports the real state either way.
    Write-Host ("       ({0})" -f $_.Exception.Message) -ForegroundColor DarkGray
  } finally {
    $store.Close()
  }
  if (Test-InStore $Location $StoreName) { Write-Ok ("{0}: đã thêm." -f $label); return $true }
  Write-Warn ("{0}: CHƯA thêm (bạn đã chọn No, hoặc Windows không cho phép)." -f $label)
  return $false
}

function Remove-FromStore([string]$Location, [string]$StoreName) {
  $label = $StoreLabels[$StoreName]
  if ($Location -eq 'CurrentUser' -and (Test-InStore 'LocalMachine' $StoreName)) {
    # The CurrentUser view also lists the LocalMachine copy; never risk deleting that one from here.
    Write-Warn ("{0}: chứng chỉ được cài cho mọi người dùng. Gỡ phần đó trước bằng PowerShell quản trị: -Go -TatCaNguoiDung." -f $label)
    return $false
  }
  if (-not (Test-InStore $Location $StoreName)) {
    if (Test-InManagedStore $StoreName) { Write-Warn ("{0}: do Group Policy cài - script không gỡ được, hỏi quản trị mạng." -f $label) }
    else { Write-Skip ("{0}: không có - bỏ qua." -f $label) }
    return $true
  }
  if ($Location -eq 'CurrentUser' -and $StoreName -eq 'Root') {
    Write-Hint 'Windows sắp hỏi có xoá chứng chỉ khỏi kho Root không: bấm Yes để gỡ.'
  }
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $StoreName, ([System.Security.Cryptography.X509Certificates.StoreLocation]$Location)
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $PinnedThumbprint, $false)
    foreach ($c in $found) {
      if ($c.Thumbprint.ToUpperInvariant() -cne $PinnedThumbprint) { continue }
      try { $store.Remove($c) } catch { Write-Host ("       ({0})" -f $_.Exception.Message) -ForegroundColor DarkGray }
    }
  } finally {
    $store.Close()
  }
  if (-not (Test-InStore $Location $StoreName)) { Write-Ok ("{0}: đã gỡ." -f $label); return $true }
  Write-Warn ("{0}: CHƯA gỡ (bạn đã chọn No, hoặc Windows không cho phép)." -f $label)
  return $false
}

function Confirm-Continue([string]$Question) {
  if ($KhongHoi) { return $true }
  $answer = Read-Host ("{0} Gõ C rồi Enter để đồng ý (chỉ Enter = huỷ)" -f $Question)
  if ($null -eq $answer) { return $false }
  return @('c', 'co', 'có', 'y', 'yes') -contains $answer.Trim().ToLowerInvariant()
}

function Invoke-Main {
  if ($Go -and $KiemTra) { throw 'Chỉ dùng một trong hai: -Go hoặc -KiemTra.' }

  $loaded = Get-SanoVidsCertificate
  $cert = $loaded.Cert
  Show-Certificate $cert $loaded.Source

  if ($KiemTra) { Show-Status $cert; return 0 }

  if ($TatCaNguoiDung) {
    $location = 'LocalMachine'
    if (-not (Test-IsAdmin)) {
      throw 'Cần quyền quản trị: mở PowerShell bằng "Run as administrator" rồi chạy lại lệnh với -TatCaNguoiDung.'
    }
    $scopeText = 'mọi người dùng trên máy này (LocalMachine)'
  } else {
    $location = 'CurrentUser'
    $scopeText = ('tài khoản {0}\{1} (CurrentUser)' -f [Environment]::UserDomainName, [Environment]::UserName)
    if (Test-IsAdmin) {
      Write-Hint 'Đang chạy bằng quyền quản trị: thay đổi chỉ áp dụng cho tài khoản ở dưới. Muốn áp dụng cho mọi người dùng, thêm -TatCaNguoiDung.'
    }
  }

  if ($Go) {
    if (-not (Confirm-Continue ("Sắp GỠ chứng chỉ trên khỏi kho Root và TrustedPublisher của {0}." -f $scopeText))) {
      Write-Host 'Đã huỷ, không thay đổi gì.'; return 2
    }
    $ok = $true
    # Reverse order: TrustedPublisher first, Root last.
    foreach ($name in @('TrustedPublisher', 'Root')) { if (-not (Remove-FromStore $location $name)) { $ok = $false } }
    Write-Host ''
    if ($ok) { Write-Host 'Xong: Windows không còn tin cậy chứng chỉ SanoVids ở phạm vi này.' -ForegroundColor Green; return 0 }
    Write-Host 'Chưa gỡ hết. Xem các dòng [!] ở trên.' -ForegroundColor Yellow
    return 2
  }

  Write-Host ("Sắp THÊM chứng chỉ trên vào kho Root và TrustedPublisher của {0}." -f $scopeText)
  Write-Host 'Chỉ làm việc này nếu bạn ở trong nhóm được tác giả cho phép và dấu vân tay khớp với trang tải về chính thức.'
  if (-not (Confirm-Continue 'Tiếp tục?')) { Write-Host 'Đã huỷ, không thay đổi gì.'; return 2 }

  if (-not (Add-ToStore $location 'Root' $cert)) {
    Write-Host ''
    Write-Host 'Chưa tin cậy: không thêm được vào kho Root nên cũng không thêm vào TrustedPublisher. Chạy lại khi sẵn sàng.' -ForegroundColor Yellow
    return 2
  }
  if (-not (Add-ToStore $location 'TrustedPublisher' $cert)) {
    Write-Host ''
    Write-Host 'Đã tin cậy ở kho Root nhưng chưa thêm được vào TrustedPublisher. Chạy lại script để thử tiếp.' -ForegroundColor Yellow
    return 2
  }
  Write-Host ''
  Write-Host 'Xong: Windows đã tin cậy chứng chỉ ký số SanoVids. Bỏ tin cậy: chạy lại script với -Go.' -ForegroundColor Green
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
