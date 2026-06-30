#!/usr/bin/env bash
# spike-react-grab.sh — R1 spike. Run this FIRST against a live cmux browser
# surface to confirm the injected react-grab API shape before trusting the
# capture script. Usage: spike-react-grab.sh <surface-ref>   e.g. surface:8
set -euo pipefail
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
S="${1:?usage: spike-react-grab.sh <surface-ref>}"

echo "== 1. is __REACT_GRAB__ present, and what keys does it expose? =="
"$CMUX" browser --surface "$S" eval --script \
'JSON.stringify({present:!!window.__REACT_GRAB__,keys:Object.keys(window.__REACT_GRAB__||{}),types:Object.fromEntries(Object.keys(window.__REACT_GRAB__||{}).map(k=>[k,typeof window.__REACT_GRAB__[k]]))})'

echo
echo "== 2. getSource smoke test on <body> (dev-build => non-null source) =="
"$CMUX" browser --surface "$S" eval --script \
'(async()=>{try{const g=window.__REACT_GRAB__;if(!g||typeof g.getSource!=="function")return JSON.stringify({ok:false,reason:"no getSource"});const r=await g.getSource(document.querySelector("#root,#app,main,div")||document.body);return JSON.stringify({ok:true,sourceKeys:r?Object.keys(r):null,sample:r});}catch(e){return JSON.stringify({ok:false,error:String(e)});}})()'

echo
echo "== 3. getStackContext smoke test (column source) =="
"$CMUX" browser --surface "$S" eval --script \
'(async()=>{try{const g=window.__REACT_GRAB__;if(!g||typeof g.getStackContext!=="function")return JSON.stringify({ok:false,reason:"no getStackContext"});const s=await g.getStackContext(document.querySelector("#root,#app,main,div")||document.body);return JSON.stringify({ok:true,type:typeof s,preview:String(s).slice(0,300)});}catch(e){return JSON.stringify({ok:false,error:String(e)});}})()'

echo
echo "== 4. eval output-format probes (ground the poll case-statement, fix #4) =="
echo "-- 4a JSON.stringify(null):"
"$CMUX" browser --surface "$S" eval --script 'JSON.stringify(null)'
echo "-- 4b a bare string cancelled:"
"$CMUX" browser --surface "$S" eval --script '"cancelled"'
echo "-- 4c JSON.stringify of a string:"
"$CMUX" browser --surface "$S" eval --script 'JSON.stringify("cancelled")'
echo "-- 4d a small object via JSON.stringify:"
"$CMUX" browser --surface "$S" eval --script 'JSON.stringify({a:1,b:"x"})'
echo "-- 4e raw object (no stringify) — does cmux double-encode?:"
"$CMUX" browser --surface "$S" eval --script '({a:1,b:"x"})'
echo "   RECORD exact stdout of 4a-4e: determines whether the poll matches bare"
echo "   'cancelled' vs quoted '\"cancelled\"', and whether the blob is double-encoded."

echo
echo "== 5. ground the surface-open diff (--json is NOT supported on open) =="
echo "   Run manually and diff surface.list before/after:"
echo "     before=\$($CMUX rpc surface.list '{}')"
echo "     $CMUX open http://localhost:3000 --workspace <ws>      # no --json"
echo "     after=\$($CMUX rpc surface.list '{}')"
echo "   The new entry whose type != \"terminal\" is your surface ref S."

echo
echo "INTERPRET:"
echo "  - keys must include getSource (else: rely on fallback ladder, source will be null)."
echo "  - setOptions present  => capture upgrades to onCopySuccess hook (mode:hook)."
echo "  - setOptions absent    => capture uses its always-on click listener (mode:click)."
echo "  - #2 sample null on a known component => NOT a dev build (source info unavailable)."
echo "  - #4 gives the exact poll match tokens; #5 grounds surface-ref capture."
