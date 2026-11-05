import { execFileSync } from "node:child_process";
export function fixtureAllocation(root) {
  if (process.platform !== "win32") return null;
  const script = String.raw`import ctypes as c, ctypes.wintypes as w, os, sys, json
k=c.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.GetFileInformationByHandleEx.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD]
k.CloseHandle.argtypes=[w.HANDLE]
class Standard(c.Structure):
 _fields_=[('allocation',c.c_longlong),('end',c.c_longlong),('links',w.DWORD),('deleted',w.BYTE),('directory',w.BYTE)]
rows=[];seen=set();allocated=0;logical=0
for parent,dirs,files in os.walk(sys.argv[1]):
 for name in files:
  f=os.path.join(parent,name);st=os.stat(f);key=(st.st_dev,st.st_ino);logical+=st.st_size
  h=k.CreateFileW(f,0,7,None,3,0,None)
  if h==w.HANDLE(-1).value:raise c.WinError(c.get_last_error())
  try:
   info=Standard()
   if not k.GetFileInformationByHandleEx(h,1,c.byref(info),c.sizeof(info)):raise c.WinError(c.get_last_error())
  finally:k.CloseHandle(h)
  if key not in seen:allocated+=info.allocation;seen.add(key)
  rows.append({'path':os.path.relpath(f,sys.argv[1]),'bytes':st.st_size,'allocated':info.allocation,'links':info.links,'identity':list(key)})
print(json.dumps({'logicalBytes':logical,'uniqueAllocatedBytes':allocated,'files':rows}))`;
  return JSON.parse(execFileSync("python", ["-c", script, root], { encoding: "utf8", windowsHide: true }));
}
