"""Synthetic progress, but actual downloader directory ownership and cleanup."""
import importlib.util
import json
from pathlib import Path
import sys
import time
spec=importlib.util.spec_from_file_location('active_model_download',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
files=module._Files(Path(sys.argv[2]),'domestic')
try:
    print('ACTUAL_DOWNLOADER_CONTEXT_HELD',file=sys.stderr,flush=True)
    for phase,seconds in [('connecting',1),('downloading',3.5),('validating',0.2)]:
        print(json.dumps({'type':'model_progress','kind':'asr','phase':phase,'source':'domestic'}),flush=True)
        time.sleep(seconds)
finally:
    files.close()
print('ACTUAL_DOWNLOADER_CONTEXT_RELEASED',file=sys.stderr,flush=True)
