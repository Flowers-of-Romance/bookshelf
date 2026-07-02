# WSL2 (NAT モード) の bookshelf にスマホからアクセスできるようにする
# 管理者 PowerShell で実行してください。WSL の IP は再起動で変わるので、変わったら再実行。
$wslIp = (wsl hostname -I).Trim().Split(' ')[0]
netsh interface portproxy delete v4tov4 listenport=8443 listenaddress=0.0.0.0 2>$null
netsh interface portproxy add v4tov4 listenport=8443 listenaddress=0.0.0.0 connectport=8443 connectaddress=$wslIp
New-NetFirewallRule -DisplayName "bookshelf 8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-Host "OK: https://$((Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notmatch 'Loopback|vEthernet' -and $_.IPAddress -notmatch '^169'} | Select-Object -First 1).IPAddress):8443 -> WSL $wslIp"
