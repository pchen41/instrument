/* App root: state + routing */

// Phase scripts for the two long-running jobs. Named phases (not opaque spinners)
// so a user can open the live view and see exactly where the job is — and get
// honest feedback when a source/GitHub call times out and Instrument retries it.
const INV_PHASES = [
  'Pulling traces and spans',
  'Gathering recent deploys',
  'Scanning error logs',
  'Correlating signals with recent code changes',
  'Ranking candidate causes',
];
const FIX_PHASES = [
  'Reading the root-cause analysis',
  'Drafting the fix',
  'Running checks',
  'Opening the pull request',
];
// A seeded 'investigating' incident is frozen mid-flight here so the Active list
// keeps showing the live state; it sits actively correlating, the calm middle.
const SEED_INV_ACTIVE = 3;

function App() {
  const [view, setView] = React.useState('incidents');
  const [openInc, setOpenInc] = React.useState(null);     // investigation

  // Investigation lifecycle, per incident: 'new' | 'investigating' | 'complete'.
  // Investigations never start on their own — active incidents arrive as 'new'
  // and wait for a human to press Investigate. Already-resolved ones are done.
  const [invStates, setInvStates] = React.useState(() => {
    const m = {};
    window.INCIDENTS.forEach(i => { m[i.id] = i.inv0 || (i.state === 'resolved' ? 'complete' : 'new'); });
    return m;
  });
  // Live investigation progress, per incident: { note, phases:[{label,state}] }.
  // Seeded for any incident that starts mid-investigation so opening it shows the
  // same phase checklist the in-session driver produces.
  const [invProg, setInvProg] = React.useState(() => {
    const m = {};
    window.INCIDENTS.forEach(i => {
      const st = i.inv0 || (i.state === 'resolved' ? 'complete' : 'new');
      if (st === 'investigating') {
        m[i.id] = { note: null, phases: INV_PHASES.map((l, idx) => ({
          label: l, state: idx < SEED_INV_ACTIVE ? 'done' : idx === SEED_INV_ACTIVE ? 'active' : 'pending',
        })) };
      }
    });
    return m;
  });
  // Fix generation, per incident: undefined | 'generating' | 'ready' | 'merged'.
  const [fixStates, setFixStates] = React.useState(() => {
    const m = {};
    window.INCIDENTS.forEach(i => { if (i.fix0) m[i.id] = i.fix0; });
    return m;
  });
  const [fixProg, setFixProg] = React.useState({});       // inc.id -> { target, note, phases }
  const [fixDrawer, setFixDrawer] = React.useState(null); // { inc, mode:'generating'|'result' }

  // Shared phase driver: walks a list of named phases, flaking one call so the
  // retry feedback is exercised, then marks everything done and calls onDone.
  const runPhases = (labels, retryNote, setProg, getProg, key, onDone) => {
    const patch = fn => setProg(p => (p[key] ? { ...p, [key]: fn(p[key]) } : p));
    const setPhase = (idx, state, note) => patch(cur => ({
      ...cur,
      note: note !== undefined ? note : cur.note,
      phases: cur.phases.map((p, j) => j === idx ? { ...p, state } : (j < idx ? { ...p, state: 'done' } : p)),
    }));
    const flaky = Math.min(2, labels.length - 1);
    let t = 0;
    const at = (d, fn) => setTimeout(fn, (t += d));
    labels.forEach((label, idx) => {
      at(idx === 0 ? 450 : 820, () => setPhase(idx, 'active', null));
      if (idx === flaky) {
        at(950, () => setPhase(idx, 'retrying', retryNote));
        at(1350, () => setPhase(idx, 'active', null));
      }
    });
    at(900, () => {
      patch(cur => ({ ...cur, note: null, phases: cur.phases.map(p => ({ ...p, state: 'done' })) }));
      onDone();
    });
  };

  const investigate = inc => {
    const id = inc.id;
    setInvStates(s => ({ ...s, [id]: 'investigating' }));
    setInvProg(p => ({ ...p, [id]: { note: null,
      phases: INV_PHASES.map((l, i) => ({ label: l, state: i === 0 ? 'active' : 'pending' })) } }));
    runPhases(
      INV_PHASES,
      'The Datadog logs API timed out. Instrument is retrying — attempt 2 of 3.',
      setInvProg, () => invProg, id,
      () => setInvStates(s => (s[id] === 'investigating' ? { ...s, [id]: 'complete' } : s)),
    );
  };

  const generateFix = inc => {
    const id = inc.id;
    setFixStates(s => ({ ...s, [id]: 'generating' }));
    setFixProg(p => ({ ...p, [id]: { target: 'pr', note: null,
      phases: FIX_PHASES.map((l, i) => ({ label: l, state: i === 0 ? 'active' : 'pending' })) } }));
    runPhases(
      FIX_PHASES,
      'GitHub timed out while opening the pull request. Instrument is retrying — attempt 2 of 3.',
      setFixProg, () => fixProg, id,
      () => {
        setFixStates(s => (s[id] === 'generating' ? { ...s, [id]: 'ready' } : s));
        // If the live progress drawer is open on this fix, advance it to the result.
        setFixDrawer(d => (d && d.inc.id === id && d.mode === 'generating') ? { ...d, mode: 'result' } : d);
      },
    );
  };

  const openFixProgress = inc => setFixDrawer({ inc, mode: 'generating' });
  const openFixResult = inc => setFixDrawer({ inc, mode: 'result' });
  const markFixMerged = () => { const id = fixDrawer.inc.id; setFixStates(s => ({ ...s, [id]: 'merged' })); setFixDrawer(null); };

  const activeCount = window.INCIDENTS.filter(i => i.state === 'active').length;
  const recCount = window.RECOMMENDATIONS.filter(r => !r.archived).length;

  let body;
  if (view === 'incidents') {
    body = openInc
      ? <window.Investigation
          inc={openInc}
          inv={invStates[openInc.id]}
          invProg={invProg[openInc.id]}
          fixState={fixStates[openInc.id]}
          onBack={() => setOpenInc(null)}
          onGenerateFix={generateFix}
          onOpenFixProgress={openFixProgress}
          onOpenFixResult={openFixResult}
        />
      : <window.IncidentList invStates={invStates} onOpen={setOpenInc} onInvestigate={investigate} />;
  } else if (view === 'recommendations') {
    body = <window.Recommendations />;
  } else {
    body = <window.Integrations />;
  }

  const go = v => { setView(v); setOpenInc(null); };

  return (
    <div className="app">
      <window.Sidebar view={view} setView={go} activeCount={activeCount} recCount={recCount} />
      <div className="main">
        {body}
      </div>
      {fixDrawer && (
        <window.ActionDrawer
          mode={fixDrawer.mode === 'generating' ? 'generating' : 'pr'}
          title={fixDrawer.inc.fix ? fixDrawer.inc.fix.title : 'Generated fix'}
          payload={fixDrawer.inc.fix
            ? { desc: fixDrawer.inc.fix.desc, branch: fixDrawer.inc.fix.branch, number: fixDrawer.inc.fix.number }
            : null}
          gen={fixDrawer.mode === 'generating' ? fixProg[fixDrawer.inc.id] : null}
          onComplete={markFixMerged}
          onClose={() => setFixDrawer(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
