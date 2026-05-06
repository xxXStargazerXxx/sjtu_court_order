$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$profile = Join-Path $PSScriptRoot "edge-sjtu-profile"
$url = "https://sports.sjtu.edu.cn/pc/#/apointmentDetails/1/9096787a-bc53-430a-9405-57dc46bc9e83/%25E5%2585%25A8%25E9%2583%25A8/0"

New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profile",
  "--no-first-run",
  $url
)
