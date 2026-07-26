Option Explicit

Dim shell, fileSystem, runtimeRoot, powershell, launcher, commandLine
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
runtimeRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
launcher = fileSystem.BuildPath(runtimeRoot, "launch.ps1")
commandLine = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & launcher & """"
WScript.Quit shell.Run(commandLine, 0, True)
