"""Native ancestor movement / junction substitution with candidate root handle."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
spec=importlib.util.spec_from_file_location('candidate_model_download',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert module.IS_WINDOWS
safe=lambda error:{'type':type(error).__name__,'errno':getattr(error,'errno',None),'winerror':getattr(error,'winerror',None)}
results={}
with tempfile.TemporaryDirectory(prefix='voice-containment-') as temporary:
    root=Path(temporary);engine=root/'engine-v1';model=engine/'models/asr';model.mkdir(parents=True)
    outside=root/'outside';(outside/'models/asr').mkdir(parents=True);sentinel=outside/'keep.bin';sentinel.write_bytes(b'UNCHANGED')
    nested=model/'nested-junction';mk=subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(nested),str(outside)],capture_output=True)
    assert mk.returncode==0,'Native junction fixture creation failed'
    files=None;ancestor_junction=False;ancestor_moved=False;moved=root/'moved-engine'
    try:
        files=module._Files(model,'domestic');results['heldHandles']=len(files.windows.handles)
        try:
            with files.open('nested-junction/escape.bin',True) as stream:stream.write(b'FORBIDDEN')
            results['nestedJunctionRejected']=False
        except OSError as error:results['nestedJunctionRejected']=True;results['nestedJunctionError']=safe(error)
        except module.ModelDownloadError as error:results['nestedJunctionRejected']=True;results['nestedJunctionError']={'code':error.code}
        try:
            os.rename(model,model.with_name('renamed-root'));results['modelRootRenameDenied']=False
        except OSError as error:results['modelRootRenameDenied']=True;results['modelRootRenameError']=safe(error)
        assert results['modelRootRenameDenied']
        try:
            os.rename(engine,moved);ancestor_moved=True;results['ancestorRename']='succeeded'
        except OSError as error:results['ancestorRename']='denied';results['ancestorRenameError']=safe(error)
        if ancestor_moved:
            junction=subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(engine),str(outside)],capture_output=True)
            assert junction.returncode==0,'Ancestor substitution fixture failed';ancestor_junction=True
        with files.open('anchored.bin',True) as stream:stream.write(b'ORIGINAL_ROOT_ONLY')
        actual=(moved if ancestor_moved else engine)/'models/asr/anchored.bin'
        results['writeRemainedAnchored']=actual.read_bytes()==b'ORIGINAL_ROOT_ONLY'
        results['outsideUnchanged']=sentinel.read_bytes()==b'UNCHANGED' and not (outside/'escape.bin').exists() and not (outside/'models/asr/anchored.bin').exists()
    finally:
        if files is not None:files.close()
        if ancestor_junction:os.rmdir(engine)
        os.rmdir((moved if ancestor_moved else engine)/'models/asr/nested-junction')
results['passed']=results['heldHandles']==1 and results['nestedJunctionRejected'] and results['modelRootRenameDenied'] and results['writeRemainedAnchored'] and results['outsideUnchanged']
print('ANCESTOR_CONTAINMENT_JSON\n'+json.dumps(results,indent=2))
raise SystemExit(0 if results['passed'] else 1)
