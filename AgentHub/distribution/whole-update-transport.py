"""Local HTTP transport for the unmodified recipient CLI, no public/TLS claim."""
import json
from pathlib import Path
import runpy
import sys
import urllib.request

control = json.loads(Path(sys.argv.pop(1)).read_text(encoding="utf-8"))
target = sys.argv.pop(1)
original = urllib.request.OpenerDirector.open

def opened(self, request, *args, **kwargs):
    url = request.full_url if hasattr(request, "full_url") else str(request)
    if url == control["metadataUrl"]:
        mapped = control["transport"] + "/metadata"
    elif url.startswith(control["assetBase"]):
        name = url[len(control["assetBase"]):]
        if name not in control["assetNames"]:
            raise ValueError("Unexpected isolated asset")
        mapped = control["transport"] + "/" + name
    else:
        raise ValueError("Unexpected isolated network URL: " + url)
    return original(self, urllib.request.Request(mapped), *args, **kwargs)

urllib.request.OpenerDirector.open = opened
sys.argv[0] = target
runpy.run_path(target, run_name="__main__")
