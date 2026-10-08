Option Explicit
Dim ws, fso, currentDir, rootDir, helperCmd, isAutoStart, http

Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(currentDir)
ws.CurrentDirectory = rootDir

helperCmd = currentDir & "\start-helper.cmd"

isAutoStart = False
If WScript.Arguments.Count > 0 Then
    If InStr(LCase(WScript.Arguments(0)), "autostart") > 0 Then
        isAutoStart = True
    End If
End If

' Check if server is already running on port 8789
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.open "GET", "http://127.0.0.1:8789/api/status", False
http.setTimeouts 500, 500, 500, 500
http.send

If Err.Number = 0 And http.status = 200 Then
    If Not isAutoStart Then
        ws.Run "http://127.0.0.1:8789/cycle-algorithm/", 1, False
    End If
    WScript.Quit 0
End If
Err.Clear
On Error GoTo 0

' Start helper.cmd directly with hidden window (0)
On Error Resume Next
If isAutoStart Then
    ws.Run """" & helperCmd & """ autostart", 0, False
Else
    ws.Run """" & helperCmd & """", 0, False
End If
If Err.Number <> 0 Then
    WScript.Echo "Error launching helperCmd: " & Err.Number & " " & Err.Description
End If
