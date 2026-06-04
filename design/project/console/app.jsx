/* App root: state + routing */

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
  // Fix generation, per incident: undefined | 'generating'.
  const [fixStates, setFixStates] = React.useState(() => {
    const m = {};
    window.INCIDENTS.forEach(i => { if (i.fix0) m[i.id] = i.fix0; });
    return m;
  });

  const investigate = inc => {
    setInvStates(s => ({ ...s, [inc.id]: 'investigating' }));
    setTimeout(() => setInvStates(s => (s[inc.id] === 'investigating' ? { ...s, [inc.id]: 'complete' } : s)), 2600);
  };
  const generateFix = inc => setFixStates(s => ({ ...s, [inc.id]: 'generating' }));

  const activeCount = window.INCIDENTS.filter(i => i.state === 'active').length;
  const recCount = window.RECOMMENDATIONS.filter(r => !r.archived).length;

  let body;
  if (view === 'incidents') {
    body = openInc
      ? <window.Investigation inc={openInc} inv={invStates[openInc.id]} fixState={fixStates[openInc.id]} onBack={() => setOpenInc(null)} onGenerateFix={generateFix} />
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
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
