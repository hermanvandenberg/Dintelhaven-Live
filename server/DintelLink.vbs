' Auteur: HvdB
' DintelLink openen op de laptop, zonder zwart venster.
' Draait de server nog niet, dan start deze hem onzichtbaar op de achtergrond
' en opent daarna de app. Met /achtergrond alleen de server (automatisch
' starten met Windows). Uitzetten doe je in DintelLink zelf: tik linksonder.
Option Explicit
Dim sh, fso, map, wortel, url, achtergrond, i

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
map = fso.GetParentFolderName(WScript.ScriptFullName)
wortel = fso.GetParentFolderName(map)
url = "http://localhost:8080/"
achtergrond = False
If WScript.Arguments.Count > 0 Then achtergrond = (LCase(WScript.Arguments(0)) = "/achtergrond")

Function Draait()
  Dim http, st
  Draait = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", url & "sync/status", False
  http.send
  If Err.Number = 0 Then
    st = http.status
    If Err.Number = 0 Then Draait = (st = 200 Or st = 401)
  End If
  Err.Clear
  On Error GoTo 0
End Function

If Not Draait() Then
  If sh.Run("cmd /c where node", 0, True) <> 0 Then
    If Not achtergrond Then MsgBox "Node.js is niet gevonden op deze laptop." & vbCrLf & vbCrLf & _
      "Installeer de LTS-versie van https://nodejs.org/ en open DintelLink opnieuw.", vbExclamation, "DintelLink"
    WScript.Quit 1
  End If
  sh.CurrentDirectory = wortel
  sh.Run "node """ & map & "\dintellink-server.js"" --bewaker", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If Draait() Then Exit For
  Next
  If Not Draait() Then
    If Not achtergrond Then MsgBox "De DintelLink-server start niet." & vbCrLf & vbCrLf & _
      "Kijk in server-data\server.log, of start server\Start DintelLink-server.bat om de melding te zien.", vbExclamation, "DintelLink"
    WScript.Quit 1
  End If
End If

If Not achtergrond Then
  ' Als eigen venster (Edge-app), anders gewoon in de standaardbrowser.
  On Error Resume Next
  sh.Run "msedge --app=" & url, 1, False
  If Err.Number <> 0 Then
    Err.Clear
    sh.Run url, 1, False
  End If
End If
