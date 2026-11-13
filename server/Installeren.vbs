' Auteur: HvdB
' Eenmalig: zet een DintelLink-icoon op het bureaublad en laat de server
' automatisch (onzichtbaar) starten als je je aanmeldt bij Windows.
' Automatisch starten zet je later aan of uit in DintelLink zelf (linksonder).
Option Explicit
Dim sh, fso, map, lnk, opstart, f

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
map = fso.GetParentFolderName(WScript.ScriptFullName)

Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\DintelLink.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & map & "\DintelLink.vbs"""
lnk.WorkingDirectory = map
lnk.IconLocation = map & "\dintellink.ico"
lnk.Description = "DintelLink openen (start de server als dat nodig is)"
lnk.Save

' Zelfde inhoud als zetAutostart() in dintellink-server.js.
opstart = sh.SpecialFolders("Startup") & "\DintelLink-server.vbs"
Set f = fso.CreateTextFile(opstart, True)
f.WriteLine "' DintelLink-server bij het aanmelden starten (aan/uit in DintelLink)"
f.WriteLine "CreateObject(""WScript.Shell"").Run ""wscript.exe """"" & map & "\DintelLink.vbs"""" /achtergrond"", 0, False"
f.Close

If MsgBox("DintelLink staat op het bureaublad en start voortaan vanzelf met Windows." & vbCrLf & vbCrLf & _
  "Nu openen?", vbYesNo + vbInformation, "DintelLink") = vbYes Then
  sh.Run "wscript.exe """ & map & "\DintelLink.vbs""", 1, False
End If
